#!/usr/bin/env node
'use strict';
// aurenctl: wallet and chain CLI.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { RpcClient, Wallet, saveKey, loadKey, loadKeyFile, listKeys, keystoreDir } = require('../src/client');
const { Keypair } = require('../src/crypto');
const { pubToAddress, isValidAddress } = require('../src/address');
const { parseAur, formatAur, canon } = require('../src/util');
const { signTx, signingBytes, TYPES } = require('../src/tx');

const ROOT = path.join(__dirname, '..');
const NETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'networks', 'networks.json'), 'utf8'));

const USAGE = `aurenctl: AUREN wallet & chain CLI

Global flags: --network <devnet|testnet|mainnet> | --rpc <url>   --from <key name>   --simulate   --no-wait   --tip <AUR>

Keys        keys new <name> | keys import <name> --seed <hex> | keys list | keys show <name> | keys export <name>
Chain       status | block [height] | validators | fees | params | tx <hash> | balance <addr|key|name.aur> | account <addr>
Transfers   send <to> <amount>
Staking     delegate <validator> <amount> | undelegate <validator> <amount> | claim <validator>
Validators  validator create --cons-pub <hex> --moniker <s> --commission <pct> --amount <AUR> | validator unjail
            gentx --cons-pub <hex> --moniker <s> --commission <pct> --amount <AUR> --chain-id <id>
TLDs        tld list | tld show <tld> | tld register <tld> [--price AUR/yr] [--share pct] [--closed] | tld policy <tld> ... | tld transfer <tld> <addr>
Names       domain register <name> [--years N] | resolve <name> | target <name> <addr> | transfer <name> <addr> | record <name> <key> <value> | primary <name>
Security    security set --guardians a,b --threshold N --delay-blocks N --daily-limit <AUR|none>
            security cancel [account] | recovery approve <account> <new-pub-hex> | recovery cancel
Contracts   evm deploy --data <hex|@file> | evm send <0xaddr> --data <hex> [--value AUR] | evm call <0xaddr> --data <hex> | evm code <0xaddr>
Governance  gov list | gov vote <id> <yes|no|abstain|veto> | gov propose --title T --description D --set param=value [--set ...]
Faucet      faucet <addr> [--faucet-url url]

Amounts are in AUR (up to 9 decimals). Passwords are read from AUREN_PASSWORD or prompted.`;

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

async function ask(question, hidden) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((r) => rl.once('line', (l) => { rl.close(); r(l); }));
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) { rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }; }
  return new Promise((r) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); r(a); }));
}
const password = async (q = 'Keystore password: ') => process.env.AUREN_PASSWORD ?? ask(q, true);
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const need = (v, what) => { if (v === undefined || v === true) throw new Error(`missing ${what}`); return v; };

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, sub] = pos;
  if (!cmd || cmd === 'help' || flags.help) return out(USAGE);

  // ---- keys (offline) ----
  if (cmd === 'keys') {
    if (sub === 'list') return out(listKeys());
    if (sub === 'new' || sub === 'import') {
      const name = need(pos[2], 'key name');
      const kp = sub === 'new' ? Keypair.generate() : Keypair.fromSeedHex(need(flags.seed, '--seed'));
      const pw = await password('New keystore password: ');
      if (!pw || pw.length < 8) throw new Error('password must be at least 8 characters');
      const file = saveKey(name, kp, pw);
      out({ name, publicKey: kp.pub, keystore: file, note: 'addresses are shown per network, e.g. "aurenctl balance ' + name + ' --network devnet"' });
      return;
    }
    if (sub === 'show') { const k = loadKeyFile(need(pos[2], 'key name')); return out({ name: k.name, publicKey: k.pub, addresses: Object.fromEntries(Object.entries(NETS).map(([n, m]) => [n, pubToAddress(k.pub, m.addressPrefix)])) }); }
    if (sub === 'export') {
      const name = need(pos[2], 'key name');
      console.error('WARNING: anyone with this seed controls your funds.');
      return out(loadKey(name, await password()).seedHex);
    }
    throw new Error('keys: new | import | list | show | export');
  }

  // ---- offline helper: gentx needs no node ----
  if (cmd === 'gentx') {
    const net = flags.network;
    const prefix = net ? NETS[net].addressPrefix : need(flags.prefix, '--network or --prefix');
    const name = need(flags.from, '--from');
    const kp = loadKey(name, await password());
    const body = {
      operator: pubToAddress(kp.pub, prefix), consPub: need(flags['cons-pub'], '--cons-pub'), moniker: need(flags.moniker, '--moniker'),
      commissionBps: Math.round(Number(need(flags.commission, '--commission (percent)')) * 100), selfStake: parseAur(need(flags.amount, '--amount')).toString(),
      chainId: need(flags['chain-id'] || (net && NETS[net].chainId), '--chain-id'),
    };
    const sig = kp.sign(Buffer.concat([Buffer.from('AUREN/gentx/v1\0'), Buffer.from(canon(body))]));
    return out({ ...body, pub: kp.pub, sig });
  }

  // ---- everything below talks to a node ----
  const netMeta = flags.network ? NETS[flags.network] : null;
  if (flags.network && !netMeta) throw new Error(`unknown network ${flags.network}`);
  const rpcUrl = flags.rpc || process.env.AUREN_RPC || (netMeta && netMeta.rpc[0]) || 'http://127.0.0.1:9650';
  const rpc = new RpcClient(rpcUrl);
  const status = await rpc.status().catch((e) => { throw new Error(`cannot reach ${rpcUrl}: ${e.message}`); });
  if (netMeta && status.chainId !== netMeta.chainId) throw new Error(`refusing to continue: node at ${rpcUrl} is chain ${status.chainId}, expected ${netMeta.chainId}`);
  const prefix = status.addressPrefix;

  const resolveAddr = async (x) => {
    if (isValidAddress(x, prefix)) return x;
    if (/\.aur$/.test(x)) { const d = await rpc.resolveDomain(x); if (!d) throw new Error(`${x} is not registered`); return d.target; }
    if (listKeys().includes(x)) return pubToAddress(loadKeyFile(x).pub, prefix);
    throw new Error(`"${x}" is not a valid ${prefix} address, .aur name or key name`);
  };
  const wallet = async () => new Wallet(loadKey(need(flags.from, '--from <key name>'), await password()), prefix);
  const tip = flags.tip ? parseAur(flags.tip) : 1000n;

  const tx = async (type, body) => {
    const w = await wallet();
    if (flags.simulate) {
      const t = await w.build(rpc, type, body, { tip, status });
      const sim = await rpc.simulate(t);
      return out({ simulated: true, from: w.address, ...sim, feeAUR: formatAur(sim.fee) });
    }
    const res = await w.send(rpc, type, body, { tip, status, wait: flags['no-wait'] ? false : true });
    out({ from: w.address, ...res, ok: res.receipt ? res.receipt.status === 1 : undefined, fee: res.receipt && formatAur(res.receipt.fee) + ' AUR' });
    if (res.receipt && res.receipt.status === 0) process.exitCode = 2;
  };

  switch (cmd) {
    case 'status': return out(status);
    case 'block': return out(await rpc.call('aur_getBlock', [pos[1] ?? 'latest']));
    case 'validators': return out(await rpc.call('aur_getValidators'));
    case 'fees': return out(await rpc.feeQuote());
    case 'params': return out(await rpc.call('aur_getParams'));
    case 'tx': return out(await rpc.getTx(need(pos[1], 'tx hash')));
    case 'account': return out(await rpc.account(await resolveAddr(need(pos[1], 'address'))));
    case 'balance': {
      const a = await rpc.account(await resolveAddr(need(pos[1], 'address or key')));
      return out({ address: a.address, balance: formatAur(a.balance) + ' AUR', spendable: formatAur(a.spendable) + ' AUR', nonce: a.nonce });
    }
    case 'send': return tx('transfer', { to: await resolveAddr(need(pos[1], 'recipient')), amount: parseAur(need(pos[2], 'amount')).toString() });
    case 'delegate': return tx('delegate', { validator: await resolveAddr(need(pos[1], 'validator')), amount: parseAur(need(pos[2], 'amount')).toString() });
    case 'undelegate': return tx('undelegate', { validator: await resolveAddr(need(pos[1], 'validator')), amount: parseAur(need(pos[2], 'amount')).toString() });
    case 'claim': return tx('claim', { validator: await resolveAddr(need(pos[1], 'validator')) });
    case 'validator':
      if (sub === 'create') return tx('createValidator', { consPub: need(flags['cons-pub'], '--cons-pub'), moniker: need(flags.moniker, '--moniker'), commissionBps: Math.round(Number(need(flags.commission, '--commission')) * 100), amount: parseAur(need(flags.amount, '--amount')).toString() });
      if (sub === 'unjail') return tx('unjail', {});
      throw new Error('validator: create | unjail');
    case 'tld': {
      const t = (s) => String(need(s, 'TLD')).toLowerCase().replace(/^\./, '');
      const policy = () => ({ open: !flags.closed, price: parseAur(flags.price || '0').toString(), ownerShareBps: Math.round(Number(flags.share ?? 80) * 100) });
      if (sub === 'list' || !sub) return out(await rpc.call('aur_getTlds'));
      if (sub === 'show') return out(await rpc.call('aur_getTld', [t(pos[2])]));
      if (sub === 'register') return tx('registerTld', { tld: t(pos[2]), ...policy() });
      if (sub === 'policy') return tx('setTldPolicy', { tld: t(pos[2]), ...policy() });
      if (sub === 'transfer') return tx('transferTld', { tld: t(pos[2]), newOwner: await resolveAddr(need(pos[3], 'new owner')) });
      throw new Error('tld: list | show <tld> | register <tld> [--price AUR/yr] [--share pct] [--closed] | policy <tld> [--price] [--share] [--closed] | transfer <tld> <addr>');
    }
    case 'domain':
      if (sub === 'register') return tx('registerDomain', { name: need(pos[2], 'name').replace(/\.aur$/, ''), years: Number(flags.years || 1) });
      if (sub === 'resolve') return out(await rpc.resolveDomain(need(pos[2], 'name')));
      if (sub === 'set-target') return tx('setDomainTarget', { name: need(pos[2], 'name').replace(/\.aur$/, ''), target: await resolveAddr(need(pos[3], 'target')) });
      if (sub === 'target') return tx('setDomainTarget', { name: need(pos[2], 'name').replace(/\.aur$/, ''), target: await resolveAddr(need(pos[3], 'target')) });
      if (sub === 'transfer') return tx('transferDomain', { name: need(pos[2], 'name').replace(/\.aur$/, ''), newOwner: await resolveAddr(need(pos[3], 'new owner')) });
      if (sub === 'record') return tx('setRecord', { name: need(pos[2], 'name').replace(/\.aur$/, ''), key: need(pos[3], 'key'), value: pos[4] === undefined || pos[4] === 'none' ? null : String(pos[4]) });
      if (sub === 'primary') return tx('setPrimary', { name: pos[2] && pos[2] !== 'none' ? pos[2].replace(/\.aur$/, '') : null });
      throw new Error('domain: register <name> [--years N] | resolve <name> | set-target|target <name> <addr> | transfer <name> <addr> | record <name> <key> <value|none> | primary <name|none>');
    case 'security':
      if (sub === 'set') {
        const guardians = flags.guardians ? await Promise.all(String(flags.guardians).split(',').map(resolveAddr)) : [];
        return tx('setSecurity', {
          guardians, threshold: Number(flags.threshold ?? (guardians.length ? 1 : 0)), delayBlocks: Number(need(flags['delay-blocks'], '--delay-blocks')),
          dailyLimit: !flags['daily-limit'] || flags['daily-limit'] === 'none' ? null : parseAur(flags['daily-limit']).toString(),
        });
      }
      if (sub === 'cancel') { const w = await wallet(); return tx('securityCancel', { account: pos[2] ? await resolveAddr(pos[2]) : w.address }); }
      throw new Error('security: set | cancel');
    case 'recovery':
      if (sub === 'approve') return tx('recoveryApprove', { account: await resolveAddr(need(pos[2], 'account')), newPub: need(pos[3], 'new public key') });
      if (sub === 'cancel') return tx('recoveryCancel', {});
      throw new Error('recovery: approve | cancel');
    case 'evm': {
      const { hexOf, WEI } = require('../src/evm/host');
      const readData = (s) => { if (!s || s === true) return ''; const t = String(s); const v = t.startsWith('@') ? fs.readFileSync(t.slice(1), 'utf8').trim() : t; return v.replace(/^0x/, '').toLowerCase(); };
      const toHex = (a) => { const h = String(a).toLowerCase().replace(/^0x/, ''); if (!/^[0-9a-f]{40}$/.test(h)) throw new Error('contract address must be 0x + 40 hex characters'); return h; };
      const valueWei = flags.value ? (parseAur(flags.value) * WEI).toString() : '0';
      const gasFor = async (from, to, data) => (flags.gas ? Number(flags.gas) : Number(BigInt(await rpc.call('eth_estimateGas', [{ from: '0x' + from, ...(to ? { to: '0x' + to } : {}), data: '0x' + data, value: '0x' + BigInt(valueWei).toString(16) }]))));
      if (sub === 'code') { const c = await rpc.call('eth_getCode', ['0x' + toHex(need(pos[2], 'contract address')), 'latest']); return out({ code: c, bytes: (c.length - 2) / 2 }); }
      if (sub === 'call') { // read-only, no key needed
        const r = await rpc.call('eth_call', [{ to: '0x' + toHex(need(pos[2], 'contract address')), data: '0x' + readData(flags.data) }, 'latest']);
        return out({ result: r });
      }
      if (sub === 'deploy' || sub === 'send') {
        const w = await wallet();
        const from = hexOf(w.address, prefix);
        const to = sub === 'deploy' ? null : toHex(need(pos[2], 'contract address'));
        const data = readData(sub === 'deploy' ? need(flags.data, '--data <hex|@file>') : flags.data);
        const body = { to, value: valueWei, data, gasLimit: await gasFor(from, to, data) };
        if (flags.simulate) { const t = await w.build(rpc, 'evm', body, { tip, status }); return out({ simulated: true, ...(await rpc.simulate(t)) }); }
        const res = await w.send(rpc, 'evm', body, { tip, status, wait: !flags['no-wait'] });
        const ev = res.receipt && res.receipt.evm;
        out({ from: w.address, evmAddress: '0x' + from, ...res, ok: res.receipt ? res.receipt.status === 1 : undefined, gasUsed: ev && ev.gasUsed, contractAddress: ev && ev.contractAddress ? '0x' + ev.contractAddress : undefined, output: ev && ev.output ? '0x' + ev.output : undefined, logs: ev && ev.logs.length });
        if (res.receipt && res.receipt.status === 0) process.exitCode = 2;
        return;
      }
      throw new Error('evm: deploy --data <hex|@file> | send <0xaddr> --data <hex> [--value AUR] | call <0xaddr> --data <hex> | code <0xaddr>');
    }
    case 'gov': {
      const { GOV_PARAMS } = require('../src/gov');
      if (sub === 'list' || !sub) {
        const r = await rpc.call('aur_getProposals');
        return out({ governance: r.governance, changeable: r.govParams, proposals: r.proposals.map((p) => ({ id: p.id, title: p.title, status: p.status, reason: p.reason, votingEnd: p.votingEnd, executeAt: p.executeAt, changes: p.changes, tally: p.tally })) });
      }
      if (sub === 'vote') return tx('vote', { id: Number(need(pos[2], 'proposal id')), option: need(pos[3], 'yes|no|abstain|veto') });
      if (sub === 'propose') {
        const sets = [].concat(flags.set === undefined ? [] : flags.set);
        const raw = process.argv.slice(2).reduce((acc, a, i, arr) => (a === '--set' && arr[i + 1] ? [...acc, arr[i + 1]] : acc), []);
        void sets;
        const changes = {};
        for (const kv of raw) {
          const [k, ...rest] = kv.split('=');
          const s = rest.join('=');
          if (!GOV_PARAMS[k]) throw new Error(`"${k}" cannot be changed by governance. Changeable: ${Object.keys(GOV_PARAMS).join(', ')}`);
          changes[k] = /^\d+$/.test(s) && GOV_PARAMS[k](Number(s)) ? Number(s) : s;
        }
        return tx('submitProposal', { title: need(flags.title, '--title'), description: String(flags.description === true ? '' : flags.description || ''), changes });
      }
      throw new Error('gov: list | vote <id> <yes|no|abstain|veto> | propose --title T --description D --set param=value [--set ...]');
    }
    case 'faucet': {
      const url = flags['faucet-url'] || (netMeta && netMeta.faucet);
      if (!url) throw new Error('no faucet for this network; pass --faucet-url');
      const r = await fetch(url + '/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: await resolveAddr(need(pos[1], 'address')) }) });
      return out(await r.json());
    }
    default: throw new Error(`unknown command "${cmd}". Try: aurenctl help`);
  }
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });

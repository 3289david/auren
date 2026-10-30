#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AurenNode, VERSION } = require('../src/node');
const { Keypair } = require('../src/crypto');
const { validateGenesis, genesisHash } = require('../src/genesis');

const ROOT = path.join(__dirname, '..');
const USAGE = `auren-node ${VERSION}

Usage:
  auren-node init  --network <devnet|testnet|mainnet> --home <dir> [--moniker <name>] [--genesis <file>] [--full-node]
  auren-node start --home <dir> [--rpc-host 127.0.0.1] [--rpc-port 9650] [--peers url,url] [--self-url url] [--website] [--earn [payout-address]] [--tls-cert f --tls-key f [--tls-port 443]] [--quiet]
  auren-node show-validator --home <dir>      print the consensus public key (for "aurenctl validator create")
  auren-node genesis-hash --home <dir>

Validator nodes need a consensus key (created by init) and "operator" set in <home>/config.json to the
address that created the validator on-chain. Without a key the node runs as a full node.`;

function parse(argv) {
  const cmd = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
    }
  }
  return { cmd, flags };
}

function loadHome(home) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'));
  const genesis = read('genesis.json');
  validateGenesis(genesis);
  const config = fs.existsSync(path.join(home, 'config.json')) ? read('config.json') : {};
  const keyFile = path.join(home, 'priv_validator_key.json');
  const consensusKey = fs.existsSync(keyFile) ? Keypair.fromSeedHex(read('priv_validator_key.json').seed) : null;
  return { genesis, config, consensusKey };
}

async function main() {
  const { cmd, flags } = parse(process.argv.slice(2));
  if (!cmd || cmd === 'help' || flags.help) return console.log(USAGE);
  if (cmd === 'version') return console.log(VERSION);
  const home = path.resolve(flags.home || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.auren'));

  if (cmd === 'init') {
    const net = flags.network;
    if (!net) throw new Error('--network is required');
    const nets = JSON.parse(fs.readFileSync(path.join(ROOT, 'networks', 'networks.json'), 'utf8'));
    const meta = nets[net];
    if (!meta) throw new Error(`unknown network ${net}`);
    const gfile = flags.genesis || path.join(ROOT, 'networks', net, 'genesis.json');
    if (!fs.existsSync(gfile)) throw new Error(`no genesis at ${gfile}${net === 'mainnet' ? ' (mainnet genesis has not been published yet; see networks/mainnet/README.md)' : ''}`);
    const genesis = JSON.parse(fs.readFileSync(gfile, 'utf8'));
    validateGenesis(genesis);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'genesis.json'), JSON.stringify(genesis, null, 2));
    if (!flags['full-node'] && !fs.existsSync(path.join(home, 'priv_validator_key.json'))) {
      const k = Keypair.generate();
      fs.writeFileSync(path.join(home, 'priv_validator_key.json'), JSON.stringify({ seed: k.seedHex, pub: k.pub }, null, 2), { mode: 0o600 });
      console.log(`consensus public key: ${k.pub}`);
      console.log('BACK UP priv_validator_key.json. Never run two nodes with the same key: that is double signing and is slashed.');
    }
    if (!fs.existsSync(path.join(home, 'config.json'))) {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        moniker: flags.moniker || 'my-auren-node', rpcHost: '127.0.0.1', rpcPort: 9650, operator: null, peers: meta.seeds || [],
      }, null, 2));
    }
    console.log(`initialized ${net} (${genesis.chainId}) in ${home}\ngenesis hash: ${genesisHash(genesis)}`);
    return;
  }

  if (cmd === 'show-validator') {
    const { consensusKey } = loadHome(home);
    if (!consensusKey) throw new Error('no priv_validator_key.json in home');
    return console.log(consensusKey.pub);
  }
  if (cmd === 'genesis-hash') return console.log(genesisHash(loadHome(home).genesis));

  if (cmd === 'start') {
    const { genesis, config, consensusKey } = loadHome(home);
    const merged = { ...config };
    if (flags['rpc-host']) merged.rpcHost = flags['rpc-host'];
    if (flags['rpc-port']) merged.rpcPort = Number(flags['rpc-port']);
    if (flags.peers) merged.peers = String(flags.peers).split(',').filter(Boolean);
    if (flags['self-url']) merged.selfUrl = flags['self-url'];
    if (flags.moniker) merged.moniker = flags.moniker;
    if (flags.quiet) merged.quiet = true;
    if (flags.faucet) merged.faucet = String(flags.faucet);
    if (flags.earn) { merged.earn = true; if (typeof flags.earn === 'string') merged.payout = flags.earn; }
    if (flags['tls-cert'] && flags['tls-key']) merged.tls = { cert: path.resolve(flags['tls-cert']), key: path.resolve(flags['tls-key']), port: Number(flags['tls-port'] || 443) };
    if (flags.website) merged.webRoot = path.join(ROOT, 'website'); // serve wallet + explorer from this node
    const asValidator = consensusKey && merged.operator;
    const node = new AurenNode({ home, genesis, config: merged, consensusKey: asValidator ? consensusKey : null });
    await node.start();
    const stop = async () => { console.log('shutting down...'); await node.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });

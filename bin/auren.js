#!/usr/bin/env node
'use strict';
// The one command for people who just want to use AUREN or run a node. Needs only Node.js 20+ (no npm, no install step).
//   auren join testnet          join the AUREN testnet as a full node (also: devnet, mainnet)
//   auren status                is my node running and in sync?
//   auren ctl <args>            wallet and chain commands (same as aurenctl)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { spawnNode } = require('../src/spawnnode');
const { canon, sha256hex } = require('../src/util');

const ROOT = path.join(__dirname, '..');
const NETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'networks', 'networks.json'), 'utf8').replace(/^﻿/, ''));
const VERSION = require('../src/node').VERSION;

const USAGE = `AUREN ${VERSION}

  auren join <mainnet|testnet|devnet> [options]   join a network as a full node (creates ~/.auren/<network> on first run)
  auren status [--network <name>]                  show whether your node is running and synced
  auren ctl <command>                              wallet and chain commands, e.g.  auren ctl keys new me
  auren version

Options for join:
  --home <dir>        where chain data lives (default: ~/.auren/<network>)
  --peers <url,url>   nodes to connect to (default: the public seed nodes for that network)
  --earn [address]    earn AUR: bond this node and prove it stores the chain each epoch; rewards go to [address] (default: the node's own address)
  --public            accept connections on all network interfaces (default: only this computer)
  --port <n>          port for this node (default 9650)
  --tls-cert <f> --tls-key <f> [--tls-port <n>]   also serve HTTPS (needed for the wallet on a non-local web address)

There is exactly one mainnet, one testnet and one devnet. You join them; you do not create them.`;

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2), n = argv[i + 1]; if (n === undefined || n.startsWith('--')) flags[k] = true; else { flags[k] = n; i++; } } else pos.push(argv[i]);
  }
  return { pos, flags };
}

const homeFor = (net, flags) => path.resolve(flags.home || path.join(os.homedir(), '.auren', net));

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || flags.help) return console.log(USAGE);
  if (cmd === 'version') return console.log(VERSION);

  if (cmd === 'ctl') {
    const r = spawnNode(cp, 'spawnSync', path.join(__dirname, 'aurenctl.js'), process.argv.slice(3), { stdio: 'inherit' });
    process.exitCode = r.status ?? 1; return;
  }

  if (cmd === 'status') {
    const net = flags.network || pos[1] || 'testnet';
    let port = Number(flags.port || 9650);
    try { port = JSON.parse(fs.readFileSync(path.join(homeFor(net, flags), 'config.json'), 'utf8')).rpcPort || port; } catch { /* default */ }
    try {
      const s = await (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3000) })).json();
      console.log(`running · ${s.chainId} · block ${s.height} · ${s.peers} peers · ${s.catchingUp ? 'catching up' : 'in sync'}`);
    } catch { console.log(`not running (nothing answered on port ${port})`); process.exitCode = 1; }
    return;
  }

  if (cmd === 'join') {
    const net = pos[1];
    if (!net || !NETS[net]) { console.error(`Which network? One of: ${Object.keys(NETS).join(', ')}\n\n  auren join testnet`); process.exitCode = 1; return; }
    const meta = NETS[net];
    const gfile = path.join(ROOT, 'networks', net, 'genesis.json');
    if (!fs.existsSync(gfile)) {
      console.error(`The ${net} has not been launched yet, so there is nothing to join. ${net === 'mainnet' ? 'Mainnet will only launch after independent security audits and a long public test period.' : ''}`);
      process.exitCode = 1; return;
    }
    const genesis = JSON.parse(fs.readFileSync(gfile, 'utf8'));
    const hash = sha256hex(canon(genesis));
    if (meta.genesisHash && hash !== meta.genesisHash) { console.error(`This copy of AUREN has a ${net} genesis that does not match the official one.\n  expected ${meta.genesisHash}\n  found    ${hash}\nDownload a fresh copy from the official site.`); process.exitCode = 1; return; }

    const home = homeFor(net, flags);
    if (!fs.existsSync(path.join(home, 'genesis.json'))) {
      const r = spawnNode(cp, 'spawnSync', path.join(__dirname, 'auren-node.js'), ['init', '--network', net, '--home', home, '--full-node', '--moniker', flags.moniker || `${os.hostname()}-${net}`], { stdio: 'inherit' });
      if (r.status !== 0) { process.exitCode = r.status || 1; return; }
    } else {
      const have = JSON.parse(fs.readFileSync(path.join(home, 'genesis.json'), 'utf8'));
      if (sha256hex(canon(have)) !== hash) { console.error(`${home} holds data for a different chain. Use --home <another folder>.`); process.exitCode = 1; return; }
    }

    const peers = flags.peers ? String(flags.peers) : (meta.seeds || []).join(',');
    if (!peers) console.warn(`Note: no public seed nodes are published for the ${net} yet. Pass --peers http://host:port to connect to a node you know.`);
    const args = ['start', '--home', home, '--website', '--rpc-port', String(flags.port || 9650)];
    if (peers) args.push('--peers', peers);
    if (flags.public) args.push('--rpc-host', '0.0.0.0');
    if (flags.earn) { args.push('--earn'); if (typeof flags.earn === 'string') args.push(flags.earn); if (meta.faucet && net !== 'mainnet') args.push('--faucet', meta.faucet); }
    for (const k of ['tls-cert', 'tls-key', 'tls-port', 'self-url']) if (flags[k]) args.push(`--${k}`, String(flags[k]));
    console.log(`\nJoining the AUREN ${net} (${meta.chainId}). Your node's data lives in ${home}\nPress Ctrl+C to stop. Check it any time with:  auren status --network ${net}\n`);
    const child = spawnNode(cp, 'spawn', path.join(__dirname, 'auren-node.js'), args, { stdio: 'inherit' });
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
    child.on('exit', (code) => { process.exitCode = code ?? 0; });
    return;
  }

  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });

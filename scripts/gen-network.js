#!/usr/bin/env node
'use strict';
// Generate genesis + validator homes for devnet / testnet.
//   node scripts/gen-network.js --network devnet --validators 4 --deterministic
//   node scripts/gen-network.js --network testnet --validators 4
const path = require('node:path');
const { generate } = require('../src/netgen');

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const network = a.network;
if (!network) { console.error('usage: gen-network --network <devnet|testnet> [--validators N] [--deterministic] [--genesis-time ms] [--out dir] [--homes dir]'); process.exit(1); }

const root = path.join(__dirname, '..');
const out = path.resolve(a.out || path.join(root, 'networks', network));
const deterministic = !!a.deterministic;
if (network === 'testnet' && deterministic) { console.error('refusing: a deterministic testnet would have publicly known validator keys'); process.exit(1); }
const homes = a.homes ? path.resolve(a.homes) : (deterministic ? null : path.join(out, '_private'));

const r = generate({ network, validators: Number(a.validators || 4), deterministic, genesisTime: a['genesis-time'] ? Number(a['genesis-time']) : undefined, outDir: out, homesDir: homes });
// pin the genesis hash where wallets and light clients look for it
const netsFile = path.join(root, 'networks', 'networks.json');
try {
  const nets = JSON.parse(require('node:fs').readFileSync(netsFile, 'utf8'));
  if (nets[network]) { nets[network].genesisHash = r.hash; require('node:fs').writeFileSync(netsFile, JSON.stringify(nets, null, 2) + '\n'); }
} catch { /* networks.json is optional */ }
console.log(`${network}: wrote ${path.join(out, 'genesis.json')}`);
console.log(`chain id:     ${r.genesis.chainId}`);
console.log(`genesis hash: ${r.hash}`);
console.log(`genesis time: ${new Date(r.genesis.genesisTime).toISOString()}`);
if (homes) console.log(`validator homes + operator/faucet keys: ${homes}  (SECRET: do not commit)`);

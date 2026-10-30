#!/usr/bin/env node
'use strict';
// One-command local network: N validators + faucet (+ website with the explorer).
//   npm run devnet                      4 validators on :9650-9653, faucet :9690, website :8080
//   node scripts/devnet.js --clean      wipe chain data first
//   node scripts/devnet.js --validators 7 --no-website
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { generate } = require('../src/netgen');

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const root = path.join(__dirname, '..');
const dir = path.join(root, '.devnet');
const n = Number(a.validators || 4);
const basePort = Number(a['base-port'] || 9650);

if (a.clean) fs.rmSync(dir, { recursive: true, force: true });
const r = generate({ network: 'devnet', validators: n, deterministic: true, outDir: path.join(root, 'networks', 'devnet'), homesDir: dir, basePort });
// keep existing chain data when restarting (generate only rewrites config)
fs.writeFileSync(path.join(dir, 'faucet.json'), JSON.stringify({ seed: r.named.faucet.seedHex }), { mode: 0o600 });

const children = [];
const run = (label, script, args) => {
  const c = spawn(process.execPath, [path.join(root, 'bin', script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (s) => s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(`[${label}] ${l.replace(/^\S+ \[[^\]]+\] /, '')}`)));
  pipe(c.stdout); pipe(c.stderr);
  c.on('exit', (code) => { if (code && !shuttingDown) console.log(`[${label}] exited with code ${code}`); });
  children.push(c);
};
let shuttingDown = false;
// every node serves the website itself (wallet + explorer + landing), so http://127.0.0.1:9650/ works on its own
for (let i = 0; i < n; i++) run(`val${i}`, 'auren-node.js', ['start', '--home', path.join(dir, `node${i}`), '--website']);
setTimeout(() => run('faucet', 'auren-faucet.js', ['--rpc', `http://127.0.0.1:${basePort}`, '--key-file', path.join(dir, 'faucet.json'), '--port', '9690', '--host', process.env.AUREN_BIND || '127.0.0.1', '--amount', '1000', '--cooldown-sec', '5']), 1500);
if (!a['no-website']) run('web', '../scripts/serve-website.js', []);

const acc = r.named;
const { pubToAddress } = require('../src/address');
setTimeout(() => {
  console.log(`
  AUREN devnet is up  (chain ${r.genesis.chainId}, ${n} validators, 1s blocks)
  ------------------------------------------------------------------------
  RPC         http://127.0.0.1:${basePort}   (validators on ${basePort}-${basePort + n - 1})
  Faucet      http://127.0.0.1:9690
  Explorer    http://127.0.0.1:8080/explorer.html
  Website     http://127.0.0.1:8080

  Public dev accounts (NEVER use these keys anywhere else):
${Object.entries(acc).map(([k, v]) => `    ${k.padEnd(7)} ${pubToAddress(v.pub, 'daur')}`).join('\n')}
  Seeds are in .devnet/accounts.json. Try:
    node bin/aurenctl.js status --network devnet
    node bin/aurenctl.js keys import alice --seed <alice seed from .devnet/accounts.json>
`);
}, 2500);

const stop = () => { shuttingDown = true; children.forEach((c) => c.kill()); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

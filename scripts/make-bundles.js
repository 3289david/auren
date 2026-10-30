#!/usr/bin/env node
'use strict';
// Turn a list of machines into ready-to-ship validator bundles for a REAL multi-host network.
//   node scripts/make-bundles.js --network testnet --hosts 203.0.113.10,203.0.113.11,203.0.113.12,203.0.113.13 --out ./bundles
// Each bundle (bundles/nodeN/) has the genesis, that validator's consensus key, a config pointing at the other hosts,
// start scripts and a systemd unit. Copy one bundle to each machine with the repo, then run start.sh.
// Keys are generated here: treat the output as SECRET and move each bundle to its owner over a secure channel.
const fs = require('node:fs');
const path = require('node:path');
const { generate } = require('../src/netgen');

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
if (!a.hosts || !a.network) { console.error('usage: make-bundles --network <devnet|testnet> --hosts host1[:port],host2,... [--out dir] [--genesis-time ms]'); process.exit(1); }
if (a.network === 'mainnet') { console.error('mainnet genesis is built by scripts/genesis-ceremony.js from validator-signed gentxs, not generated centrally'); process.exit(1); }
const hosts = String(a.hosts).split(',').map((s) => s.trim()).filter(Boolean);
if (hosts.length < 4) { console.error('a BFT network needs at least 4 validators (tolerates 1 faulty); got ' + hosts.length); process.exit(1); }
const out = path.resolve(a.out || 'bundles');
const root = path.join(__dirname, '..');

const r = generate({ network: a.network, hosts, genesisTime: a['genesis-time'] ? Number(a['genesis-time']) : Date.now() + 10 * 60 * 1000, outDir: path.join(out, 'public'), homesDir: out, basePort: 9650 });
hosts.forEach((h, i) => {
  const dir = path.join(out, `node${i}`);
  fs.writeFileSync(path.join(dir, 'start.sh'), `#!/bin/sh\n# run from the repo root:  sh ${'$'}HOME/auren-bundle/start.sh\ncd "$(dirname "$0")/.." 2>/dev/null || true\nexec node bin/auren-node.js start --home "$(dirname "$0")" --website\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'start.ps1'), `Set-Location (Split-Path $PSScriptRoot -Parent)\nnode bin/auren-node.js start --home $PSScriptRoot --website\n`);
  fs.writeFileSync(path.join(dir, 'auren-node.service'), `[Unit]\nDescription=AUREN ${a.network} validator ${i}\nAfter=network-online.target\n\n[Service]\nUser=auren\nWorkingDirectory=/opt/auren\nExecStart=/usr/bin/node bin/auren-node.js start --home /var/lib/auren --website\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\n\n[Install]\nWantedBy=multi-user.target\n`);
  fs.writeFileSync(path.join(dir, 'README.txt'), `AUREN ${a.network} validator ${i} (${h})\n\n1. Install Node.js 20+ and copy the repo to /opt/auren (or run from a checkout).\n2. Copy this whole folder to the machine (secret: contains priv_validator_key.json, chmod 600).\n3. Open TCP ${hosts[i].split(':')[1] || 9650} between the validator machines only (allow-list their IPs).\n4. Start (all machines within a few minutes of genesis time ${new Date(r.genesis.genesisTime).toISOString()}):\n     sh start.sh        (Linux/macOS)      or   ./start.ps1   (Windows)\n   or install auren-node.service with --home /var/lib/auren.\n5. NEVER run two nodes with the same priv_validator_key.json (double signing = slashing).\n6. Verify from anywhere:  node scripts/verify-network.js ${hosts.map((x) => 'http://' + (x.includes(':') ? x : x + ':9650')).join(' ')}\n`);
});
fs.writeFileSync(path.join(out, 'NETWORK.md'), `# ${r.genesis.chainId}\n\n- genesis hash: ${r.hash}\n- genesis time: ${new Date(r.genesis.genesisTime).toISOString()}\n- validators:\n${hosts.map((h, i) => `  - node${i}: ${h}`).join('\n')}\n\nPublish genesis.json (public/genesis.json) and the hash above through several independent channels.\n`);
console.log(`${r.genesis.chainId}: ${hosts.length} validator bundles in ${out}\ngenesis hash ${r.hash}\ngenesis time ${new Date(r.genesis.genesisTime).toISOString()}\nSECRET: ${out}/node*/priv_validator_key.json and ${out}/accounts.json`);
void root;

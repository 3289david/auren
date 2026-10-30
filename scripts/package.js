#!/usr/bin/env node
'use strict';
// Build download packages that need only Node.js (no npm, no git): dist/auren-<version>.zip and .tar.gz
// (also copied to website/downloads/ so any node started with --website can serve them).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const version = require('../src/node').VERSION;
const name = `auren-${version}`;
const dist = path.join(root, 'dist');
const stage = path.join(dist, name);
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const include = ['bin', 'src', 'website', 'install', 'networks/networks.json', 'networks/devnet', 'networks/testnet/genesis.json', 'networks/testnet/network.json', 'networks/mainnet', 'docs', 'deploy', 'auren', 'auren.cmd', 'README.md', 'LICENSE', 'package.json', 'CHANGELOG.md', 'SECURITY.md'];
const skip = (p) => /(^|[\\/])(_private|downloads|node_modules|\.devnet)([\\/]|$)/.test(p);
function copy(rel) {
  const from = path.join(root, rel), to = path.join(stage, rel);
  if (!fs.existsSync(from) || skip(rel)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) copy(path.join(rel, f)); }
  else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
}
include.forEach(copy);
fs.chmodSync(path.join(stage, 'auren'), 0o755);

const run = (args) => { const r = spawnSync('tar', args, { cwd: dist, stdio: 'pipe' }); if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`); };
run(['-a', '-cf', `${name}.zip`, name]);
run(['-czf', `${name}.tar.gz`, name]);

const dl = path.join(root, 'website', 'downloads');
fs.mkdirSync(dl, { recursive: true });
for (const f of [`${name}.zip`, `${name}.tar.gz`]) fs.copyFileSync(path.join(dist, f), path.join(dl, f));
fs.writeFileSync(path.join(dl, 'latest.json'), JSON.stringify({ version, zip: `${name}.zip`, tgz: `${name}.tar.gz` }));
for (const f of [`${name}.zip`, `${name}.tar.gz`]) console.log(`${f}  ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`);

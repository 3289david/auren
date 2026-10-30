#!/usr/bin/env node
'use strict';
// Build AUREN-Node and AUREN-Wallet as single-file executables (Node single executable applications).
// Run on the target OS: it copies the local `node` binary and injects the program into it.
// Needs network access once, to fetch the `postject` injector (a build-time tool; nothing from npm ships).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const version = require('../src/node').VERSION;
const out = path.join(root, 'dist', 'exe');
const win = process.platform === 'win32';
const ext = win ? '.exe' : '';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// payload = the same file set as the zip package
const include = ['bin', 'src', 'website', 'networks/networks.json', 'networks/devnet', 'networks/testnet/genesis.json', 'networks/testnet/network.json', 'networks/mainnet', 'docs', 'README.md', 'LICENSE', 'package.json', 'CHANGELOG.md'];
const skip = (p) => /(^|[\\/])(_private|downloads|node_modules|\.devnet)([\\/]|$)/.test(p);
const files = {};
function walk(rel) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f) || skip(rel)) return;
  if (fs.statSync(f).isDirectory()) fs.readdirSync(f).forEach((n) => walk(path.join(rel, n)));
  else files[rel.split(path.sep).join('/')] = fs.readFileSync(f).toString('base64');
}
include.forEach(walk);
const payload = path.join(out, 'payload.bin');
fs.writeFileSync(payload, zlib.deflateSync(Buffer.from(JSON.stringify(files)), { level: 9 }));

const cfg = path.join(out, 'sea-config.json');
const blob = path.join(out, 'sea.blob');
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(__dirname, 'sea-main.js'), output: blob, disableExperimentalSEAWarning: true, assets: { payload } }));
let r = spawnSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

for (const name of [`AUREN-Node-${version}`, `AUREN-Wallet-${version}`]) {
  const exe = path.join(out, name + ext);
  fs.copyFileSync(process.execPath, exe);
  const args = ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
  r = spawnSync(win ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: win });
  if (r.status !== 0) { console.error('postject failed'); process.exit(r.status || 1); }
  console.log(`${path.basename(exe)}  ${(fs.statSync(exe).size / 1048576).toFixed(0)} MB`);
}
fs.rmSync(payload); fs.rmSync(blob); fs.rmSync(cfg);

#!/usr/bin/env node
'use strict';
// Build the Mac miner: dist/AUREN-Miner-<version>-mac-arm64.tar.gz and -x64.tar.gz.
// Each holds "AUREN Miner.app": a double-clickable Mac app with the official Node.js runtime for macOS
// (signed by the Node.js project) and the miner. It can be built on any OS because nothing is compiled.
//
// Needs network access to nodejs.org once. Mac users need nothing installed.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const version = require('../src/node').VERSION;
const NODE_VERSION = process.env.NODE_MAC_VERSION || process.version.slice(1);
const out = path.join(root, 'dist');
const cache = path.join(require('node:os').tmpdir(), 'auren-mac-build');
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(out, { recursive: true });

function download(url, file) {
  return new Promise((res, rej) => {
    if (fs.existsSync(file)) return res();
    https.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return download(r.headers.location, file).then(res, rej);
      if (r.statusCode !== 200) return rej(new Error(`${url}: HTTP ${r.statusCode}`));
      const w = fs.createWriteStream(file + '.part');
      r.pipe(w); w.on('finish', () => { w.close(); fs.renameSync(file + '.part', file); res(); });
    }).on('error', rej);
  });
}

// ---- a minimal tar writer so file modes (executable bits) are right even when built on Windows
function tarEntry(name, data, mode, type = '0') {
  const h = Buffer.alloc(512);
  const put = (s, o, l) => h.write(s.slice(0, l), o, 'ascii');
  let prefix = '', n = name;
  if (n.length > 100) { const i = n.lastIndexOf('/', 154); prefix = n.slice(0, i); n = n.slice(i + 1); }
  put(n, 0, 100); put(mode.toString(8).padStart(7, '0') + '\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
  put(data.length.toString(8).padStart(11, '0') + '\0', 124, 12); put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  h.fill(0x20, 148, 156); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2); put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}
function untar(buf) { // read regular files and directories out of an uncompressed tar
  const files = [];
  for (let i = 0; i + 512 <= buf.length;) {
    const h = buf.subarray(i, i + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o, l) => h.toString('ascii', o, o + l).replace(/\0.*$/, '');
    const name = (str(345, 155) ? str(345, 155) + '/' : '') + str(0, 100), size = parseInt(str(124, 12).trim() || '0', 8), type = str(156, 1) || '0', mode = parseInt(str(100, 8).trim() || '644', 8);
    if (type === '0') files.push({ name, mode, data: buf.subarray(i + 512, i + 512 + size) });
    i += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const skip = (p) => /(^|[\\/])(_private|downloads|node_modules|\.devnet|docs)([\\/]|$)/.test(p);
function collect(rel, into) {
  const f = path.join(root, rel);
  if (!fs.existsSync(f) || skip(rel)) return;
  if (fs.statSync(f).isDirectory()) fs.readdirSync(f).forEach((n) => collect(path.posix.join(rel.split(path.sep).join('/'), n), into));
  else into.push({ rel: rel.split(path.sep).join('/'), data: fs.readFileSync(f) });
}

(async () => {
  const app = [];
  for (const r of ['bin', 'src', 'miner', 'website', 'networks/networks.json', 'networks/devnet', 'networks/testnet/genesis.json', 'networks/testnet/network.json', 'networks/mainnet', 'package.json', 'LICENSE']) collect(r, app);
  for (const arch of ['arm64', 'x64']) {
    const tgz = path.join(cache, `node-v${NODE_VERSION}-darwin-${arch}.tar.gz`);
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.gz`, tgz);
    const nodeFiles = untar(zlib.gunzipSync(fs.readFileSync(tgz)));
    const nodeBin = nodeFiles.find((f) => /\/bin\/node$/.test(f.name));
    if (!nodeBin) throw new Error('node binary not found in the macOS archive');
    // a real Mac app: double-click "AUREN Miner", no Terminal window
    const app0 = 'AUREN Miner.app/Contents';
    const parts = [];
    const png = fs.readFileSync(path.join(__dirname, 'icon-256.png'));
    const icns = Buffer.concat([Buffer.from('icns'), (() => { const l = Buffer.alloc(4); l.writeUInt32BE(8 + 8 + png.length); return l; })(), Buffer.from('ic08'), (() => { const l = Buffer.alloc(4); l.writeUInt32BE(8 + png.length); return l; })(), png]);
    parts.push(tarEntry(`${app0}/Info.plist`, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AUREN Miner</string>
<key>CFBundleDisplayName</key><string>AUREN Miner</string>
<key>CFBundleIdentifier</key><string>app.auren.miner</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`), 0o644));
    parts.push(tarEntry(`${app0}/MacOS/launcher`, Buffer.from(`#!/bin/bash
# AUREN Miner for Mac. Runs the bundled Node.js; the app window is the whole interface.
R="$(cd "$(dirname "$0")/../Resources" && pwd)"
xattr -dr com.apple.quarantine "$R" 2>/dev/null
export AUREN_APP_MODE=miner
exec "$R/runtime/node" "$R/miner/miner.js"
`), 0o755));
    parts.push(tarEntry(`${app0}/Resources/icon.icns`, icns, 0o644));
    parts.push(tarEntry(`${app0}/Resources/runtime/node`, nodeBin.data, 0o755));
    for (const f of app) parts.push(tarEntry(`${app0}/Resources/${f.rel}`, f.data, 0o644));
    parts.push(Buffer.alloc(1024));
    const file = path.join(out, `AUREN-Miner-${version}-mac-${arch}.tar.gz`);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts), { level: 9 }));
    console.log(`${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(0)} MB`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
void spawnSync;

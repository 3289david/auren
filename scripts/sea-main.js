'use strict';
// Entry point of the single-file apps AUREN-Node.exe and AUREN-Wallet.exe (Node single executable).
// The whole AUREN program ships inside as one compressed asset and is unpacked on first run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const sea = require('node:sea');

const raw = Buffer.from(sea.getAsset('payload'));
const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || os.homedir()) : path.join(os.homedir(), '.local', 'share');
const appDir = path.join(base, 'AUREN', `app-${id}`);

function unpack() {
  if (fs.existsSync(path.join(appDir, '.ok'))) return;
  const files = JSON.parse(zlib.inflateSync(raw).toString('utf8'));
  for (const [rel, b64] of Object.entries(files)) {
    const f = path.join(appDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  }
  fs.writeFileSync(path.join(appDir, '.ok'), id);
}
const runScript = (script, args) => {
  process.argv = [process.execPath, script, ...args];
  Module.createRequire(script)(script);
};
const openUrl = (u) => {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { stdio: 'ignore', detached: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { stdio: 'ignore', detached: true }).unref();
};
const ask = (q) => new Promise((res) => {
  const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

function wallet() {
  const web = path.join(appDir, 'website');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/wallet.html';
    const file = p === '/networks.json' ? path.join(appDir, 'networks', 'networks.json') : path.normalize(path.join(web, p));
    if (p !== '/networks.json' && !file.startsWith(web)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  });
  const listen = (port) => server.listen(port, '127.0.0.1');
  server.on('error', (e) => { if (e.code === 'EADDRINUSE') listen(0); else throw e; });
  server.on('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}/wallet.html`;
    console.log(`AUREN Wallet is open at ${url}\nYour keys stay in your browser on this computer. Close this window to quit.`);
    openUrl(url);
  });
  listen(8787);
}

async function node(args) {
  const auren = path.join(appDir, 'bin', 'auren.js');
  if (args.length) return runScript(auren, args);
  console.log('AUREN node\n\n  1) Join the testnet\n  2) Join the testnet and earn AUR\n  3) Join the devnet (local development network)\n  q) Quit\n');
  const c = await ask('Choose: ');
  if (c === '1') return runScript(auren, ['join', 'testnet']);
  if (c === '2') {
    const a = await ask('Address to receive rewards (Enter = the node address): ');
    return runScript(auren, ['join', 'testnet', '--earn', ...(a ? [a] : [])]);
  }
  if (c === '3') return runScript(auren, ['join', 'devnet']);
}

(async () => {
  unpack();
  const args = process.argv.slice(2);
  const child = process.env.AUREN_RUN_SCRIPT;
  if (child) { delete process.env.AUREN_RUN_SCRIPT; return runScript(child, args); }
  if (/wallet/i.test(path.basename(process.execPath))) return wallet();
  return node(args);
})().catch((e) => { console.error(`error: ${e.message}`); process.exitCode = 1; });

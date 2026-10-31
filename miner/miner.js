'use strict';
// AUREN Miner and AUREN Node (Windows, Mac, Linux): run a node in the background and show a small app window.
// Miner = `auren join <network> --earn` (docs/miner.md, docs/rpc-consensus.md). Node = `auren join <network>`.
// Nothing here opens a console window: the program has no terminal, only the app window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const cp = require('node:child_process');
const { spawnNode } = require('../src/spawnnode');

const root = path.join(__dirname, '..');
const MODE = process.env.AUREN_APP_MODE === 'node' ? 'node' : 'miner';
const base = path.join(os.homedir(), '.auren', MODE);
const cfgFile = path.join(base, 'miner.json');
fs.mkdirSync(base, { recursive: true });

const NETWORKS = ['testnet', 'devnet'];
let cfg = { network: 'testnet', payout: '' };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) }; } catch { /* first run */ }
if (!NETWORKS.includes(cfg.network)) cfg.network = 'testnet';
const save = () => fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

let child = null, startedAt = 0, nodePort = 0;
const logLines = [];
const log = (s) => { for (const l of String(s).split(/\r?\n/)) if (l.trim()) { logLines.push(l); if (logLines.length > 200) logLines.shift(); } };
const homeDir = () => path.join(base, cfg.network);

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function start() {
  if (child) return;
  const args = ['join', cfg.network];
  if (MODE === 'miner') { args.push('--earn'); if (cfg.payout) args.push(cfg.payout); }
  nodePort = await freePort();
  args.push('--home', homeDir(), '--port', String(nodePort));
  if (process.env.AUREN_MINER_PEERS) args.push('--peers', process.env.AUREN_MINER_PEERS); // test hook, not a user option
  log('starting…');
  child = spawnNode(cp, 'spawn', path.join(root, 'bin', 'auren.js'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  startedAt = Date.now();
  child.stdout.on('data', log); child.stderr.on('data', log);
  child.on('exit', (code) => { log(`stopped (${code})`); child = null; });
}
function stop() { if (child) { child.kill(); child = null; log('stopping…'); } }

/** Height and peers straight from the running node (used by the Node app, and as a fallback). */
async function nodeStatus() {
  if (!child || !nodePort) return null;
  try {
    const j = await (await fetch(`http://127.0.0.1:${nodePort}/status`, { signal: AbortSignal.timeout(1500) })).json();
    return { height: j.height, peers: j.peers, syncing: !!j.catchingUp, network: j.chainId };
  } catch { return null; }
}

function minerStatus() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(homeDir(), 'miner-status.json'), 'utf8'));
    return Date.now() - j.updated < 120000 ? j : { ...j, stale: true };
  } catch { return null; }
}

const page = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

// Closing the app window quits the app. The page polls every couple of seconds and says goodbye when it closes;
// if neither happens for three minutes (a minimized window can be throttled), the app quits too.
let lastSeen = 0, closingAt = 0;
const quit = () => { stop(); setTimeout(() => process.exit(0), 300); };
setInterval(() => {
  if (!lastSeen) return;
  if (closingAt && Date.now() - closingAt > 8000) return quit();
  if (Date.now() - lastSeen > 180000) quit();
}, 2000).unref();
const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const body = () => new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
  lastSeen = Date.now();
  if (req.method === 'POST' && req.url === '/api/closing') { closingAt = Date.now(); return send(200, { ok: true }); }
  closingAt = 0;
  if (req.method === 'POST' && req.url === '/api/quit') { send(200, { ok: true }); return quit(); }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) return send(200, page, 'text/html; charset=utf-8');
  if (req.method === 'GET' && req.url === '/api/status') return send(200, { mode: MODE, running: !!child, startedAt, config: cfg, networks: NETWORKS, miner: MODE === 'miner' ? minerStatus() : null, node: await nodeStatus(), log: logLines.slice(-40) });
  if (req.method === 'POST' && req.url === '/api/start') { await start(); return send(200, { ok: true }); }
  if (req.method === 'POST' && req.url === '/api/stop') { stop(); return send(200, { ok: true }); }
  if (req.method === 'POST' && req.url === '/api/config') {
    const b = await body();
    if (child) return send(409, { error: 'Stop mining before changing settings.' });
    if (NETWORKS.includes(b.network)) cfg.network = b.network;
    if (typeof b.payout === 'string') cfg.payout = b.payout.trim().slice(0, 100);
    save();
    return send(200, { ok: true });
  }
  return send(404, { error: 'not found' });
});

function openWindow(url) {
  const win = process.platform === 'win32', mac = process.platform === 'darwin';
  const tryExe = (exe, args) => { if (exe && fs.existsSync(exe)) { cp.spawn(exe, args, { stdio: 'ignore', detached: true, windowsHide: false }).unref(); return true; } return false; };
  const app = ['--app=' + url, '--window-size=520,860'];
  if (win) {
    for (const r of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
      if (tryExe(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), app) || tryExe(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), app)) return;
    }
    cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } else if (mac) {
    for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) if (tryExe(exe, app)) return;
    cp.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } else cp.spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

server.listen(0, '127.0.0.1', async () => {
  try { console.log(`AUREN ${MODE === 'node' ? 'Node' : 'Miner'} is running.`); } catch { /* no console in the packaged apps */ }
  openWindow(`http://127.0.0.1:${server.address().port}/`);
  if (cfg.autoStart) await start();
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0); });
process.on('exit', stop);

#!/usr/bin/env node
'use strict';
// Test-network faucet: POST /drip {address}. Rate limited per address and per IP. Never run on mainnet.
const http = require('node:http');
const fs = require('node:fs');
const { RpcClient, Wallet } = require('../src/client');
const { Keypair } = require('../src/crypto');
const { isValidAddress } = require('../src/address');
const { parseAur, formatAur } = require('../src/util');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const rpc = new RpcClient(args.rpc || 'http://127.0.0.1:9650');
const port = Number(args.port || 9690);
const amount = parseAur(args.amount || '100');
const cooldownMs = Number(args['cooldown-sec'] || 86400) * 1000;
if (!args['key-file']) { console.error('usage: auren-faucet --key-file <json with {"seed":"hex"}> [--rpc url] [--port 9690] [--amount 100] [--cooldown-sec 86400]'); process.exit(1); }

(async () => {
  const st = await rpc.status();
  if (st.network === 'mainnet') { console.error('refusing to run a faucet on mainnet'); process.exit(1); }
  const wallet = new Wallet(Keypair.fromSeedHex(JSON.parse(fs.readFileSync(args['key-file'], 'utf8')).seed), st.addressPrefix);
  const byAddr = new Map(), byIp = new Map();
  let queue = Promise.resolve(); // serialize sends so nonces stay ordered

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(JSON.stringify(body));
  };
  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET') return send(res, 200, { network: st.chainId, faucet: wallet.address, amount: formatAur(amount) + ' AUR', cooldownSec: cooldownMs / 1000 });
    if (req.method !== 'POST' || req.url !== '/drip') return send(res, 404, { error: 'not found' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      queue = queue.then(async () => {
        try {
          const { address } = JSON.parse(body || '{}');
          if (!isValidAddress(address, st.addressPrefix)) return send(res, 400, { error: `invalid ${st.addressPrefix} address` });
          const ip = req.socket.remoteAddress, now = Date.now();
          const wait = Math.max((byAddr.get(address) || 0) + cooldownMs - now, (byIp.get(ip) || 0) + cooldownMs / 4 - now);
          if (wait > 0) return send(res, 429, { error: `rate limited, retry in ${Math.ceil(wait / 1000)}s` });
          const r = await wallet.send(rpc, 'transfer', { to: address, amount: amount.toString() }, { timeoutMs: 20000 });
          byAddr.set(address, now); byIp.set(ip, now);
          send(res, 200, { ok: true, hash: r.hash, amount: formatAur(amount) + ' AUR' });
        } catch (e) { send(res, 500, { error: e.message }); }
      });
    });
  }).listen(port, args.host || '127.0.0.1', () => console.log(`faucet ${wallet.address} serving on :${port}, ${formatAur(amount)} AUR per request`));
})().catch((e) => { console.error(e.message); process.exit(1); });

#!/usr/bin/env node
'use strict';
// Minimal static file server for ./website (no dependencies).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'website');
const port = Number(process.env.PORT || process.argv[2] || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.zip': 'application/zip', '.gz': 'application/gzip' };

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = p === '/networks.json' ? path.join(root, '..', 'networks', 'networks.json') : path.normalize(path.join(root, p));
  if (p !== '/networks.json' && !file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}).listen(port, process.env.AUREN_BIND || '127.0.0.1', () => console.log(`website on http://127.0.0.1:${port}`));

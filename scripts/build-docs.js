#!/usr/bin/env node
'use strict';
// Turn docs/*.md into website/docs/*.html (no dependencies). Run after editing docs: node scripts/build-docs.js
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'docs');
const out = path.join(root, 'website', 'docs');
const GH = 'https://github.com/3289david/auren/blob/main/';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function href(h, from) {
  if (/^(https?:|mailto:|#)/.test(h)) return h;
  const [file, hash] = h.split('#');
  if (/\.md$/.test(file) && !file.includes('/')) return (file === 'README.md' ? 'index.html' : file.replace(/\.md$/, '.html')) + (hash ? '#' + hash : '');
  const abs = path.posix.normalize(path.posix.join('docs', file));
  return GH + abs;
}
function inline(t) {
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, a, h) => `<a href="${esc(href(h.replace(/&amp;/g, '&')))}">${a}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

function render(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  const html = [];
  let title = null;
  const headings = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if ((m = /^```(\w*)/.exec(l))) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      html.push(`<div class="codebox"><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) {
      const lvl = m[1].length, text = m[2];
      if (lvl === 1 && !title) title = text.replace(/`/g, '');
      const id = slug(text);
      if (lvl >= 2 && lvl <= 3) headings.push({ lvl, id, text: text.replace(/`/g, '') });
      html.push(`<h${lvl} id="${id}">${inline(text)}</h${lvl}>`);
      i++;
    } else if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = row(l);
      i += 2;
      const rows = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(row(lines[i]));
      html.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length)); i++) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else if (/^>\s?/.test(l)) {
      const buf = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
    } else if (/^---+\s*$/.test(l)) { html.push('<hr>'); i++; }
    else if (!l.trim()) i++;
    else {
      const buf = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s+|>)/.test(lines[i]); i++) buf.push(lines[i]);
      if (!buf.length) { buf.push(lines[i]); i++; }
      html.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }
  return { html: html.join('\n'), title: title || 'Docs', headings };
}

const GROUPS = [
  ['Start here', ['START-HERE', 'GETTING-STARTED', 'wallet-guide', 'explorer-guide', 'staking-guide', 'domains', 'faq', 'troubleshooting', 'glossary']],
  ['Run a node', ['RUN-A-NODE', 'miner', 'node-rewards', 'rpc-consensus', 'BUILD-APPS', 'networks', 'validators', 'cli']],
  ['Build on AUREN', ['developer-quickstart', 'build-a-wallet', 'accept-payments', 'smart-contracts', 'integrate', 'rpc-api', 'name-resolution', 'evm']],
  ['Reference', ['transactions', 'parameters', 'errors', 'protocol']],
  ['How it works', ['architecture', 'whitepaper', 'consensus', 'fee-market', 'tokenomics', 'governance', 'security', 'hardware-wallets']],
  ['Operate', ['deploy', 'LAUNCH', 'roadmap']],
  ['Project', ['changelog', 'contributing', 'security-policy']],
];

const files = fs.readdirSync(src).filter((f) => f.endsWith('.md'));
const pages = {};
for (const f of files) { const name = f.replace(/\.md$/, ''); pages[name] = render(fs.readFileSync(path.join(src, f), 'utf8')); }
// project files from the repository root become pages too
for (const [f, name] of [['CHANGELOG.md', 'changelog'], ['CONTRIBUTING.md', 'contributing'], ['SECURITY.md', 'security-policy']]) {
  const p = path.join(root, f);
  if (fs.existsSync(p)) pages[name] = render(fs.readFileSync(p, 'utf8'));
}
const listed = new Set(GROUPS.flatMap((g) => g[1]));
const extra = Object.keys(pages).filter((n) => n !== 'README' && !listed.has(n));
if (extra.length) GROUPS.push(['More', extra]);
const ORDER = ['README', ...GROUPS.flatMap((x) => x[1])].filter((n) => pages[n]);
const outName = (n) => (n === 'README' ? 'index.html' : n + '.html');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const nav = (cur) => `<a href="index.html"${cur === 'README' ? ' class="on"' : ''}>Overview</a>` + GROUPS.map(([g, ns]) => `<h4>${g}</h4>` + ns.filter((n) => pages[n]).map((n) => `<a href="${outName(n)}"${n === cur ? ' class="on"' : ''}>${esc(pages[n].title.replace(/^AUREN\s*[:\-–]?\s*/i, '') || pages[n].title)}</a>`).join('')).join('');

for (const [name, p] of Object.entries(pages)) {
  const i = ORDER.indexOf(name), prev = ORDER[i - 1], next = ORDER[i + 1];
  const pn = '<div class="pn">' + (prev ? `<a href="${outName(prev)}"><small>Previous</small>${esc(pages[prev].title)}</a>` : '<span></span>') + (next ? `<a class="next" href="${outName(next)}"><small>Next</small>${esc(pages[next].title)}</a>` : '') + '</div>';
  const toc = p.headings.filter((h) => h.lvl === 2).map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join('');
  fs.writeFileSync(path.join(out, outName(name)), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)} · AUREN docs</title>
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="icon" href="../favicon.ico" sizes="any">
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header class="nav"><div class="wrap">
  <a class="brand" href="../index.html"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" fill="none" stroke="#e8b84a" stroke-width="5"/><path d="M19 44 L32 17 L45 44" fill="none" stroke="#e8b84a" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M25 36.5 H39" stroke="#e8b84a" stroke-width="5" stroke-linecap="round"/></svg>AUREN</a>
  <nav class="nav-links"><a href="../index.html">Home</a><a href="index.html" aria-current="page">Docs</a><a href="../explorer.html">Explorer</a><a href="../run-a-node.html">Run a node</a><a class="btn small primary" href="../wallet.html">Wallet</a></nav>
</div></header>
<div class="wrap docs">
  <aside class="docs-nav"><input type="search" id="dsearch" placeholder="Search the docs" autocomplete="off" aria-label="Search the docs"><div id="dresults" hidden></div><div id="dnav">${nav(name)}</div></aside>
  <article class="doc">
${p.html}
    ${pn}
    <p class="muted" style="margin-top:28px"><a href="${GH}docs/${name}.md">Edit this page on GitHub</a></p>
  </article>
  <aside class="docs-toc">${toc ? '<h4>On this page</h4>' + toc : ''}</aside>
</div>
<script src="docs.js"></script>
</body>
</html>
`);
}
const strip = (h) => h.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
fs.writeFileSync(path.join(out, 'search.json'), JSON.stringify(Object.entries(pages).map(([n, p]) => ({ u: outName(n), t: p.title, h: p.headings.map((h) => h.text).join(' | '), x: strip(p.html).slice(0, 6000) }))));
fs.copyFileSync(path.join(__dirname, 'docs-client.js'), path.join(out, 'docs.js'));
console.log(`wrote ${Object.keys(pages).length} pages to website/docs`);

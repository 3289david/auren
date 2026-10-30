#!/usr/bin/env node
'use strict';
// Health check for a real deployment: do these nodes run the same chain, and do they agree?
//   node scripts/verify-network.js http://host1:9650 http://host2:9650 ...
// Checks genesis hash, chain ID, block hash + state root at a common height, finality certificates,
// validator concentration. Exit code 0 only if everything agrees.
const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (urls.length < 1) { console.error('usage: verify-network <rpc url> [<rpc url> ...]'); process.exit(2); }

const get = async (u, p) => { const r = await fetch(u.replace(/\/$/, '') + p, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
let failed = false;
const bad = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

(async () => {
  const st = [];
  for (const u of urls) {
    try { st.push({ u, s: await get(u, '/status') }); ok(`${u} reachable: ${st[st.length - 1].s.chainId} height ${st[st.length - 1].s.height}, ${st[st.length - 1].s.peers} peers`); } catch (e) { bad(`${u} unreachable (${e.message})`); }
  }
  if (!st.length) process.exit(1);
  const g = new Set(st.map((x) => x.s.genesisHash));
  g.size === 1 ? ok(`all nodes share genesis ${[...g][0].slice(0, 16)}…`) : bad(`genesis hashes differ: ${[...g].join(', ')}`);
  const c = new Set(st.map((x) => x.s.chainId));
  c.size === 1 ? ok(`chain id ${[...c][0]}`) : bad('chain ids differ');

  const common = Math.min(...st.map((x) => x.s.height)) - 1;
  if (common >= 1) {
    const blocks = await Promise.all(st.map((x) => get(x.u, `/block/${common}`)));
    new Set(blocks.map((b) => b.hash)).size === 1 ? ok(`block ${common} identical on all nodes`) : bad(`block ${common} DIFFERS between nodes`);
    new Set(blocks.map((b) => b.header.stateRoot)).size === 1 ? ok('state roots identical') : bad('state roots differ');
    const votes = blocks[0].commit ? blocks[0].commit.votes.length : 0;
    votes > 0 ? ok(`block ${common} finality certificate has ${votes} signatures`) : bad('missing finality certificate');
  }
  const tips = st.map((x) => x.s.height);
  const spread = Math.max(...tips) - Math.min(...tips);
  spread <= 3 ? ok(`height spread ${spread} blocks`) : bad(`height spread ${spread} blocks (some node is far behind)`);

  const k = st[0].s.concentration;
  console.log(`\n  validators ${k.activeValidators} · Nakamoto: ${k.halt33} can halt finality, ${k.control67} can finalize alone`);
  if (k.activeValidators < 4) bad('fewer than 4 active validators');
  console.log(failed ? '\nNETWORK CHECK FAILED' : '\nNETWORK CHECK PASSED');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e.message); process.exit(1); });

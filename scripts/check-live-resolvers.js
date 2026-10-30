#!/usr/bin/env node
'use strict';
// Exercises the ENS and DNS adapters against REAL third-party services (needs internet).
//   node scripts/check-live-resolvers.js [--eth-rpc https://...] [--name vitalik.eth]
const ANR = require('../website/anr.js');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const rpcs = [arg('eth-rpc'), 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'].filter(Boolean);
const name = arg('name', 'vitalik.eth');
let failed = false;

(async () => {
  let done = false;
  for (const rpc of rpcs) {
    try {
      const r = await ANR.ensResolve(name, rpc);
      if (r.address) { console.log(`ENS  ${name} -> ${r.address}   (via ${rpc})`); done = true; break; }
      console.log(`ENS  ${name}: no address from ${rpc}`);
    } catch (e) { console.log(`ENS  ${rpc} failed: ${e.message}`); }
  }
  if (!done) failed = true;

  for (const domain of ['example.com', 'ietf.org']) {
    try {
      const r = await ANR.dnsResolve(domain);
      console.log(`DNS  _auren.${domain}: ${r.records.length} ANR1 record(s), DNSSEC-validated answer: ${r.dnssec}`);
    } catch (e) { console.log(`DNS  ${domain} failed: ${e.message}`); failed = true; }
  }
  console.log(failed ? '\nSOME LIVE CHECKS FAILED' : '\nLIVE CHECKS PASSED');
  process.exitCode = failed ? 1 : 0;
})();

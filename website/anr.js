'use strict';
// ANR-1 client: verifiable name resolution + a universal resolver that refuses to guess.
// Works in browsers and in Node (tests). Depends on aurlib.js. See docs/name-resolution.md.
(function (root) {
  const A = typeof module !== 'undefined' && module.exports ? require('./aurlib.js') : root.Aur;
  const enc = new TextEncoder();
  const AUR = 1000000000n;

  // ------------------------------------------------------------------ Merkle + light-client verification
  const leafHash = async (ns, key, value) => A.hex(await A.sha256(enc.encode(A.canon([ns, key, value]))));
  async function merkleOk(leafHex, steps, rootHex) {
    let cur = A.unhex(leafHex);
    for (const s of steps) {
      const sib = A.unhex(s.hash);
      cur = await A.sha256(s.pos === 'L' ? Uint8Array.from([...sib, ...cur]) : Uint8Array.from([...cur, ...sib]));
    }
    return A.hex(cur) === rootHex;
  }
  const VOTE_TAG = 'AUREN/vote/v1\u0000'; // 'AUREN/vote/v1\0'
  const voteBytes = (chainId, v) => enc.encode(VOTE_TAG + A.canon({ chainId, type: 'precommit', height: v.height, round: v.round, blockHash: v.blockHash }));

  /**
   * Verify a resolution returned by aur_resolve without trusting the node.
   * trust: { chainId, validators: [{operator, consPub, power}] }  (the validator set the client already trusts)
   * Checks: header hash; record and validator-set Merkle proofs against header.stateRoot; the commit certificate
   * (> 2/3 of that validator set signed the header); that > 1/3 of the TRUSTED set also signed it (so a
   * fabricated validator set cannot pass); and that the name has not expired at that height.
   */
  async function verifyResolution(resp, trust) {
    const fail = (reason) => ({ ok: false, reason });
    try {
      const p = resp.proof, hd = p.block.header;
      if (hd.chainId !== trust.chainId) return fail('proof is for a different chain');
      if (A.hex(await A.sha256(enc.encode(A.canon(hd)))) !== p.block.hash) return fail('block hash does not match header');
      if (!(await merkleOk(await leafHash(p.validators.ns, p.validators.key, p.validators.value), p.validators.steps, hd.stateRoot))) return fail('validator-set proof invalid');
      if (!(await merkleOk(await leafHash(p.record.ns, p.record.key, p.record.value), p.record.steps, hd.stateRoot))) return fail('name-record proof invalid');
      const rec = p.record.value;
      // state key = the bare label for .aur, or "label.tld" for any other TLD
      const expectedKey = resp.name.endsWith('.aur') ? resp.name.slice(0, -4) : resp.name;
      if (p.record.key !== expectedKey || rec.target !== resp.target || rec.owner !== resp.owner) return fail('response does not match the proven record');
      if (!(rec.expiresAt > hd.height)) return fail('name expired at the proven height');

      const set = p.validators.value.map((v) => ({ ...v, power: BigInt(v.power) }));
      const byOp = new Map(set.map((v) => [v.operator, v]));
      const c = p.commit;
      if (!c || c.blockHash !== p.block.hash || c.height !== hd.height) return fail('commit does not match block');
      const seen = new Set();
      let power = 0n;
      for (const vt of c.votes) {
        const val = byOp.get(vt.validator);
        if (!val || seen.has(vt.validator)) return fail('commit has unknown or duplicate signer');
        if (!(await A.verify(val.consPub, voteBytes(trust.chainId, { height: c.height, round: c.round, blockHash: c.blockHash }), vt.sig))) return fail('commit has a bad signature');
        seen.add(vt.validator); power += val.power;
      }
      const total = set.reduce((s, v) => s + v.power, 0n);
      if (!(power * 3n > total * 2n)) return fail('commit lacks > 2/3 of voting power');

      const trusted = trust.validators.map((v) => ({ ...v, power: BigInt(v.power) }));
      const tTotal = trusted.reduce((s, v) => s + v.power, 0n);
      let overlap = 0n;
      for (const t of trusted) if (seen.has(t.operator) && byOp.get(t.operator).consPub === t.consPub) overlap += t.power;
      if (!(overlap * 3n > tTotal)) return fail('not enough of the validator set you trust signed this block (your trusted set is too old: re-sync it)');
      return { ok: true, height: hd.height, time: hd.time, signers: seen.size, validators: set };
    } catch (e) {
      return fail('malformed proof: ' + e.message);
    }
  }

  const DEFAULT_PARAMS = { maxValidators: 150, minSelfStake: 10000n * AUR, maxVotingPowerBps: 1000 }; // = src/params.js

  /** The validator set at genesis, computed exactly as the chain does (src/chain.js computeActiveSet). */
  function genesisValidatorSet(genesis) {
    const g = genesis.params || {};
    const minSelf = BigInt(g.minSelfStake ?? DEFAULT_PARAMS.minSelfStake);
    const maxV = g.maxValidators ?? DEFAULT_PARAMS.maxValidators, bps = g.maxVotingPowerBps ?? DEFAULT_PARAMS.maxVotingPowerBps;
    const vals = genesis.validators.map((v) => ({ operator: v.operator, consPub: v.consPub, tokens: BigInt(v.selfStake) })).filter((v) => v.tokens >= minSelf);
    vals.sort((a, b) => (a.tokens > b.tokens ? -1 : a.tokens < b.tokens ? 1 : a.operator < b.operator ? -1 : 1));
    const top = vals.slice(0, maxV);
    const total = top.reduce((s, v) => s + v.tokens, 0n);
    const cap = bps >= 10000 ? null : (total * BigInt(bps)) / 10000n;
    return top.map((v) => ({ operator: v.operator, consPub: v.consPub, power: String(cap !== null && v.tokens > cap ? cap : v.tokens) }));
  }

  /**
   * Tracks a trusted validator set for one AUREN network. Starts from the genesis (checked against a pinned
   * genesis hash when you have one) and advances only through verified proofs.
   */
  class LightClient {
    constructor({ rpc, label, pinnedGenesisHash = null, storage = null }) { this.rpc = rpc; this.label = label || rpc.url; this.pinned = pinnedGenesisHash; this.storage = storage; this.trust = null; }
    async init() {
      const genesis = await this.rpc.get('/genesis');
      const hash = A.hex(await A.sha256(enc.encode(A.canon(genesis))));
      if (this.pinned && hash !== this.pinned) throw new Error(`genesis hash ${hash.slice(0, 12)}… does not match the pinned ${this.pinned.slice(0, 12)}…: wrong network or a lying node`);
      this.genesisHash = hash; this.chainId = genesis.chainId; this.isPinned = !!this.pinned;
      const key = `anr.trust.${hash}`;
      let saved = null;
      try { saved = this.storage && JSON.parse(this.storage.getItem(key)); } catch { saved = null; }
      this.trust = saved || { chainId: genesis.chainId, height: 0, validators: genesisValidatorSet(genesis) };
      this._key = key;
      return this;
    }
    _save() { try { this.storage && this.storage.setItem(this._key, JSON.stringify(this.trust)); } catch { /* storage unavailable */ } }
    /** Resolve and verify. Returns { found, verified, reason?, ... } */
    async resolve(name) {
      if (!this.trust) await this.init();
      const resp = await this.rpc.call('aur_resolve', [name]);
      if (!resp) return { found: false };
      if (resp.genesisHash !== this.genesisHash) return { found: true, verified: false, reason: 'node answered for a different network', resp };
      const v = await verifyResolution(resp, this.trust);
      if (v.ok && v.height > this.trust.height) { this.trust = { chainId: this.trust.chainId, height: v.height, validators: v.validators.map((x) => ({ operator: x.operator, consPub: x.consPub, power: String(x.power) })) }; this._save(); }
      return { found: true, verified: v.ok, reason: v.reason, height: v.height, time: v.time, resp };
    }
  }

  // ------------------------------------------------------------------ Keccak-256 + ENS
  const M64 = (1n << 64n) - 1n;
  const RC = [0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n];
  const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
  function keccakF(a) {
    for (let r = 0; r < 24; r++) {
      const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
      const d = [0, 1, 2, 3, 4].map((x) => c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1));
      const b = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y] ^ d[x], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
      a[0] ^= RC[r];
    }
  }
  /** Keccak-256 (the Ethereum hash, NOT NIST SHA3-256: different padding). */
  function keccak256(bytes) {
    const rate = 136, a = new Array(25).fill(0n);
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) { let lane = 0n; for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]); a[i] ^= lane; }
      keccakF(a);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) { let lane = a[i]; for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; } }
    return out;
  }
  function namehash(name) {
    let node = new Uint8Array(32);
    if (name) for (const label of name.split('.').reverse()) node = keccak256(Uint8Array.from([...node, ...keccak256(enc.encode(label))]));
    return node;
  }
  const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
  async function ensResolve(name, ethRpc, fetchFn = fetch) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/.test(name)) return { error: 'only plain ASCII .eth names are supported (no UTS-46 normalization, no CCIP-Read)' };
    const call = async (to, data) => {
      const r = await fetchFn(ethRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
    };
    const node = A.hex(namehash(name));
    const resolverWord = await call(ENS_REGISTRY, '0x0178b8bf' + node);
    const resolver = '0x' + resolverWord.slice(-40);
    if (/^0x0{40}$/.test(resolver)) return { address: null };
    const addrWord = await call(resolver, '0x3b3b57de' + node);
    const addr = '0x' + addrWord.slice(-40);
    return { address: /^0x0{40}$/.test(addr) ? null : addr };
  }

  // ------------------------------------------------------------------ DNS (DoH) bridge
  /** A domain publishes `_auren.<domain>  TXT  "v=ANR1 aur:<chainId>=<address>"`. DNSSEC-validated (AD) answers are marked. */
  async function dnsResolve(domain, doh = 'https://cloudflare-dns.com/dns-query', fetchFn = fetch) {
    const r = await fetchFn(`${doh}?name=${encodeURIComponent('_auren.' + domain)}&type=TXT`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const out = [];
    for (const ans of j.Answer || []) {
      const txt = String(ans.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, '');
      if (!txt.startsWith('v=ANR1')) continue;
      for (const part of txt.split(/\s+/).slice(1)) { const m = /^(aur:[A-Za-z0-9-]{1,32})=([a-z0-9]{20,100})$/.exec(part); if (m) out.push({ namespace: m[1], address: m[2] }); }
    }
    return { records: out, dnssec: !!j.AD };
  }

  // ------------------------------------------------------------------ the universal resolver
  /**
   * Resolves a name through every namespace that could own it, labels each answer with where it came from and
   * how it was verified, and returns a decision:
   *   verified   one address, every source proven (AUREN light client / DNSSEC)
   *   unverified one address but at least one source is only a node's or provider's word
   *   ambiguous  different namespaces answer with different addresses: NEVER pick one silently
   *   notfound   nothing resolved
   * Names may be namespace-qualified: "alice.aur@auren-mainnet-1" restricts resolution to that namespace.
   */
  class UniversalResolver {
    /** @param {{auren: LightClient[], ensRpc?: string, doh?: string, fetchFn?: Function, addressPrefix: string, chainId: string}} o */
    constructor(o) { this.o = { doh: 'https://cloudflare-dns.com/dns-query', fetchFn: (...a) => fetch(...a), ...o }; }

    async resolve(input) {
      const raw = String(input).trim().toLowerCase();
      const [name, only] = raw.split('@');
      const cands = [], notes = [];
      const tld = name.includes('.') ? name.split('.').pop() : '';

      // Any non-.eth name is looked up on AUREN first (".aur" and every user-created TLD live there); DNS is the fallback.
      if (tld && tld !== 'eth') {
        for (const lc of this.o.auren) {
          try {
            await (lc.trust ? null : lc.init());
            if (only && only !== lc.chainId) continue;
            const r = await lc.resolve(name);
            if (!r.found) { if (tld === 'aur') notes.push(`${lc.chainId}: not registered`); continue; }
            cands.push({ source: 'auren', namespace: lc.chainId, name, address: r.resp.target, owner: r.resp.owner, records: r.resp.records,
              verified: r.verified ? 'light-client' : 'node-claim', pinned: lc.isPinned, height: r.height, why: r.reason });
          } catch (e) { notes.push(`${lc.label}: ${e.message}`); }
        }
      }
      if (tld === 'eth' && this.o.ensRpc && (!only || only === 'eip155:1')) {
        try { const r = await ensResolve(name, this.o.ensRpc, this.o.fetchFn); if (r.address) cands.push({ source: 'ens', namespace: 'eip155:1', name, address: r.address, verified: 'rpc-claim' }); else notes.push(r.error || 'ENS: no address record'); } catch (e) { notes.push('ENS: ' + e.message); }
      }
      if (tld && tld !== 'aur' && tld !== 'eth' && !cands.length) {
        try {
          const r = await dnsResolve(name, this.o.doh, this.o.fetchFn);
          for (const x of r.records) if (!only || only === x.namespace) cands.push({ source: 'dns', namespace: x.namespace, name, address: x.address, verified: r.dnssec ? 'dnssec' : 'dns-unsigned' });
          if (!r.records.length) notes.push('DNS: no _auren TXT record');
        } catch (e) { notes.push('DNS: ' + e.message); }
      }

      // addresses that can receive AUR on the connected network (anything else is cross-chain information only)
      const sendable = cands.filter((c) => (c.source === 'auren' && c.namespace === this.o.chainId) || (c.namespace === `aur:${this.o.chainId}`)).filter((c) => A.isValidAddress(c.address, this.o.addressPrefix));
      const distinct = new Set(cands.filter((c) => c.source !== 'ens').map((c) => c.namespace + '|' + c.address));
      const sameName = cands.filter((c) => c.source === 'auren');
      const ambiguous = new Set(sameName.map((c) => c.address)).size > 1 || (sendable.length > 1 && new Set(sendable.map((c) => c.address)).size > 1);
      let status;
      if (!cands.length) status = 'notfound';
      else if (ambiguous) status = 'ambiguous';
      else if (sendable.length && sendable.every((c) => ['light-client', 'dnssec'].includes(c.verified))) status = 'verified';
      else status = 'unverified';
      void distinct;
      return { input: raw, status, candidates: cands, sendable, notes, address: status === 'verified' || status === 'unverified' ? (sendable[0] && sendable[0].address) || null : null };
    }
  }

  const ANR = { verifyResolution, genesisValidatorSet, LightClient, UniversalResolver, keccak256, namehash, ensResolve, dnsResolve, merkleOk, leafHash };
  if (typeof module !== 'undefined' && module.exports) module.exports = ANR; else root.ANR = ANR;
})(typeof window !== 'undefined' ? window : globalThis);

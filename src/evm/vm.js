'use strict';
// Ethereum Virtual Machine, Shanghai rules (EIP-2929 access lists, EIP-2200/3529 SSTORE and refunds, EIP-3541,
// EIP-3651 warm coinbase, EIP-3855 PUSH0, EIP-3860 initcode limits). Written from the yellow paper and the EIPs;
// verified by differential testing against the reference @ethereumjs/evm (test/evm.diff in the repo's docs).
const crypto = require('node:crypto');
const { keccak256 } = require('./keccak');
const rlp = require('./rlp');
const { recover } = require('./secp256k1');
const { EvmState, EMPTY } = require('./state');

const MOD = 1n << 256n, MASK = MOD - 1n, SIGN = 1n << 255n;
const ADDR_MASK = (1n << 160n) - 1n;
const toS = (x) => (x >= SIGN ? x - MOD : x);
const toU = (x) => x & MASK;
const addrOf = (x) => (x & ADDR_MASK).toString(16).padStart(40, '0');
const bigOf = (addr) => BigInt('0x' + addr);
const wordsOf = (n) => Math.ceil(n / 32);
const MAX_CODE = 24576, MAX_INITCODE = 49152, MAX_DEPTH = 1024;

class VmError extends Error {}

const memCostFor = (w) => 3 * w + Math.floor((w * w) / 512);

function jumpdests(code) {
  const d = new Uint8Array(code.length);
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op === 0x5b) d[i] = 1;
    else if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return d;
}

function createAddress(sender, nonce) {
  return keccak256(rlp.encode([Buffer.from(sender, 'hex'), nonce])).subarray(12).toString('hex');
}
function create2Address(sender, salt, initcode) {
  return keccak256(Buffer.concat([Buffer.from([0xff]), Buffer.from(sender, 'hex'), Buffer.from(salt.toString(16).padStart(64, '0'), 'hex'), keccak256(initcode)])).subarray(12).toString('hex');
}

// ---------------------------------------------------------------- precompiles (1-4 implemented)
const padRight = (b, n) => (b.length >= n ? b.subarray(0, n) : Buffer.concat([b, Buffer.alloc(n - b.length)]));
const PRECOMPILES = {
  1: (input, gas) => {
    if (gas < 3000) return { ok: false, gasUsed: gas };
    const d = padRight(input, 128);
    const v = BigInt('0x' + d.subarray(32, 64).toString('hex'));
    const r = BigInt('0x' + d.subarray(64, 96).toString('hex')), s = BigInt('0x' + d.subarray(96, 128).toString('hex'));
    let out = EMPTY;
    if (v === 27n || v === 28n) {
      const pub = recover(d.subarray(0, 32), r, s, Number(v - 27n));
      if (pub) out = Buffer.concat([Buffer.alloc(12), keccak256(pub).subarray(12)]);
    }
    return { ok: true, gasUsed: 3000, out };
  },
  2: (input, gas) => {
    const c = 60 + 12 * wordsOf(input.length);
    if (gas < c) return { ok: false, gasUsed: gas };
    return { ok: true, gasUsed: c, out: crypto.createHash('sha256').update(input).digest() };
  },
  3: (input, gas) => {
    const c = 600 + 120 * wordsOf(input.length);
    if (gas < c) return { ok: false, gasUsed: gas };
    let h;
    try { h = crypto.createHash('ripemd160').update(input).digest(); } catch { return { ok: false, gasUsed: gas }; }
    return { ok: true, gasUsed: c, out: Buffer.concat([Buffer.alloc(12), h]) };
  },
  4: (input, gas) => {
    const c = 15 + 3 * wordsOf(input.length);
    if (gas < c) return { ok: false, gasUsed: gas };
    return { ok: true, gasUsed: c, out: Buffer.from(input) };
  },
};
// modexp (EIP-2565 pricing)
PRECOMPILES[5] = (input, gas) => {
  const d = padRight(input, 96);
  const bl = BigInt('0x' + d.subarray(0, 32).toString('hex')), el = BigInt('0x' + d.subarray(32, 64).toString('hex')), ml = BigInt('0x' + d.subarray(64, 96).toString('hex'));
  const body = input.length > 96 ? input.subarray(96) : EMPTY;
  const get = (off, len) => { const out = Buffer.alloc(Number(len)); if (off < BigInt(body.length)) body.copy(out, 0, Number(off), Math.min(body.length, Number(off) + Number(len))); return out; };
  const eHead = BigInt('0x' + (padRight(get(bl, el < 32n ? el : 32n), 32).toString('hex') || '0'));
  const bitlen = (x) => (x === 0n ? 0 : x.toString(2).length);
  let iter;
  if (el <= 32n) iter = eHead === 0n ? 0n : BigInt(bitlen(eHead) - 1);
  else iter = 8n * (el - 32n) + (eHead === 0n ? 0n : BigInt(bitlen(eHead) - 1));
  if (iter < 1n) iter = 1n;
  const words = ((bl > ml ? bl : ml) + 7n) / 8n;
  let cost = (words * words * iter) / 3n;
  if (cost < 200n) cost = 200n;
  if (cost > BigInt(gas)) return { ok: false, gasUsed: gas };
  if (bl === 0n && ml === 0n) return { ok: true, gasUsed: Number(cost), out: EMPTY };
  const B = BigInt('0x' + (get(0n, bl).toString('hex') || '0')), E = BigInt('0x' + (get(bl, el).toString('hex') || '0')), M = BigInt('0x' + (get(bl + el, ml).toString('hex') || '0'));
  let r = 0n;
  if (M !== 0n) { r = 1n % M; let b = B % M, e = E; while (e > 0n) { if (e & 1n) r = (r * b) % M; b = (b * b) % M; e >>= 1n; } }
  const out = Buffer.from(r.toString(16).padStart(Number(ml) * 2, '0').slice(-Number(ml) * 2 || undefined) || '', 'hex');
  return { ok: true, gasUsed: Number(cost), out: ml === 0n ? EMPTY : Buffer.concat([Buffer.alloc(Math.max(0, Number(ml) - out.length)), out]) };
};

// blake2f compression function (EIP-152)
const B2_IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const B2_SIGMA = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3], [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8], [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9], [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10], [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0]];
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
PRECOMPILES[9] = (input, gas) => {
  if (input.length !== 213 || (input[212] !== 0 && input[212] !== 1)) return { ok: false, gasUsed: gas };
  const rounds = input.readUInt32BE(0);
  if (gas < rounds) return { ok: false, gasUsed: gas };
  const h = [], m = [];
  for (let i = 0; i < 8; i++) h.push(input.readBigUInt64LE(4 + i * 8));
  for (let i = 0; i < 16; i++) m.push(input.readBigUInt64LE(68 + i * 8));
  const t0 = input.readBigUInt64LE(196), t1 = input.readBigUInt64LE(204);
  const v = [...h, ...B2_IV];
  v[12] ^= t0; v[13] ^= t1;
  if (input[212] === 1) v[14] ^= M64;
  const G = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & M64; v[d] = rotr64(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & M64; v[b] = rotr64(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & M64; v[d] = rotr64(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & M64; v[b] = rotr64(v[b] ^ v[c], 63);
  };
  for (let r = 0; r < rounds; r++) {
    const s = B2_SIGMA[r % 10];
    G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]]); G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]]);
    G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]]); G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i] ^ v[i] ^ v[i + 8], i * 8);
  return { ok: true, gasUsed: rounds, out };
};

const PRECOMPILE_RANGE = [1, 2, 3, 4, 5, 6, 7, 8, 9]; // 5-9 (modexp, bn254, blake2f) are reserved but unsupported: they fail

class VM {
  /**
   * @param {EvmState} state
   * @param {object} ctx { coinbase(hex40), timestamp, number, prevrandao(bigint), gasLimit, chainId, baseFee(wei bigint),
   *                       blockhash(n)->bigint, origin(hex40), gasPrice(wei bigint) }
   */
  constructor(state, ctx) { this.state = state; this.ctx = ctx; }

  // ------------------------------------------------------------ message layer
  _transfer(from, to, v) {
    if (v === 0n) return;
    const st = this.state;
    st.setBalance(from, st.getBalance(from) - v);
    st.setBalance(to, st.getBalance(to) + v);
  }

  /** CALL / CALLCODE / DELEGATECALL / STATICCALL */
  _call(m) {
    const st = this.state;
    const cp = st.checkpoint();
    if (m.kind === 'CALL') this._transfer(m.caller, m.address, m.value);
    const pc = BigInt('0x' + m.codeAddr) < 10n ? Number(BigInt('0x' + m.codeAddr)) : 0;
    let res;
    if (pc > 0) {
      const p = PRECOMPILES[pc];
      if (!p) res = { ok: false, gasLeft: 0, ret: EMPTY, reason: 'unsupported precompile' };
      else { const r = p(m.data, m.gas); res = r.ok ? { ok: true, gasLeft: m.gas - r.gasUsed, ret: r.out } : { ok: false, gasLeft: 0, ret: EMPTY, reason: 'oog' }; }
    } else {
      const code = st.getCode(m.codeAddr);
      if (code.length === 0) res = { ok: true, gasLeft: m.gas, ret: EMPTY };
      else res = this._run({ code, address: m.address, caller: m.caller, value: m.apparentValue, data: m.data, gas: m.gas, depth: m.depth, static: m.static });
    }
    if (!res.ok) st.revert(cp);
    return { success: res.ok, gasLeft: res.ok || res.reason === 'revert' ? res.gasLeft : 0, returnData: res.ok || res.reason === 'revert' ? res.ret : EMPTY };
  }

  /** CREATE / CREATE2 / top-level contract creation. m.address may be preset (top-level); then the nonce was already bumped. */
  _create(m) {
    const st = this.state;
    let addr = m.address;
    if (!addr) {
      const nonce = st.getNonce(m.caller);
      addr = m.kind === 'CREATE2' ? create2Address(m.caller, m.salt, m.initcode) : createAddress(m.caller, nonce);
      st.setNonce(m.caller, nonce + 1);
    }
    st.warmAddress(addr);
    if (st.getNonce(addr) !== 0 || st.getCode(addr).length > 0) return { success: false, gasLeft: 0, returnData: EMPTY, address: addr };
    const cp = st.checkpoint();
    st.clearStorage(addr);
    st.markCreated(addr);
    st.setNonce(addr, 1);
    this._transfer(m.caller, addr, m.value);
    const r = this._run({ code: m.initcode, address: addr, caller: m.caller, value: m.value, data: EMPTY, gas: m.gas, depth: m.depth, static: false });
    let gasLeft = r.gasLeft;
    if (r.ok) {
      const code = r.ret;
      const deposit = 200 * code.length;
      if (code.length > MAX_CODE || (code.length > 0 && code[0] === 0xef) || gasLeft < deposit) { st.revert(cp); return { success: false, gasLeft: 0, returnData: EMPTY, address: addr }; }
      gasLeft -= deposit;
      st.setCode(addr, Buffer.from(code));
      return { success: true, gasLeft, returnData: EMPTY, address: addr };
    }
    st.revert(cp);
    const rev = r.reason === 'revert';
    return { success: false, gasLeft: rev ? gasLeft : 0, returnData: rev ? r.ret : EMPTY, address: addr };
  }

  // ------------------------------------------------------------ interpreter
  _run(f) {
    const st = this.state, ctx = this.ctx, code = f.code;
    const jd = jumpdests(code);
    const stack = [];
    let mem = Buffer.alloc(0), memWords = 0, pc = 0, gas = f.gas, ret = EMPTY;

    const use = (n) => { gas -= n; if (gas < 0) throw new VmError('out of gas'); };
    const push = (v) => { if (stack.length >= 1024) throw new VmError('stack overflow'); stack.push(v); };
    const pop = () => { if (stack.length === 0) throw new VmError('stack underflow'); return stack.pop(); };
    const num = (b) => { if (b > 0xffffffffn) throw new VmError('out of gas'); return Number(b); };
    const chargeMem = (off, size) => {
      if (size === 0n) return;
      if (off + size > 0xffffffffn) throw new VmError('out of gas');
      const words = wordsOf(Number(off + size));
      if (words > memWords) {
        use(memCostFor(words) - memCostFor(memWords));
        const nm = Buffer.alloc(words * 32); mem.copy(nm); mem = nm; memWords = words;
      }
    };
    const slice = (off, size) => (size === 0n ? EMPTY : Buffer.from(mem.subarray(Number(off), Number(off + size))));
    const readData = (src, off, size) => { // zero-padded read
      const out = Buffer.alloc(size);
      if (off < BigInt(src.length)) src.copy(out, 0, Number(off), Math.min(src.length, Number(off) + size));
      return out;
    };
    const unit = ctx.valueUnit || 1n; // value must be a multiple of the chain's smallest unit (1 spark = 1e9 wei)
    const accessAddr = (addr) => use(st.warmAddress(addr) ? 100 : 2600);
    const copyCost = (size) => 3 * wordsOf(num(size));

    while (true) {
      if (pc >= code.length) return { ok: true, gasLeft: gas, ret: EMPTY };
      const op = code[pc];
      pc++;

      if (op >= 0x60 && op <= 0x7f) { // PUSH1..32
        use(3);
        const n = op - 0x5f;
        let v = 0n;
        for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(pc + i < code.length ? code[pc + i] : 0);
        push(v); pc += n; continue;
      }
      if (op >= 0x80 && op <= 0x8f) { use(3); const n = op - 0x7f; if (stack.length < n) throw new VmError('stack underflow'); push(stack[stack.length - n]); continue; }
      if (op >= 0x90 && op <= 0x9f) { use(3); const n = op - 0x8f; if (stack.length <= n) throw new VmError('stack underflow'); const i = stack.length - 1, j = i - n; [stack[i], stack[j]] = [stack[j], stack[i]]; continue; }

      switch (op) {
        case 0x00: return { ok: true, gasLeft: gas, ret: EMPTY };
        case 0x01: { use(3); push(toU(pop() + pop())); break; }
        case 0x02: { use(5); push(toU(pop() * pop())); break; }
        case 0x03: { use(3); const a = pop(), b = pop(); push(toU(a - b)); break; }
        case 0x04: { use(5); const a = pop(), b = pop(); push(b === 0n ? 0n : a / b); break; }
        case 0x05: { use(5); const a = toS(pop()), b = toS(pop()); push(b === 0n ? 0n : toU(a / b)); break; }
        case 0x06: { use(5); const a = pop(), b = pop(); push(b === 0n ? 0n : a % b); break; }
        case 0x07: { use(5); const a = toS(pop()), b = toS(pop()); push(b === 0n ? 0n : toU(a % b)); break; }
        case 0x08: { use(8); const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a + b) % n); break; }
        case 0x09: { use(8); const a = pop(), b = pop(), n = pop(); push(n === 0n ? 0n : (a * b) % n); break; }
        case 0x0a: {
          const a = pop(), e = pop();
          let bytes = 0; for (let t = e; t > 0n; t >>= 8n) bytes++;
          use(10 + 50 * bytes);
          let r = 1n, base = a, x = e;
          while (x > 0n) { if (x & 1n) r = (r * base) & MASK; base = (base * base) & MASK; x >>= 1n; }
          push(r); break;
        }
        case 0x0b: {
          use(5); const b = pop(); let x = pop();
          if (b < 31n) { const bit = b * 8n + 7n, m = 1n << bit; x = x & ((m << 1n) - 1n); if (x & m) x = toU(x | (MASK ^ ((m << 1n) - 1n))); }
          push(x); break;
        }
        case 0x10: { use(3); const a = pop(), b = pop(); push(a < b ? 1n : 0n); break; }
        case 0x11: { use(3); const a = pop(), b = pop(); push(a > b ? 1n : 0n); break; }
        case 0x12: { use(3); const a = toS(pop()), b = toS(pop()); push(a < b ? 1n : 0n); break; }
        case 0x13: { use(3); const a = toS(pop()), b = toS(pop()); push(a > b ? 1n : 0n); break; }
        case 0x14: { use(3); push(pop() === pop() ? 1n : 0n); break; }
        case 0x15: { use(3); push(pop() === 0n ? 1n : 0n); break; }
        case 0x16: { use(3); push(pop() & pop()); break; }
        case 0x17: { use(3); push(pop() | pop()); break; }
        case 0x18: { use(3); push(pop() ^ pop()); break; }
        case 0x19: { use(3); push(MASK ^ pop()); break; }
        case 0x1a: { use(3); const i = pop(), x = pop(); push(i >= 32n ? 0n : (x >> (8n * (31n - i))) & 0xffn); break; }
        case 0x1b: { use(3); const s = pop(), v = pop(); push(s >= 256n ? 0n : toU(v << s)); break; }
        case 0x1c: { use(3); const s = pop(), v = pop(); push(s >= 256n ? 0n : v >> s); break; }
        case 0x1d: { use(3); const s = pop(), v = pop(); const sv = toS(v); push(s >= 256n ? (sv < 0n ? MASK : 0n) : toU(sv >> s)); break; }
        case 0x20: {
          const off = pop(), size = pop();
          use(30 + 6 * wordsOf(num(size))); chargeMem(off, size);
          push(BigInt('0x' + keccak256(slice(off, size)).toString('hex'))); break;
        }
        case 0x30: { use(2); push(bigOf(f.address)); break; }
        case 0x31: { const a = addrOf(pop()); accessAddr(a); push(st.getBalance(a)); break; }
        case 0x32: { use(2); push(bigOf(ctx.origin)); break; }
        case 0x33: { use(2); push(bigOf(f.caller)); break; }
        case 0x34: { use(2); push(f.value); break; }
        case 0x35: { use(3); const o = pop(); push(o >= BigInt(f.data.length) ? 0n : BigInt('0x' + readData(f.data, o, 32).toString('hex'))); break; }
        case 0x36: { use(2); push(BigInt(f.data.length)); break; }
        case 0x37: { const d = pop(), o = pop(), s = pop(); use(3 + copyCost(s)); chargeMem(d, s); if (s > 0n) readData(f.data, o, Number(s)).copy(mem, Number(d)); break; }
        case 0x38: { use(2); push(BigInt(code.length)); break; }
        case 0x39: { const d = pop(), o = pop(), s = pop(); use(3 + copyCost(s)); chargeMem(d, s); if (s > 0n) readData(code, o, Number(s)).copy(mem, Number(d)); break; }
        case 0x3a: { use(2); push(ctx.gasPrice); break; }
        case 0x3b: { const a = addrOf(pop()); accessAddr(a); push(BigInt(st.getCode(a).length)); break; }
        case 0x3c: {
          const a = addrOf(pop()), d = pop(), o = pop(), s = pop();
          accessAddr(a); use(copyCost(s)); chargeMem(d, s);
          if (s > 0n) readData(st.getCode(a), o, Number(s)).copy(mem, Number(d)); break;
        }
        case 0x3d: { use(2); push(BigInt(ret.length)); break; }
        case 0x3e: {
          const d = pop(), o = pop(), s = pop();
          use(3 + copyCost(s)); chargeMem(d, s);
          if (o + s > BigInt(ret.length)) throw new VmError('return data out of bounds');
          if (s > 0n) ret.copy(mem, Number(d), Number(o), Number(o + s)); break;
        }
        case 0x3f: {
          const a = addrOf(pop()); accessAddr(a);
          push(st.isEmpty(a) ? 0n : BigInt('0x' + keccak256(st.getCode(a)).toString('hex'))); break;
        }
        case 0x40: { use(20); const n = pop(); push(ctx.blockhash(n)); break; }
        case 0x41: { use(2); push(bigOf(ctx.coinbase)); break; }
        case 0x42: { use(2); push(BigInt(ctx.timestamp)); break; }
        case 0x43: { use(2); push(BigInt(ctx.number)); break; }
        case 0x44: { use(2); push(ctx.prevrandao); break; }
        case 0x45: { use(2); push(BigInt(ctx.gasLimit)); break; }
        case 0x46: { use(2); push(BigInt(ctx.chainId)); break; }
        case 0x47: { use(5); push(st.getBalance(f.address)); break; }
        case 0x48: { use(2); push(ctx.baseFee); break; }
        case 0x50: { use(2); pop(); break; }
        case 0x51: { use(3); const o = pop(); chargeMem(o, 32n); push(BigInt('0x' + mem.subarray(Number(o), Number(o) + 32).toString('hex'))); break; }
        case 0x52: { use(3); const o = pop(), v = pop(); chargeMem(o, 32n); Buffer.from(v.toString(16).padStart(64, '0'), 'hex').copy(mem, Number(o)); break; }
        case 0x53: { use(3); const o = pop(), v = pop(); chargeMem(o, 1n); mem[Number(o)] = Number(v & 0xffn); break; }
        case 0x54: { const slot = pop(); use(st.warmSlot(f.address, slot) ? 100 : 2100); push(st.getStorage(f.address, slot)); break; }
        case 0x55: {
          if (f.static) throw new VmError('write in static context');
          if (gas <= 2300) throw new VmError('out of gas');
          const slot = pop(), val = pop();
          const cold = !st.warmSlot(f.address, slot);
          const cur = st.getStorage(f.address, slot), orig = st.getOriginalStorage(f.address, slot);
          let cost = cold ? 2100 : 0;
          if (cur === val) cost += 100;
          else if (orig === cur) { cost += orig === 0n ? 20000 : 2900; if (val === 0n) st.addRefund(4800); }
          else {
            cost += 100;
            if (orig !== 0n) { if (cur === 0n) st.addRefund(-4800); else if (val === 0n) st.addRefund(4800); }
            if (orig === val) st.addRefund(orig === 0n ? 19900 : 2800);
          }
          use(cost);
          if (cur !== val) st.setStorage(f.address, slot, val);
          break;
        }
        case 0x56: { use(8); const d = pop(); if (d >= BigInt(code.length) || !jd[Number(d)]) throw new VmError('invalid jump'); pc = Number(d); break; }
        case 0x57: { use(10); const d = pop(), c = pop(); if (c !== 0n) { if (d >= BigInt(code.length) || !jd[Number(d)]) throw new VmError('invalid jump'); pc = Number(d); } break; }
        case 0x58: { use(2); push(BigInt(pc - 1)); break; }
        case 0x59: { use(2); push(BigInt(memWords * 32)); break; }
        case 0x5a: { use(2); push(BigInt(gas)); break; }
        case 0x5b: { use(1); break; }
        case 0x5f: { use(2); push(0n); break; }
        case 0xa0: case 0xa1: case 0xa2: case 0xa3: case 0xa4: {
          if (f.static) throw new VmError('write in static context');
          const n = op - 0xa0, off = pop(), size = pop();
          const topics = []; for (let i = 0; i < n; i++) topics.push(pop().toString(16).padStart(64, '0'));
          use(375 + 375 * n + 8 * num(size)); chargeMem(off, size);
          st.addLog({ address: f.address, topics, data: slice(off, size) }); break;
        }
        case 0xf0: case 0xf5: {
          if (f.static) throw new VmError('write in static context');
          const value = pop(), off = pop(), size = pop(), salt = op === 0xf5 ? pop() : 0n;
          chargeMem(off, size);
          if (size > BigInt(MAX_INITCODE)) throw new VmError('initcode too large');
          const w = wordsOf(Number(size));
          use(32000 + 2 * w + (op === 0xf5 ? 6 * w : 0));
          const initcode = slice(off, size);
          if (f.depth >= MAX_DEPTH || st.getBalance(f.address) < value || value % unit !== 0n || st.getNonce(f.address) >= 0xffffffffffffffff) { push(0n); ret = EMPTY; break; }
          const callGas = gas - Math.floor(gas / 64);
          use(callGas);
          const r = this._create({ kind: op === 0xf5 ? 'CREATE2' : 'CREATE', caller: f.address, value, initcode, gas: callGas, depth: f.depth + 1, salt });
          gas += r.gasLeft; ret = r.success ? EMPTY : r.returnData;
          push(r.success ? bigOf(r.address) : 0n); break;
        }
        case 0xf1: case 0xf2: case 0xf4: case 0xfa: {
          const gasReq = pop(), to = addrOf(pop());
          const value = op === 0xf1 || op === 0xf2 ? pop() : 0n;
          const inOff = pop(), inSize = pop(), outOff = pop(), outSize = pop();
          accessAddr(to);
          chargeMem(inOff, inSize); chargeMem(outOff, outSize);
          if (value > 0n) {
            if (op === 0xf1 && f.static) throw new VmError('value transfer in static context');
            use(9000);
            if (op === 0xf1 && st.isEmpty(to)) use(25000);
          }
          const avail = gas - Math.floor(gas / 64);
          let callGas = gasReq > BigInt(avail) ? avail : Number(gasReq);
          use(callGas);
          if (value > 0n) callGas += 2300;
          const data = slice(inOff, inSize);
          if (f.depth >= MAX_DEPTH || (value > 0n && (st.getBalance(f.address) < value || value % unit !== 0n))) { gas += callGas; ret = EMPTY; push(0n); break; }
          let m;
          if (op === 0xf1) m = { kind: 'CALL', caller: f.address, address: to, codeAddr: to, value, apparentValue: value, static: f.static };
          else if (op === 0xf2) m = { kind: 'CALLCODE', caller: f.address, address: f.address, codeAddr: to, value, apparentValue: value, static: f.static };
          else if (op === 0xf4) m = { kind: 'DELEGATECALL', caller: f.caller, address: f.address, codeAddr: to, value: 0n, apparentValue: f.value, static: f.static };
          else m = { kind: 'STATICCALL', caller: f.address, address: to, codeAddr: to, value: 0n, apparentValue: 0n, static: true };
          const r = this._call({ ...m, data, gas: callGas, depth: f.depth + 1 });
          gas += r.gasLeft; ret = r.returnData;
          if (outSize > 0n) ret.copy(mem, Number(outOff), 0, Math.min(Number(outSize), ret.length));
          push(r.success ? 1n : 0n); break;
        }
        case 0xf3: { const o = pop(), s = pop(); chargeMem(o, s); return { ok: true, gasLeft: gas, ret: slice(o, s) }; }
        case 0xfd: { const o = pop(), s = pop(); chargeMem(o, s); return { ok: false, reason: 'revert', gasLeft: gas, ret: slice(o, s) }; }
        case 0xff: {
          if (f.static) throw new VmError('write in static context');
          const ben = addrOf(pop());
          let cost = 5000;
          if (!st.warmAddress(ben)) cost += 2600;
          const bal = st.getBalance(f.address);
          if (bal > 0n && st.isEmpty(ben)) cost += 25000;
          use(cost);
          st.setBalance(f.address, 0n);
          if (ben !== f.address) st.setBalance(ben, st.getBalance(ben) + bal);
          st.markDestroyed(f.address);
          return { ok: true, gasLeft: gas, ret: EMPTY };
        }
        default: throw new VmError('invalid opcode 0x' + op.toString(16));
      }
    }
  }

  /** Run a frame; any exceptional halt consumes all gas. */
  _runSafe(f) { try { return this._run(f); } catch (e) { if (e instanceof VmError) return { ok: false, gasLeft: 0, ret: EMPTY, reason: 'error', error: e.message }; throw e; } }
}

// Make nested frames use the safe wrapper: exceptional halts must not escape as exceptions.
const rawRun = VM.prototype._run;
VM.prototype._run = function run(f) {
  try { return rawRun.call(this, f); } catch (e) { if (e instanceof VmError) return { ok: false, gasLeft: 0, ret: EMPTY, reason: 'error', error: e.message }; throw e; }
};

/** Intrinsic gas of a transaction (Shanghai). */
function intrinsicGas({ data, isCreate, accessList = [] }) {
  let g = 21000;
  for (const b of data) g += b === 0 ? 4 : 16;
  if (isCreate) { g += 32000 + 2 * wordsOf(data.length); }
  for (const e of accessList) g += 2400 + 1900 * e.storageKeys.length;
  return g;
}

/**
 * Execute a transaction against `state` (the sender's nonce has already been consumed by the caller).
 * @param {object} tx { from, to|null, value, data, gasLimit, nonce (the tx nonce, used for CREATE addresses), accessList }
 */
function runTransaction(vm, tx) {
  const st = vm.state, isCreate = tx.to === null;
  const ig = intrinsicGas({ data: tx.data, isCreate, accessList: tx.accessList });
  if (isCreate && tx.data.length > MAX_INITCODE) return { success: false, gasUsed: tx.gasLimit, returnData: EMPTY, logs: [], error: 'initcode too large' };
  if (tx.gasLimit < ig) return { success: false, gasUsed: tx.gasLimit, returnData: EMPTY, logs: [], error: 'intrinsic gas too low', invalid: true };
  const created = isCreate ? createAddress(tx.from, tx.nonce) : null;
  st.warmAddress(tx.from); st.warmAddress(isCreate ? created : tx.to); st.warmAddress(vm.ctx.coinbase);
  for (const p of PRECOMPILE_RANGE) st.warmAddress(p.toString(16).padStart(40, '0'));
  for (const e of tx.accessList || []) { st.warmAddress(e.address); for (const k of e.storageKeys) st.warmSlot(e.address, BigInt(k)); }

  const gas = tx.gasLimit - ig;
  let r;
  if (isCreate) r = vm._create({ kind: 'CREATE', caller: tx.from, address: created, value: tx.value, initcode: Buffer.from(tx.data), gas, depth: 0 });
  else r = vm._call({ kind: 'CALL', caller: tx.from, address: tx.to, codeAddr: tx.to, value: tx.value, apparentValue: tx.value, data: Buffer.from(tx.data), gas, depth: 0, static: false });

  let gasUsed = tx.gasLimit - r.gasLeft;
  const refund = Math.min(st.refund, Math.floor(gasUsed / 5));
  gasUsed -= refund;
  if (r.success) for (const a of st.destroyed) st.wipe(a);
  return { success: r.success, gasUsed, returnData: r.returnData, logs: r.success ? st.logs : [], createdAddress: isCreate && r.success ? created : null, error: r.success ? null : 'reverted or failed' };
}

module.exports = { VM, EvmState, runTransaction, intrinsicGas, createAddress, create2Address, addrOf, bigOf, VmError };

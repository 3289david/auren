'use strict';
// Shared primitives: canonical encoding, hashing, merkle roots, amounts.
const crypto = require('node:crypto');

const norm = (x) => {
  if (typeof x === 'bigint') return x.toString();
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]);
    return o;
  }
  return x;
};

/** Canonical JSON: sorted keys, BigInt rendered as decimal strings. */
const canon = (x) => JSON.stringify(norm(x));
const sha256 = (d) => crypto.createHash('sha256').update(d).digest();
const sha256hex = (d) => sha256(d).toString('hex');
const unhex = (h) => Buffer.from(h, 'hex');

/** Binary merkle tree over 32-byte leaves. Odd nodes are promoted unchanged. */
function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('');
  let level = leaves.map((l) => (typeof l === 'string' ? unhex(l) : l));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256(Buffer.concat([level[i], level[i + 1]])) : level[i]);
    }
    level = next;
  }
  return level[0].toString('hex');
}

/** Check a proof from State.prove(): leaf = sha256(canon([ns, key, value])), folded up to the expected root. */
function verifyMerkleProof(leafHex, steps, rootHex) {
  let cur = unhex(leafHex);
  for (const s of steps) cur = s.pos === 'L' ? sha256(Buffer.concat([unhex(s.hash), cur])) : sha256(Buffer.concat([cur, unhex(s.hash)]));
  return cur.toString('hex') === rootHex;
}

const DECIMALS = 9;
const AUR = 10n ** BigInt(DECIMALS); // 1 AUR = 1e9 sparks
const SCALE = 10n ** 18n; // reward index precision

/** "1.5" -> 1_500_000_000n (sparks). Accepts up to 9 decimals. */
function parseAur(s) {
  if (typeof s === 'bigint') return s * AUR;
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid AUR amount: ${s}`);
  return BigInt(m[1]) * AUR + BigInt((m[2] || '').padEnd(DECIMALS, '0') || '0');
}

/** 1_500_000_000n -> "1.5" */
function formatAur(sparks) {
  const v = BigInt(sparks);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / AUR;
  const frac = (a % AUR).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

const ceilDiv = (a, b) => (a + b - 1n) / b;
const minB = (a, b) => (a < b ? a : b);

/** Raised when a transaction is malformed or cannot be paid for: the tx can never be included. */
class TxInvalid extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}
/** Raised when an included transaction fails during execution: fee is charged, effects are reverted. */
class TxFail extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}
/** Raised when a whole block is invalid. */
class BlockInvalid extends Error {
  constructor(msg) { super(msg); this.code = 'BLOCK_INVALID'; }
}

module.exports = {
  canon, norm, sha256, sha256hex, unhex, merkleRoot, verifyMerkleProof,
  DECIMALS, AUR, SCALE, parseAur, formatAur, ceilDiv, minB,
  TxInvalid, TxFail, BlockInvalid,
};

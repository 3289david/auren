'use strict';
// Recursive Length Prefix encoding (Ethereum yellow paper, appendix B).
const bigToBuf = (n) => {
  n = BigInt(n);
  if (n === 0n) return Buffer.alloc(0);
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return Buffer.from(h, 'hex');
};
const bufToBig = (b) => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n);

function lenPrefix(len, offset) {
  if (len < 56) return Buffer.from([offset + len]);
  const l = bigToBuf(len);
  return Buffer.concat([Buffer.from([offset + 55 + l.length]), l]);
}

/** item: Buffer | Uint8Array | bigint | number (as minimal big-endian integer) | array of items */
function encode(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(encode));
    return Buffer.concat([lenPrefix(body.length, 0xc0), body]);
  }
  const b = typeof item === 'bigint' || typeof item === 'number' ? bigToBuf(item) : Buffer.from(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([lenPrefix(b.length, 0x80), b]);
}

/** Returns Buffer for strings and nested arrays for lists. Rejects non-canonical encodings. */
function decode(input) {
  const buf = Buffer.from(input);
  const [item, used] = read(buf, 0);
  if (used !== buf.length) throw new Error('rlp: trailing bytes');
  return item;
}

function readLen(buf, p, n) {
  if (p + n > buf.length) throw new Error('rlp: truncated');
  if (n > 0 && buf[p] === 0) throw new Error('rlp: leading zero in length');
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + buf[p + i];
  if (!Number.isSafeInteger(v)) throw new Error('rlp: length too large');
  return v;
}

function read(buf, p) {
  if (p >= buf.length) throw new Error('rlp: truncated');
  const b = buf[p];
  if (b < 0x80) return [buf.subarray(p, p + 1), p + 1];
  if (b < 0xb8) {
    const len = b - 0x80, end = p + 1 + len;
    if (end > buf.length) throw new Error('rlp: truncated');
    if (len === 1 && buf[p + 1] < 0x80) throw new Error('rlp: non-canonical single byte');
    return [buf.subarray(p + 1, end), end];
  }
  if (b < 0xc0) {
    const ll = b - 0xb7, len = readLen(buf, p + 1, ll), end = p + 1 + ll + len;
    if (len < 56) throw new Error('rlp: non-canonical length');
    if (end > buf.length) throw new Error('rlp: truncated');
    return [buf.subarray(p + 1 + ll, end), end];
  }
  let len, start;
  if (b < 0xf8) { len = b - 0xc0; start = p + 1; } else {
    const ll = b - 0xf7; len = readLen(buf, p + 1, ll); start = p + 1 + ll;
    if (len < 56) throw new Error('rlp: non-canonical length');
  }
  const end = start + len;
  if (end > buf.length) throw new Error('rlp: truncated');
  const out = [];
  let q = start;
  while (q < end) { const [it, nq] = read(buf, q); out.push(it); q = nq; }
  return [out, end];
}

module.exports = { encode, decode, bigToBuf, bufToBig };

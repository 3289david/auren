'use strict';
// Keccak-256 (the Ethereum hash: original Keccak padding 0x01, NOT NIST SHA3-256's 0x06).
// 64-bit lanes are held as pairs of uint32 for speed; verified against published vectors and ethers in tests.
const RC_HI = new Uint32Array([0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000]);
const RC_LO = new Uint32Array([0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080, 0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008]);
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function keccakF(hi, lo) {
  const bh = new Uint32Array(5), bl = new Uint32Array(5);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) { bh[x] = hi[x] ^ hi[x + 5] ^ hi[x + 10] ^ hi[x + 15] ^ hi[x + 20]; bl[x] = lo[x] ^ lo[x + 5] ^ lo[x + 10] ^ lo[x + 15] ^ lo[x + 20]; }
    for (let x = 0; x < 5; x++) {
      const nx = (x + 1) % 5, px = (x + 4) % 5;
      const th = bh[nx], tl = bl[nx];
      const rh = (th << 1) | (tl >>> 31), rl = (tl << 1) | (th >>> 31);
      const dh = bh[px] ^ rh, dl = bl[px] ^ rl;
      for (let y = 0; y < 25; y += 5) { hi[y + x] ^= dh; lo[y + x] ^= dl; }
    }
    let th = hi[1], tl = lo[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i], r = ROTC[i];
      const ch = hi[j], cl = lo[j];
      if (r < 32) { hi[j] = (th << r) | (tl >>> (32 - r)); lo[j] = (tl << r) | (th >>> (32 - r)); }
      else if (r === 32) { hi[j] = tl; lo[j] = th; }
      else { const s = r - 32; hi[j] = (tl << s) | (th >>> (32 - s)); lo[j] = (th << s) | (tl >>> (32 - s)); }
      th = ch; tl = cl;
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) { bh[x] = hi[y + x]; bl[x] = lo[y + x]; }
      for (let x = 0; x < 5; x++) { hi[y + x] ^= ~bh[(x + 1) % 5] & bh[(x + 2) % 5]; lo[y + x] ^= ~bl[(x + 1) % 5] & bl[(x + 2) % 5]; }
    }
    hi[0] ^= RC_HI[round]; lo[0] ^= RC_LO[round];
  }
}

/** @param {Uint8Array|Buffer} data  @returns {Buffer} 32 bytes */
function keccak256(data) {
  const rate = 136;
  const hi = new Uint32Array(25), lo = new Uint32Array(25);
  const n = Math.floor(data.length / rate) * rate;
  const absorb = (block, off) => {
    for (let i = 0; i < rate / 8; i++) {
      const p = off + i * 8;
      lo[i] ^= block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24);
      hi[i] ^= block[p + 4] | (block[p + 5] << 8) | (block[p + 6] << 16) | (block[p + 7] << 24);
    }
    keccakF(hi, lo);
  };
  for (let off = 0; off < n; off += rate) absorb(data, off);
  const last = new Uint8Array(rate);
  last.set(data.subarray(n));
  last[data.length - n] ^= 0x01;
  last[rate - 1] ^= 0x80;
  absorb(last, 0);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) { out.writeUInt32LE(lo[i] >>> 0, i * 8); out.writeUInt32LE(hi[i] >>> 0, i * 8 + 4); }
  return out;
}

const keccakHex = (data) => keccak256(data).toString('hex');
module.exports = { keccak256, keccakHex };

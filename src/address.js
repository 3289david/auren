'use strict';
// Bech32 (BIP-173) addresses. Payload = [signature scheme byte] + sha256(scheme || pubkey)[0..20].
// Scheme 0 = Ed25519. Scheme 1 is reserved for ML-DSA (FIPS 204) so addresses can migrate to
// post-quantum signatures without changing the address format.
const { sha256 } = require('./util');

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));

function checksum(hrp, data) {
  const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
  return [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
}

function bech32Encode(hrp, data) {
  return hrp + '1' + data.concat(checksum(hrp, data)).map((d) => CHARSET[d]).join('');
}

function bech32Decode(str) {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('mixed case');
  str = str.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length || str.length > 120) throw new Error('bad bech32 length');
  const hrp = str.slice(0, pos);
  const data = [];
  for (const c of str.slice(pos + 1)) {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error('bad bech32 character');
    data.push(i);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error('bad bech32 checksum');
  return { hrp, data: data.slice(0, -6) };
}

function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], max = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('invalid value');
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
    acc &= (1 << bits) - 1;
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); }
  else if (bits >= from || ((acc << (to - bits)) & max)) throw new Error('invalid padding');
  return out;
}

function pubToAddress(pubHex, hrp, scheme = 0) {
  // scheme 4 (secp256k1 / Ethereum keys): the 20 bytes ARE the Ethereum address, keccak256(pub)[12:]
  const h = scheme === 4
    ? require('./evm/keccak').keccak256(Buffer.from(pubHex, 'hex')).subarray(12)
    : sha256(Buffer.concat([Buffer.from([scheme]), Buffer.from(pubHex, 'hex')])).subarray(0, 20);
  return bech32Encode(hrp, convertBits([scheme, ...h], 8, 5, true));
}

function decodeAddress(addr, hrp) {
  const { hrp: got, data } = bech32Decode(addr);
  if (got !== hrp) throw new Error(`wrong address prefix: expected ${hrp}, got ${got}`);
  const bytes = convertBits(data, 5, 8, false);
  if (bytes.length !== 21) throw new Error('bad address length');
  return { scheme: bytes[0], hash: Buffer.from(bytes.slice(1)).toString('hex') };
}

function isValidAddress(addr, hrp) {
  try { decodeAddress(addr, hrp); return true; } catch { return false; }
}

module.exports = { bech32Encode, bech32Decode, convertBits, pubToAddress, decodeAddress, isValidAddress };

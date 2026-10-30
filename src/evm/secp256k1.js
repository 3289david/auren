'use strict';
// secp256k1 public-key recovery (ecrecover) using BigInt Jacobian arithmetic. Verification-side only:
// signing happens in wallets (MetaMask, ethers). Not constant-time; it never handles secret keys.
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function pow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
const inv = (a, m = P) => pow(a, m - 2n, m);

// Jacobian points [X, Y, Z]; infinity = Z == 0
const INF = [0n, 1n, 0n];
function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const A = mod(X * X), B = mod(Y * Y), C = mod(B * B);
  const D = mod(2n * (mod((X + B) * (X + B)) - A - C));
  const E = mod(3n * A), F = mod(E * E);
  const X3 = mod(F - 2n * D), Y3 = mod(E * (D - X3) - 8n * C), Z3 = mod(2n * Y * Z);
  return [X3, Y3, Z3];
}
function add(p, q) {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p) : INF;
  const H = mod(U2 - U1), I = mod(4n * H * H), J = mod(H * I), r = mod(2n * (S2 - S1)), V = mod(U1 * I);
  const X3 = mod(r * r - J - 2n * V), Y3 = mod(r * (V - X3) - 2n * S1 * J), Z3 = mod((mod((Z1 + Z2) * (Z1 + Z2)) - Z1Z1 - Z2Z2) * H);
  return [X3, Y3, Z3];
}
function mul(p, k) {
  let r = INF, q = p;
  while (k > 0n) { if (k & 1n) r = add(r, q); q = dbl(q); k >>= 1n; }
  return r;
}
function toAffine([X, Y, Z]) {
  if (Z === 0n) return null;
  const zi = inv(Z), zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}

/**
 * Recover the 64-byte uncompressed public key (X || Y) from a signature, or null if invalid.
 * @param {Buffer} hash 32 bytes, @param {bigint} r, @param {bigint} s, @param {number} recId 0 or 1
 */
function recover(hash, r, s, recId) {
  if (r <= 0n || r >= N || s <= 0n || s >= N || (recId !== 0 && recId !== 1)) return null;
  const x = r;
  const y2 = mod(pow(x, 3n, P) + 7n);
  let y = pow(y2, (P + 1n) / 4n, P);
  if (mod(y * y) !== y2) return null;
  if ((y & 1n) !== BigInt(recId)) y = P - y;
  const z = BigInt('0x' + hash.toString('hex'));
  const rinv = inv(r, N);
  const u1 = mod(-z * rinv, N), u2 = mod(s * rinv, N);
  const Q = add(mul([GX, GY, 1n], u1), mul([x, y, 1n], u2));
  const aff = toAffine(Q);
  if (!aff) return null;
  return Buffer.concat(aff.map((v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex')));
}

module.exports = { recover, N };

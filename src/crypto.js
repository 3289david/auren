'use strict';
// Ed25519 keys and signatures on top of node:crypto (no third-party code).
const crypto = require('node:crypto');
const { sha256 } = require('./util');

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

class Keypair {
  constructor(seed) {
    if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('seed must be 32 bytes');
    this.seed = seed;
    this.privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const jwk = crypto.createPublicKey(this.privateKey).export({ format: 'jwk' });
    this.pub = Buffer.from(jwk.x, 'base64url').toString('hex');
  }
  get seedHex() { return this.seed.toString('hex'); }
  sign(msg) { return crypto.sign(null, Buffer.from(msg), this.privateKey).toString('hex'); }
  static generate() { return new Keypair(crypto.randomBytes(32)); }
  static fromSeedHex(h) { return new Keypair(Buffer.from(h, 'hex')); }
  /** Deterministic key for devnets and tests. NEVER use for real funds. */
  static fromPassphrase(s) { return new Keypair(sha256(Buffer.from(s))); }
}

const pubCache = new Map();
function pubKeyObject(pubHex) {
  let k = pubCache.get(pubHex);
  if (!k) {
    k = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
    if (pubCache.size > 5000) pubCache.clear();
    pubCache.set(pubHex, k);
  }
  return k;
}

function verify(pubHex, msg, sigHex) {
  try {
    if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
    return crypto.verify(null, Buffer.from(msg), pubKeyObject(pubHex), Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

// ---- WebAuthn (passkeys, YubiKey, Touch ID, Windows Hello): ECDSA P-256 over authenticator data ----
// A WebAuthn assertion signs authenticatorData || sha256(clientDataJSON). We bind it to a transaction by
// requiring clientData.challenge == base64url(sha256(signingBytes(tx))), so a signature cannot be reused.
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const hexMax = (s, max) => typeof s === 'string' && s.length <= max && /^([0-9a-f]{2})+$/.test(s);

function verifyWebAuthn(pubHex, message, sig) {
  try {
    if (typeof pubHex !== 'string' || !/^04[0-9a-f]{128}$/.test(pubHex) || !sig || typeof sig !== 'object') return false;
    if (!hexMax(sig.authData, 1024) || !hexMax(sig.clientData, 4096) || !hexMax(sig.signature, 160)) return false;
    const authData = Buffer.from(sig.authData, 'hex'), clientData = Buffer.from(sig.clientData, 'hex');
    if (authData.length < 37 || !(authData[32] & 0x01)) return false; // the user-present flag must be set
    const client = JSON.parse(clientData.toString('utf8'));
    if (client.type !== 'webauthn.get' || client.challenge !== sha256(message).toString('base64url')) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify('sha256', Buffer.concat([authData, sha256(clientData)]), { key, dsaEncoding: 'der' }, Buffer.from(sig.signature, 'hex'));
  } catch {
    return false;
  }
}

// ---- encrypted keystore (scrypt + AES-256-GCM) ----
function encryptSeed(seedHex, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const N = 1 << 15, r = 8, p = 1;
  const key = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(seedHex, 'hex')), c.final()]);
  return {
    version: 1, kdf: 'scrypt', kdfparams: { N, r, p, salt: salt.toString('hex') },
    cipher: 'aes-256-gcm', iv: iv.toString('hex'), ciphertext: ct.toString('hex'), tag: c.getAuthTag().toString('hex'),
  };
}

function decryptSeed(ks, password) {
  const { N, r, p, salt } = ks.kdfparams;
  const key = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, { N, r, p, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ks.iv, 'hex'));
  d.setAuthTag(Buffer.from(ks.tag, 'hex'));
  try {
    return Buffer.concat([d.update(Buffer.from(ks.ciphertext, 'hex')), d.final()]).toString('hex');
  } catch {
    throw new Error('wrong password or corrupted keystore');
  }
}

module.exports = { Keypair, verify, verifyWebAuthn, encryptSeed, decryptSeed };

'use strict';
// AUREN client library for browsers (and Node, for tests): Ed25519 keys via WebCrypto, bech32 addresses,
// canonical JSON, transaction signing, encrypted keystore, RPC client. No dependencies, no network
// access except the RPC URL you give it. Mirrors src/{util,address,tx,client}.js byte for byte;
// test/webwallet.test.js proves signatures from this file are accepted by the real chain code.
(function (root) {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const sha256 = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));

  // ---- canonical JSON (must equal src/util.js canon) ----
  const norm = (x) => {
    if (typeof x === 'bigint') return x.toString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]); return o; }
    return x;
  };
  const canon = (x) => JSON.stringify(norm(x));

  // ---- amounts ----
  const AUR = 1000000000n;
  function parseAur(s) {
    const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(s).trim());
    if (!m) throw new Error('Enter an amount like 12.5 (up to 9 decimals)');
    return BigInt(m[1]) * AUR + BigInt((m[2] || '').padEnd(9, '0') || '0');
  }
  function formatAur(v, maxDecimals = 9) {
    v = BigInt(v);
    const neg = v < 0n; if (neg) v = -v;
    let frac = (v % AUR).toString().padStart(9, '0').slice(0, maxDecimals).replace(/0+$/, '');
    const whole = (v / AUR).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
  }

  // ---- bech32 (BIP-173) ----
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  function polymod(values) {
    let chk = 1;
    for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]; }
    return chk >>> 0;
  }
  const hrpExpand = (h) => [...h].map((c) => c.charCodeAt(0) >> 5).concat([0], [...h].map((c) => c.charCodeAt(0) & 31));
  function convertBits(data, from, to, pad) {
    let acc = 0, bits = 0; const out = [], max = (1 << to) - 1;
    for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & max); } acc &= (1 << bits) - 1; }
    if (pad) { if (bits) out.push((acc << (to - bits)) & max); } else if (bits >= from || ((acc << (to - bits)) & max)) throw new Error('bad padding');
    return out;
  }
  function bech32Encode(hrp, data) {
    const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
    const sum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
    return hrp + '1' + data.concat(sum).map((d) => CHARSET[d]).join('');
  }
  function isValidAddress(addr, hrp) {
    try {
      const s = String(addr);
      if (s !== s.toLowerCase()) return false;
      const pos = s.lastIndexOf('1');
      if (pos < 1 || pos + 7 > s.length || s.slice(0, pos) !== hrp) return false;
      const data = [...s.slice(pos + 1)].map((c) => { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('char'); return i; });
      if (polymod(hrpExpand(hrp).concat(data)) !== 1) return false;
      return convertBits(data.slice(0, -6), 5, 8, false).length === 21;
    } catch { return false; }
  }
  async function pubToAddress(pubHex, hrp, scheme = 0) {
    const h = (await sha256(cat(Uint8Array.of(scheme), unhex(pubHex)))).subarray(0, 20);
    return bech32Encode(hrp, convertBits([scheme, ...h], 8, 5, true));
  }

  // ---- keys ----
  const PKCS8 = unhex('302e020100300506032b657004220420');
  function randomSeedHex() { return hex(globalThis.crypto.getRandomValues(new Uint8Array(32))); }
  async function keyFromSeed(seedHex) {
    if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('A seed is 64 hex characters');
    const priv = await subtle.importKey('pkcs8', cat(PKCS8, unhex(seedHex)), { name: 'Ed25519' }, true, ['sign']);
    const jwk = await subtle.exportKey('jwk', priv);
    const pub = hex(Uint8Array.from(atob(jwk.x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    return { seedHex, pub, priv };
  }
  // ---- hardware-backed keys: WebAuthn (passkeys, YubiKey, Touch ID, Windows Hello), signature scheme 2 ----
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const webauthnAvailable = () => typeof navigator !== 'undefined' && !!navigator.credentials && !!globalThis.PublicKeyCredential;

  /** Ask the authenticator to create a new P-256 key. The private key never leaves the device. */
  async function createPasskey(label) {
    if (!webauthnAvailable()) throw new Error('This browser does not support WebAuthn (it needs a secure connection)');
    const cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'AUREN Wallet', id: location.hostname },
      user: { id: globalThis.crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
      challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = ECDSA P-256 + SHA-256
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none', timeout: 120000,
    } });
    const spki = new Uint8Array(cred.response.getPublicKey ? cred.response.getPublicKey() : []);
    if (spki.length < 65 || spki[spki.length - 65] !== 4) throw new Error('This authenticator did not return an ES256 public key');
    return { kind: 'webauthn', scheme: 2, credId: b64u(cred.rawId), rpId: location.hostname, pub: hex(spki.slice(-65)) };
  }

  async function signWebAuthn(key, tx) {
    const challenge = await sha256(signingBytes(tx));
    const a = await navigator.credentials.get({ publicKey: { challenge, rpId: key.rpId, allowCredentials: [{ type: 'public-key', id: fromB64u(key.credId) }], userVerification: 'preferred', timeout: 120000 } });
    return { authData: hex(new Uint8Array(a.response.authenticatorData)), clientData: hex(new Uint8Array(a.response.clientDataJSON)), signature: hex(new Uint8Array(a.response.signature)) };
  }

  const sign = async (key, bytes) => hex(new Uint8Array(await subtle.sign('Ed25519', key.priv, bytes)));
  async function verify(pubHex, bytes, sigHex) {
    const k = await subtle.importKey('raw', unhex(pubHex), { name: 'Ed25519' }, false, ['verify']);
    return subtle.verify('Ed25519', k, unhex(sigHex), bytes);
  }

  // ---- transactions ----
  const SIG_TAG = enc.encode('AUREN/tx/v1\0');
  const signingBytes = (tx) => { const { sig, ...rest } = tx; return cat(SIG_TAG, enc.encode(canon(rest))); };
  async function signTx(key, unsigned) {
    const tx = { ...unsigned, v: 1, pub: key.pub, ...(key.scheme === 2 ? { scheme: 2 } : {}) };
    if (key.scheme === 2) return { ...tx, sig: await signWebAuthn(key, tx) }; // the device asks the user to confirm
    return { ...tx, sig: await sign(key, signingBytes(tx)) };
  }
  const txHash = async (tx) => hex(await sha256(enc.encode(canon(tx))));

  // ---- encrypted keystore: PBKDF2-SHA256 (600k) + AES-256-GCM ----
  async function pwKey(password, salt, iterations) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptSeed(seedHex, password, iterations = 600000) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await pwKey(password, salt, iterations), unhex(seedHex)));
    return { version: 1, kdf: 'pbkdf2-sha256', iterations, salt: hex(salt), iv: hex(iv), ciphertext: hex(ct) };
  }
  async function decryptSeed(ks, password) {
    try {
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unhex(ks.iv) }, await pwKey(password, unhex(ks.salt), ks.iterations), unhex(ks.ciphertext));
      return hex(new Uint8Array(pt));
    } catch { throw new Error('Wrong password'); }
  }

  // ---- RPC ----
  class Rpc {
    constructor(url) { this.url = url.replace(/\/$/, ''); }
    async call(method, params = []) {
      const r = await fetch(this.url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.data });
      return j.result;
    }
    async get(path) { const r = await fetch(this.url + path, { cache: 'no-store' }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; }
  }

  /** Build + sign a transaction with fee and nonce taken from the node. */
  async function buildTx(rpc, key, type, body, { tip = 1000n, status } = {}) {
    const st = status || await rpc.call('aur_status');
    const from = await pubToAddress(key.pub, st.addressPrefix, key.scheme || 0);
    const [acct, fees] = await Promise.all([rpc.call('aur_getAccount', [from]), rpc.call('aur_feeQuote')]);
    let base = BigInt(fees.quote[type].baseFee);
    if (type === 'evm') { const gl = BigInt(body.gasLimit); base = gl * BigInt(fees.baseFee.compute) + ((gl + 999n) / 1000n) * BigInt(fees.baseFee.state); }
    return signTx(key, { chainId: st.chainId, type, from, nonce: acct.pendingNonce, maxFee: (base * 2n + BigInt(tip)).toString(), tip: BigInt(tip).toString(), body });
  }

  /**
   * The official networks and their public endpoints. Every network has exactly these addresses (two mirrors);
   * nobody creates a new one by running a node. Wallets and the explorer connect only to these.
   */
  const NETWORKS = {
    devnet: { label: 'Devnet', rpc: ['https://devnet.auren.im', 'https://devnet.krl.kr'], faucet: 'https://devnet.auren.im/faucet' },
    testnet: { label: 'Testnet', rpc: ['https://testnet.auren.im', 'https://testnet.krl.kr'], faucet: 'https://testnet.auren.im/faucet' },
    mainnet: { label: 'Mainnet', rpc: ['https://mainnet.auren.im', 'https://mainnet.krl.kr'], faucet: null },
  };

  /** First reachable endpoint of a network (null if none answers). */
  async function reach(network) {
    for (const u of (NETWORKS[network] || { rpc: [] }).rpc) {
      try {
        const r = await fetch(u + '/status', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        if (j.chainId && (!j.network || j.network === network)) return u;
      } catch { /* try the mirror */ }
    }
    return null;
  }

  /** Which network to open first: the last one used, else the testnet. Returns { network, url }. */
  async function detectRpc(saved) {
    let net = null;
    try { net = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('network')) || localStorage.getItem('auren.network'); } catch { /* storage blocked */ }
    if (!NETWORKS[net]) net = 'testnet';
    const url = await reach(net);
    return url ? url : NETWORKS[net].rpc[0];
  }

  /**
   * Network chooser: Devnet, Testnet or Mainnet. Choosing one connects to its official address.
   * There is no custom node: every network has one public address.
   */
  async function initNetPicker(sel, input, form) {
    if (!sel) return;
    if (input) input.hidden = true;
    const names = Object.keys(NETWORKS);
    sel.innerHTML = names.map((n) => '<option value="' + n + '">' + NETWORKS[n].label + '</option>').join('');
    let saved = null;
    try { saved = localStorage.getItem('auren.network'); } catch { /* storage blocked */ }
    sel.value = names.includes(saved) ? saved : 'testnet';
    let msg = document.getElementById('netmsg');
    if (!msg) { msg = document.createElement('p'); msg.id = 'netmsg'; msg.className = 'toast err'; msg.hidden = true; form.parentElement.insertAdjacentElement('afterend', msg); }
    const sync = () => {
      const chip = document.getElementById('conn');
      const net = chip && chip.textContent.split(' ')[0];
      if (net && names.includes(net)) sel.value = net;
    };
    sel.addEventListener('change', async () => {
      msg.hidden = true;
      const want = sel.value;
      try { localStorage.setItem('auren.network', want); } catch { /* storage blocked */ }
      const url = await reach(want);
      if (url) { if (input) input.value = url; form.requestSubmit(); return; }
      msg.hidden = false;
      msg.textContent = want === 'mainnet' ? 'The mainnet has not launched yet.' : 'The ' + want + ' is not reachable right now. Please try again in a moment.';
      sync();
    });
    const chip = document.getElementById('conn');
    if (chip) new MutationObserver(sync).observe(chip, { childList: true, characterData: true, subtree: true });
    setTimeout(sync, 300);
    sel.syncPicker = sync;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const Aur = {
    NETWORKS, reach, detectRpc, initNetPicker, esc, createPasskey, webauthnAvailable, signingBytesOf: (tx) => signingBytes(tx),
    canon, hex, unhex, sha256, AUR, parseAur, formatAur, bech32Encode, isValidAddress, pubToAddress,
    randomSeedHex, keyFromSeed, sign, verify, signTx, signingBytes, txHash, encryptSeed, decryptSeed, Rpc, buildTx,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Aur; else root.Aur = Aur;
})(typeof window !== 'undefined' ? window : globalThis);

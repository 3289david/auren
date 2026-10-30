'use strict';
// Client SDK: RPC client, encrypted keystore, transaction building. Used by aurenctl, the faucet and scripts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Keypair, encryptSeed, decryptSeed } = require('./crypto');
const { pubToAddress } = require('./address');
const { signTx } = require('./tx');

class RpcClient {
  constructor(url) { this.url = url.replace(/\/$/, ''); }
  async call(method, params = []) {
    const r = await fetch(this.url + '/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.data });
    return j.result;
  }
  status() { return this.call('aur_status'); }
  account(addr) { return this.call('aur_getAccount', [addr]); }
  feeQuote() { return this.call('aur_feeQuote'); }
  sendTx(tx) { return this.call('aur_sendTx', [tx]); }
  simulate(tx) { return this.call('aur_simulate', [tx]); }
  getTx(hash) { return this.call('aur_getTx', [hash]); }
  resolveDomain(name) { return this.call('aur_resolveDomain', [name]); }
}

class Wallet {
  constructor(keypair, prefix) {
    this.kp = keypair;
    this.prefix = prefix;
    this.address = pubToAddress(keypair.pub, prefix);
  }

  /** Build and sign a transaction with fee and nonce filled in from the node. */
  async build(rpc, type, body, { tip = 1000n, feeMultiplier = 2n, status = null } = {}) {
    const st = status || await rpc.status();
    if (st.addressPrefix !== this.prefix) throw new Error(`wallet prefix ${this.prefix} does not match network prefix ${st.addressPrefix}`);
    const [acct, fees] = await Promise.all([rpc.account(this.address), rpc.feeQuote()]);
    let base = BigInt(fees.quote[type].baseFee);
    if (type === 'evm') { // EVM cost scales with the gas limit: compute = gas, state = gas/1000 units
      const gl = BigInt(body.gasLimit);
      base = gl * BigInt(fees.baseFee.compute) + ((gl + 999n) / 1000n) * BigInt(fees.baseFee.state);
    }
    return signTx(this.kp, {
      chainId: st.chainId, type, from: this.address, nonce: acct.pendingNonce,
      maxFee: (base * feeMultiplier + BigInt(tip)).toString(), tip: BigInt(tip).toString(), body,
    });
  }

  /** Build, send and wait until the transaction is in a block. */
  async send(rpc, type, body, opts = {}) {
    const tx = await this.build(rpc, type, body, opts);
    const { hash } = await rpc.sendTx(tx);
    if (opts.wait === false) return { hash };
    const deadline = Date.now() + (opts.timeoutMs || 60000);
    while (Date.now() < deadline) {
      const t = await rpc.getTx(hash);
      if (t && t.status === 'confirmed') return { hash, height: t.height, receipt: t.receipt };
      await new Promise((r) => setTimeout(r, 400));
    }
    return { hash, pending: true };
  }
}

// ---- keystore ----
const keystoreDir = () => process.env.AUREN_KEYSTORE || path.join(os.homedir(), '.auren', 'keystore');

function saveKey(name, kp, password) {
  if (!/^[\w.-]{1,40}$/.test(name)) throw new Error('key name may contain letters, digits, ., _ and -');
  fs.mkdirSync(keystoreDir(), { recursive: true });
  const file = path.join(keystoreDir(), `${name}.json`);
  if (fs.existsSync(file)) throw new Error(`key "${name}" already exists`);
  fs.writeFileSync(file, JSON.stringify({ name, pub: kp.pub, ...encryptSeed(kp.seedHex, password) }, null, 2), { mode: 0o600 });
  return file;
}

function loadKeyFile(name) {
  const file = path.join(keystoreDir(), `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no key named "${name}" in ${keystoreDir()}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const loadKey = (name, password) => Keypair.fromSeedHex(decryptSeed(loadKeyFile(name), password));
const listKeys = () => (fs.existsSync(keystoreDir()) ? fs.readdirSync(keystoreDir()).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : []);

module.exports = { RpcClient, Wallet, saveKey, loadKey, loadKeyFile, listKeys, keystoreDir };

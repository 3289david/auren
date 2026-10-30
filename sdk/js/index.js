'use strict';
/**
 * AUREN SDK for JavaScript (Node.js 20+). No dependencies.
 *
 *   const { Client, Wallet } = require('./sdk/js');
 *   const node = new Client('http://127.0.0.1:9650');
 *   const wallet = Wallet.generate('daur');
 *   console.log(wallet.address, await node.balance(wallet.address));
 *   await wallet.transfer(node, 'daur1...', '1.5');     // amounts are in AUR
 *   await wallet.registerName(node, 'alice');
 *
 * In a browser, use website/aurlib.js (global `Aur`) instead; see docs/integrate.md.
 */
const { RpcClient, Wallet: BaseWallet } = require('../../src/client');
const { Keypair } = require('../../src/crypto');
const { isValidAddress, pubToAddress } = require('../../src/address');

const AUR = 1000000000n;

/** '1.5' -> 1500000000n. Strings or bigints only, so there is no float rounding. */
function toSparks(amount) {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(amount).trim());
  if (!m) throw new Error('amount must be a plain number with at most 9 decimals');
  return BigInt(m[1]) * AUR + BigInt((m[2] || '').padEnd(9, '0'));
}
function fromSparks(sparks) {
  const s = BigInt(sparks), whole = s / AUR, frac = (s % AUR).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

class Client extends RpcClient {
  /** Spendable balance in AUR, as a decimal string. */
  async balance(address) { return fromSparks((await this.account(address)).spendable); }
  getParams() { return this.call('aur_getParams'); }
  getBlock(height = 'latest') { return this.call('aur_getBlock', [height]); }
  getValidators() { return this.call('aur_getValidators'); }
  getTlds() { return this.call('aur_getTlds'); }
  getTld(tld) { return this.call('aur_getTld', [tld]); }
  getNodes() { return this.call('aur_getNodes'); }
  /** Name -> address with a Merkle proof (see docs/name-resolution.md). */
  resolve(name) { return this.call('aur_resolve', [name]); }
  async wait(hash, timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const t = await this.getTx(hash);
      if (t && t.status === 'confirmed') return t;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('transaction was not included in time');
  }
}

class Wallet extends BaseWallet {
  static generate(prefix) { return new Wallet(Keypair.generate(), prefix); }
  static fromSeed(seedHex, prefix) { return new Wallet(Keypair.fromSeedHex(seedHex), prefix); }
  get seedHex() { return this.kp.seedHex; }

  /** Build, simulate, sign, send and wait. Throws if the node says it would fail or it fails on chain. */
  async run(client, type, body, opts = {}) {
    const tx = await this.build(client, type, body, opts);
    const sim = await client.simulate(tx);
    if (!sim.ok) throw Object.assign(new Error(`would fail: ${sim.code}`), { code: sim.code });
    const { hash } = await client.sendTx(tx);
    if (opts.wait === false) return { hash };
    const t = await client.wait(hash);
    if (!t.receipt || t.receipt.status !== 1) throw Object.assign(new Error(`failed: ${t.receipt && t.receipt.code}`), { code: t.receipt && t.receipt.code });
    return t;
  }

  // ---- everyday actions (amounts in AUR)
  transfer(c, to, amount, o) { return this.run(c, 'transfer', { to, amount: toSparks(amount).toString() }, o); }
  stake(c, validator, amount, o) { return this.run(c, 'delegate', { validator, amount: toSparks(amount).toString() }, o); }
  unstake(c, validator, amount, o) { return this.run(c, 'undelegate', { validator, amount: toSparks(amount).toString() }, o); }
  claimRewards(c, validator, o) { return this.run(c, 'claim', { validator }, o); }
  /** 'alice' or 'alice.aur' (the .aur namespace), or 'alice.david' under a TLD someone created. */
  registerName(c, name, years = 1, o) { return this.run(c, 'registerDomain', { name: name.replace(/\.aur$/, ''), years }, o); }
  setNameTarget(c, name, target, o) { return this.run(c, 'setDomainTarget', { name: name.replace(/\.aur$/, ''), target }, o); }
  createTld(c, tld, { price = '1', ownerSharePercent = 80, open = true } = {}, o) {
    return this.run(c, 'registerTld', { tld, open: !!open, price: toSparks(price).toString(), ownerShareBps: Math.round(ownerSharePercent * 100) }, o);
  }
  registerNode(c, payout, o) { return this.run(c, 'registerNode', { payout: payout || this.address }, o); }
}

module.exports = { Client, Wallet, Keypair, AUR, toSparks, fromSparks, isValidAddress, pubToAddress };

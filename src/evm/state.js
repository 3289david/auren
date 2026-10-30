'use strict';
// Journaled in-memory world state for one EVM transaction. Reads fall through to a backend (the chain state);
// every mutation is recorded so a failed call frame can be reverted exactly. Addresses are 40-char lowercase hex.
const EMPTY = Buffer.alloc(0);

class EvmState {
  /** backend: { account(addr) -> {balance: bigint(wei), nonce, code: Buffer} | null, storage(addr, slot: bigint) -> bigint } */
  constructor(backend) {
    this.backend = backend;
    this.accts = new Map(); // addr -> { balance, nonce, code, storage: Map(slot -> bigint), cleared }
    this.orig = new Map(); // `${addr}:${slot}` -> original value at transaction start
    this.journal = [];
    this.warmAddrs = new Set();
    this.warmSlots = new Set();
    this.refund = 0;
    this.logs = [];
    this.destroyed = new Set();
    this.created = new Set();
  }

  checkpoint() { return this.journal.length; }
  revert(cp) { while (this.journal.length > cp) this.journal.pop()(); }

  _a(addr) {
    let a = this.accts.get(addr);
    if (!a) {
      const b = this.backend.account(addr);
      a = { balance: b ? b.balance : 0n, nonce: b ? b.nonce : 0, code: b ? b.code : EMPTY, storage: new Map(), cleared: false, touched: false };
      this.accts.set(addr, a);
    }
    return a;
  }

  getBalance(addr) { return this._a(addr).balance; }
  setBalance(addr, v) { const a = this._a(addr); const old = a.balance, t = a.touched; a.balance = v; a.touched = true; this.journal.push(() => { a.balance = old; a.touched = t; }); }
  getNonce(addr) { return this._a(addr).nonce; }
  setNonce(addr, n) { const a = this._a(addr); const old = a.nonce, t = a.touched; a.nonce = n; a.touched = true; this.journal.push(() => { a.nonce = old; a.touched = t; }); }
  getCode(addr) { return this._a(addr).code; }
  setCode(addr, code) { const a = this._a(addr); const old = a.code, t = a.touched; a.code = code; a.touched = true; this.journal.push(() => { a.code = old; a.touched = t; }); }
  isEmpty(addr) { const a = this._a(addr); return a.nonce === 0 && a.balance === 0n && a.code.length === 0; }

  getStorage(addr, slot) {
    const a = this._a(addr);
    if (a.storage.has(slot)) return a.storage.get(slot);
    if (a.cleared) return 0n;
    return this.getOriginalStorage(addr, slot);
  }
  getOriginalStorage(addr, slot) {
    const k = `${addr}:${slot}`;
    if (!this.orig.has(k)) this.orig.set(k, this._a(addr).cleared ? 0n : this.backend.storage(addr, slot));
    return this.orig.get(k);
  }
  setStorage(addr, slot, v) {
    const a = this._a(addr);
    const had = a.storage.has(slot), old = a.storage.get(slot);
    this.getOriginalStorage(addr, slot);
    a.storage.set(slot, v); a.touched = true;
    this.journal.push(() => { if (had) a.storage.set(slot, old); else a.storage.delete(slot); });
  }

  /** Wipe a contract's code, storage and nonce (end-of-transaction SELFDESTRUCT). */
  wipe(addr) { const a = this._a(addr); a.nonce = 0; a.code = EMPTY; a.storage = new Map(); a.cleared = true; a.balance = 0n; a.touched = true; }
  /** Clear storage of an address being (re)created. */
  clearStorage(addr) { const a = this._a(addr); const old = a.storage, oc = a.cleared; a.storage = new Map(); a.cleared = true; this.journal.push(() => { a.storage = old; a.cleared = oc; }); }

  warmAddress(addr) {
    if (this.warmAddrs.has(addr)) return true;
    this.warmAddrs.add(addr);
    this.journal.push(() => this.warmAddrs.delete(addr));
    return false;
  }
  warmSlot(addr, slot) {
    const k = `${addr}:${slot}`;
    if (this.warmSlots.has(k)) return true;
    this.warmSlots.add(k);
    this.journal.push(() => this.warmSlots.delete(k));
    return false;
  }
  addRefund(n) { this.refund += n; this.journal.push(() => { this.refund -= n; }); }
  addLog(log) { this.logs.push(log); this.journal.push(() => { this.logs.pop(); }); }
  markDestroyed(addr) { if (!this.destroyed.has(addr)) { this.destroyed.add(addr); this.journal.push(() => this.destroyed.delete(addr)); } }
  markCreated(addr) { if (!this.created.has(addr)) { this.created.add(addr); this.journal.push(() => this.created.delete(addr)); } }

  /** Everything the transaction changed, for writing back to the chain state. */
  changes() {
    const out = [];
    for (const [addr, a] of this.accts) {
      if (!a.touched && a.storage.size === 0 && !a.cleared) continue;
      out.push({ addr, balance: a.balance, nonce: a.nonce, code: a.code, storage: [...a.storage.entries()], cleared: a.cleared, destroyed: this.destroyed.has(addr) });
    }
    return out;
  }
}

module.exports = { EvmState, EMPTY };

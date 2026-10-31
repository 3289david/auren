'use strict';
// Pending-transaction pool. Admission mirrors consensus checks so that gossip stays cheap.
const { TxInvalid } = require('./util');
const { checkTx, txHash, costOfTx, spendable, isAuthorized, isFreeTx } = require('./tx');
const NR = require('./noderew');

const MAX_NONCE_GAP = 256;

class Mempool {
  constructor(chain, { max = 20000 } = {}) {
    this.chain = chain;
    this.max = max;
    this.byHash = new Map(); // hash -> tx
    this.bySender = new Map(); // from -> Map(nonce -> hash)
  }

  get size() { return this.byHash.size; }
  has(hash) { return this.byHash.has(hash); }

  /** Returns { hash, isNew }. Throws TxInvalid when the tx should be rejected. */
  add(tx) {
    const { chain } = this;
    const hash = checkTx(tx, chain.params, chain.chainId);
    if (this.byHash.has(hash)) return { hash, isNew: false };

    const acct = chain.state.get('acct', tx.from) || { balance: 0n, nonce: 0 };
    if (!isAuthorized(acct, tx, chain.params.addressPrefix)) throw new TxInvalid('NOT_AUTHORIZED');
    if (tx.nonce < acct.nonce) throw new TxInvalid('NONCE_TOO_LOW', `account nonce is ${acct.nonce}`);
    if (tx.nonce > acct.nonce + MAX_NONCE_GAP) throw new TxInvalid('NONCE_TOO_HIGH');
    if (isFreeTx(chain.state, tx)) {
      // free tier: no fee, so refuse anything that could not succeed (keeps the pool from filling with junk)
      const P = chain.params;
      if (tx.type === 'registerNode') {
        if (chain.state.has('node', tx.from)) throw new TxInvalid('NODE_EXISTS');
        const fr = chain.state.get('meta', 'freeRegs'), ep = NR.epochOf(chain.height + 1, P);
        if ((fr && fr.epoch === ep ? fr.n : 0) >= P.rpc.freeRegsPerEpoch) throw new TxInvalid('FREE_FULL', 'the free tier is full this epoch; try again next epoch');
      }
    } else {
      const baseCost = costOfTx(tx, chain.baseFee);
      if (BigInt(tx.maxFee) < baseCost) throw new TxInvalid('FEE_TOO_LOW', `maxFee must be at least ${baseCost} sparks at the current base fee`);
      if (spendable(acct, chain.height + 1) < baseCost) throw new TxInvalid('INSUFFICIENT_FEE_FUNDS');
    }

    const q = this.bySender.get(tx.from) || new Map();
    const existing = q.get(tx.nonce);
    if (existing) {
      const old = this.byHash.get(existing);
      if (BigInt(tx.tip) * 100n < BigInt(old.tip) * 110n + 100n) throw new TxInvalid('REPLACEMENT_UNDERPRICED', 'raise the tip by at least 10% to replace');
      this.byHash.delete(existing);
    } else if (this.byHash.size >= this.max) {
      throw new TxInvalid('MEMPOOL_FULL');
    }
    q.set(tx.nonce, hash);
    this.bySender.set(tx.from, q);
    this.byHash.set(hash, tx);
    return { hash, isNew: true };
  }

  /** Drop transactions that can no longer be included (nonce already used). */
  prune() {
    for (const [from, q] of this.bySender) {
      const acct = this.chain.state.get('acct', from);
      const n = acct ? acct.nonce : 0;
      for (const [nonce, hash] of q) {
        if (nonce < n) { q.delete(nonce); this.byHash.delete(hash); }
      }
      if (q.size === 0) this.bySender.delete(from);
    }
  }

  /** Number of contiguous pending txs from `from` starting at its account nonce. */
  pendingNonce(from) {
    const acct = this.chain.state.get('acct', from);
    let n = acct ? acct.nonce : 0;
    const q = this.bySender.get(from);
    while (q && q.has(n)) n++;
    return n;
  }

  /** Executable txs, highest tip first, always in per-sender nonce order. */
  candidates(limit = 5000) {
    const out = [];
    for (const [from, q] of this.bySender) {
      const acct = this.chain.state.get('acct', from);
      let n = acct ? acct.nonce : 0;
      let floor = Infinity;
      while (q.has(n)) {
        const tx = this.byHash.get(q.get(n));
        floor = Math.min(floor, Number(BigInt(tx.tip) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(tx.tip)));
        out.push({ tx, eff: floor });
        n++;
      }
    }
    out.sort((a, b) => b.eff - a.eff || (a.tx.from < b.tx.from ? -1 : a.tx.from > b.tx.from ? 1 : a.tx.nonce - b.tx.nonce));
    return out.slice(0, limit).map((x) => x.tx);
  }
}

module.exports = { Mempool, txHash };

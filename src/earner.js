'use strict';
// Runs inside a full node started with `earn`: registers the node (bond) and proves storage once per epoch,
// so the operator earns a share of the node-reward pool (see noderew.js and docs/node-rewards.md).
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('./crypto');
const { pubToAddress } = require('./address');
const { signTx, costOf, getAcct, spendable } = require('./tx');
const NR = require('./noderew');

class Earner {
  /** @param node AurenNode  @param payout address that receives rewards (default: the node's own address) */
  constructor(node, payout) {
    this.node = node;
    const file = path.join(node.home, 'node_key.json');
    if (fs.existsSync(file)) this.kp = Keypair.fromSeedHex(JSON.parse(fs.readFileSync(file, 'utf8')).seed);
    else { this.kp = Keypair.generate(); fs.writeFileSync(file, JSON.stringify({ seed: this.kp.seedHex, pub: this.kp.pub }, null, 2), { mode: 0o600 }); }
    this.address = pubToAddress(this.kp.pub, node.chain.params.addressPrefix);
    this.payout = payout || this.address;
    this.sent = { register: 0, proof: { epoch: -1, height: 0 }, drip: -1000 };
    this.stats = { wins: 0, earned: 0n, lastWinHeight: 0, startedAt: Date.now(), countedDraw: 0 };
    try { this._status(); } catch { /* best effort */ }
    node.log(`node rewards: this node's address is ${this.address}; rewards are paid to ${this.payout}`);
  }

  /** Send a transaction signed by the node key. Free-tier transactions carry no fee. */
  _send(type, body, free = false) {
    const ch = this.node.chain;
    const base = costOf(type, ch.baseFee);
    const tx = signTx(this.kp, {
      chainId: ch.chainId, type, from: this.address, nonce: this.node.mempool.pendingNonce(this.address),
      maxFee: free ? '0' : (base * 3n + 1000n).toString(), tip: free ? '0' : '1000', body,
    });
    return this.node.onTx(tx).catch(() => {});
  }

  /** Called after every block. Does the work, counts draw wins and writes the status file the apps read. */
  tick() {
    try { this._tick(); } finally { try { this._status(); } catch { /* status is best effort */ } }
  }

  _status() {
    const ch = this.node.chain, P = ch.params, h = ch.height, st = ch.state;
    const n = st.get('node', this.address);
    const ep = NR.epochOf(h + 1, P);
    const d = st.get('meta', 'lastDraw');
    if (d && d.height > this.stats.countedDraw) {
      this.stats.countedDraw = d.height;
      if (d.winners.includes(this.address)) { this.stats.wins++; this.stats.earned += d.each; this.stats.lastWinHeight = d.height; }
    }
    const acct = getAcct(st, this.payout);
    const out = {
      updated: Date.now(), startedAt: this.stats.startedAt, network: ch.chainId, address: this.address, payout: this.payout,
      height: h, epoch: ep, peers: this.node.peers ? this.node.peers.size : 0, syncing: !!this.node.syncing,
      bond: P.node.bond.toString(), tier: n ? (n.bond > 0n ? 'full' : 'free') : null, registered: !!n, ticket: !!(n && n.provenEpoch >= 1 && ep - n.provenEpoch <= 1),
      provenEpoch: n ? n.provenEpoch : -1, balance: acct.balance.toString(), spendable: spendable(acct, h + 1).toString(),
      ownBalance: getAcct(st, this.address).balance.toString(), wins: this.stats.wins, drawEarned: this.stats.earned.toString(), lastWinHeight: this.stats.lastWinHeight,
      pool: (st.get('meta', 'rpcPool') || 0n).toString(), committeeSize: P.rpc.committeeSize,
    };
    const f = path.join(this.node.home, 'miner-status.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify(out));
    fs.renameSync(f + '.tmp', f);
  }

  _tick() {
    const ch = this.node.chain, P = ch.params, h = ch.height;
    const st = ch.state, n = st.get('node', this.address);
    if (!n) {
      // Join. Nobody needs coins to start: with no deposit the node joins the free tier (no fee). If the node
      // already holds the deposit it joins the full tier.
      if (this.node.syncing || h - this.sent.register < 20) return;
      const a = getAcct(st, this.address);
      const need = P.node.bond + costOf('registerNode', ch.baseFee) * 3n + 1000n;
      const full = spendable(a, h + 1) >= need;
      this.sent.register = h;
      this.node.log(`node rewards: joining the ${full ? 'full' : 'free'} tier as ${this.address}`);
      this._send('registerNode', full ? { payout: this.payout } : { payout: this.payout, free: true }, !full);
      return;
    }
    // A free-tier node upgrades itself once its own account holds the deposit (for example from rewards paid to it).
    if (n.bond === 0n && h - (this.sent.bond || 0) >= 30) {
      const a = getAcct(st, this.address);
      if (spendable(a, h + 1) >= P.node.bond + costOf('bondNode', ch.baseFee) * 3n + 1000n) {
        this.sent.bond = h;
        this.node.log('node rewards: upgrading to the full tier (posting the deposit)');
        this._send('bondNode', {});
      }
    }
    const ep = NR.epochOf(h + 1, P);
    if (ep < 1 || n.provenEpoch === ep || n.since > ep * P.node.epochBlocks) return;
    if (this.sent.proof.epoch === ep && h - this.sent.proof.height < 10) return;
    const chh = NR.challengeHeight(ep, P, (x) => ch.getBlock(x)?.hash);
    const blk = chh && ch.getBlock(chh);
    if (!blk) return;
    this.sent.proof = { epoch: ep, height: h };
    this.node.log(`node rewards: proving storage of block ${chh} for epoch ${ep}`);
    this._send('nodeProof', { epoch: ep, digest: NR.proofDigest(this.address, blk) }, n.bond === 0n);
  }
}

module.exports = { Earner };

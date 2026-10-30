'use strict';
// Two-phase BFT (Tendermint-style): propose -> prevote -> precommit, with locks and proof-of-lock.
//
// Safety: a validator precommits a block only after seeing > 2/3 prevotes for it in that round, and
// then prevotes only for that block (its lock) until it sees a newer proof-of-lock (> 2/3 prevotes for
// another block in a later round). Two blocks committed at one height would need > 1/3 of power to have
// equivocated (two votes of one type in one round), which is provable and slashed.
//
// Liveness: after GST, round timeouts grow, a proposer re-proposes the block it saw a proof-of-lock for
// (validBlock), and validators skip ahead when > 1/3 of power is in a higher round.
//
// This class is a pure state machine: time, network, signing, persistence and block validation are
// injected, so it is exercised deterministically in test/bft.test.js under loss, delay and partitions.
const { isQuorum, totalPower } = require('./consensus');

class BftEngine {
  /**
   * @param {object} o
   * @param {string|null} o.self                 our operator address (null: observe only)
   * @param {() => Array} o.valset               validator set for the current height [{operator, consPub, power}]
   * @param {(h,r) => string} o.proposerFor
   * @param {(block) => boolean} o.validate      full block validation (may throw)
   * @param {(h,r) => object} o.build            build a new block proposal
   * @param {(type,h,r,hash|null) => object} o.signVote
   * @param {(p) => string} o.signProposal       signs {height,round,polRound,blockHash}
   * @param {(msg) => void} o.broadcast
   * @param {(snapshot) => void} o.persist       durable write, called BEFORE any own vote is broadcast
   * @param {(block, commit) => void} o.onCommit
   * @param {(evidence) => void} o.onEvidence
   * @param {(fn, ms) => any} o.setTimer / o.clearTimer
   * @param {{proposeMs, voteMs, deltaMs}} o.timeouts
   * @param {(verifyVote, verifyProposal) => ...} o.verify  { vote(consPub, vote)->bool, proposal(consPub, p)->bool }
   */
  constructor(o) {
    this.o = o;
    this.h = 0;
    this.running = false;
    this.future = new Map(); // height -> [msg]
    this._reset();
  }

  _reset() {
    this.round = 0;
    this.step = 'propose';
    this.lockedRound = -1; this.lockedBlock = null;
    this.validRound = -1; this.validBlock = null;
    this.props = new Map(); // round -> { block, hash, polRound, msg }
    this.votes = { prevote: new Map(), precommit: new Map() }; // round -> Map(validator -> vote)
    this.blocks = new Map(); // hash -> { block, ok }
    this.flags = new Set();
    this.signedVotes = new Map(); // `${h}:${r}:${type}` -> our vote
    this.timers = [];
  }

  get height() { return this.h; }
  get isRunning() { return this.running; }

  // ---------------------------------------------------------------- lifecycle
  startHeight(h, snapshot = null) {
    this._clearTimers();
    this.h = h;
    this._reset();
    this.valset = this.o.valset();
    this.total = totalPower(this.valset);
    this.byOp = new Map(this.valset.map((v) => [v.operator, v]));
    this.running = true;
    if (snapshot && snapshot.height === h) this._restore(snapshot);
    const buffered = this.future.get(h) || [];
    for (const k of this.future.keys()) if (k <= h) this.future.delete(k);
    this._startRound(0);
    for (const m of buffered) this.receive(m);
  }

  stop() { this.running = false; this._clearTimers(); }

  snapshot() {
    return {
      height: this.h, lockedRound: this.lockedRound, lockedBlock: this.lockedBlock, validRound: this.validRound, validBlock: this.validBlock,
      signed: [...this.signedVotes.entries()],
    };
  }
  _restore(s) {
    this.lockedRound = s.lockedRound; this.lockedBlock = s.lockedBlock; this.validRound = s.validRound; this.validBlock = s.validBlock;
    this.signedVotes = new Map(s.signed);
    for (const b of [s.lockedBlock, s.validBlock]) if (b) this.blocks.set(b.hash, { block: b, ok: true });
  }

  /** Messages the node can serve to peers that missed them (pull-based repair). */
  roundState() {
    const flat = (m) => [...m.values()].flatMap((x) => [...x.values()]);
    return { height: this.h, proposals: [...this.props.values()].map((p) => p.msg), prevotes: flat(this.votes.prevote), precommits: flat(this.votes.precommit) };
  }
  /** Hash of a block we hold a > 2/3 precommit quorum for but whose body we have not seen (so the node can fetch it). */
  get missingBlock() { return this._missing || null; }

  // ---------------------------------------------------------------- timers
  _timer(ms, fn) {
    const id = this.o.setTimer(fn, ms);
    this.timers.push(id);
  }
  _clearTimers() { for (const id of this.timers || []) this.o.clearTimer(id); this.timers = []; }

  // ---------------------------------------------------------------- inbound
  receive(msg) {
    if (!msg || typeof msg !== 'object' || !Number.isSafeInteger(msg.height) || !Number.isSafeInteger(msg.round) || msg.round < 0 || msg.round > 1e6) return;
    if (msg.height > this.h) {
      const l = this.future.get(msg.height) || [];
      if (l.length < 5000 && this.future.size < 4) { l.push(msg); this.future.set(msg.height, l); }
      return;
    }
    if (msg.height < this.h || !this.running) return;
    if (msg.type === 'proposal') this._onProposal(msg);
    else if (msg.type === 'prevote' || msg.type === 'precommit') this._onVote(msg);
    else return;
    this._evaluate();
  }

  _ok(block) {
    let e = this.blocks.get(block.hash);
    if (!e) {
      let ok = false;
      try { ok = !!this.o.validate(block); } catch { ok = false; }
      e = { block, ok };
      this.blocks.set(block.hash, e);
    }
    return e.ok;
  }

  _onProposal(msg) {
    if (this.props.has(msg.round) || !msg.block || msg.block.hash !== msg.blockHash || !Number.isSafeInteger(msg.polRound) || msg.polRound >= msg.round) return;
    const proposer = this.byOp.get(this.o.proposerFor(this.h, msg.round));
    if (!proposer || !this.o.verify.proposal(proposer.consPub, msg)) return;
    if (msg.block.header.height !== this.h) return;
    this.props.set(msg.round, { block: msg.block, hash: msg.blockHash, polRound: msg.polRound, msg });
    this._ok(msg.block);
  }

  _onVote(v) {
    const val = this.byOp.get(v.validator);
    if (!val || (v.blockHash !== null && typeof v.blockHash !== 'string')) return;
    const m = this.votes[v.type];
    let round = m.get(v.round);
    if (!round) { round = new Map(); m.set(v.round, round); }
    const prev = round.get(v.validator);
    if (prev) {
      if ((prev.blockHash ?? null) !== (v.blockHash ?? null) && this.o.verify.vote(val.consPub, v)) {
        this.o.onEvidence({ validator: v.validator, height: this.h, round: v.round, type: v.type, a: { blockHash: prev.blockHash ?? null, sig: prev.sig }, b: { blockHash: v.blockHash ?? null, sig: v.sig } });
      }
      return;
    }
    if (!this.o.verify.vote(val.consPub, v)) return;
    round.set(v.validator, v);
  }

  // ---------------------------------------------------------------- tallies
  _power(type, r, pred) {
    const m = this.votes[type].get(r);
    if (!m) return 0n;
    let p = 0n;
    for (const [op, v] of m) if (pred(v)) p += this.byOp.get(op).power;
    return p;
  }
  _quorumFor(type, r, hash) { return isQuorum(this._power(type, r, (v) => (v.blockHash ?? null) === hash), this.total); }
  _quorumAny(type, r) { return isQuorum(this._power(type, r, () => true), this.total); }

  // ---------------------------------------------------------------- outbound
  _cast(type, hash) {
    if (!this.o.self || !this.byOp.has(this.o.self)) return;
    const key = `${this.h}:${this.round}:${type}`;
    let vote = this.signedVotes.get(key);
    if (vote) {
      if ((vote.blockHash ?? null) !== hash) return; // never sign a second, different vote in the same (height, round, type)
    } else {
      vote = this.o.signVote(type, this.h, this.round, hash);
      if (!vote) return;
      this.signedVotes.set(key, vote);
    }
    this.o.persist(this.snapshot()); // durable BEFORE the vote leaves this process
    this.o.broadcast(vote);
    this._onVote(vote);
  }

  _startRound(r) {
    this.round = r;
    this.step = 'propose';
    const h = this.h;
    if (this.o.self && this.byOp.has(this.o.self) && this.o.proposerFor(h, r) === this.o.self) {
      let block = this.validBlock, polRound = this.validRound;
      if (!block) { block = this.o.build(h, r); polRound = -1; }
      if (block) {
        const p = { height: h, round: r, polRound, blockHash: block.hash };
        const msg = { type: 'proposal', ...p, proposer: this.o.self, block, sig: this.o.signProposal(p) };
        this.o.broadcast(msg);
        this._onProposal(msg);
      }
    }
    const t = this.o.timeouts;
    this._timer(t.proposeMs + r * t.deltaMs, () => {
      if (this.running && this.h === h && this.round === r && this.step === 'propose') { this.step = 'prevote'; this._cast('prevote', null); this._evaluate(); }
    });
    this._evaluate();
  }

  // ---------------------------------------------------------------- rules
  _evaluate() {
    let guard = 0;
    while (this.running && this._rules() && guard++ < 100) { /* re-run until no rule fires */ }
  }

  _rules() {
    const r = this.round, h = this.h, t = this.o.timeouts;

    // Commit: > 2/3 precommits for a known valid block, in ANY round of this height.
    this._missing = null;
    for (const [rr, m] of this.votes.precommit) {
      const tally = new Map();
      for (const [op, v] of m) if (v.blockHash) tally.set(v.blockHash, (tally.get(v.blockHash) || 0n) + this.byOp.get(op).power);
      for (const [hash, p] of tally) {
        if (!isQuorum(p, this.total)) continue;
        const e = this.blocks.get(hash);
        if (e && e.ok) { this._commit(e.block, rr, hash); return false; }
        this._missing = hash;
      }
    }

    // Round skip: > 1/3 of power has been seen in a higher round.
    const maxRound = new Map();
    for (const type of ['prevote', 'precommit']) for (const [rr, m] of this.votes[type]) for (const op of m.keys()) maxRound.set(op, Math.max(maxRound.get(op) ?? -1, rr));
    const ranked = [...maxRound.entries()].sort((a, b) => b[1] - a[1]);
    let acc = 0n;
    for (const [op, rr] of ranked) {
      acc += this.byOp.get(op).power;
      if (acc * 3n > this.total) { if (rr > r) { this._startRound(rr); return true; } break; }
    }

    const prop = this.props.get(r);
    const propOk = prop && this.blocks.get(prop.hash).ok;

    // Propose step: prevote according to the lock rule.
    if (this.step === 'propose' && prop) {
      if (prop.polRound === -1) {
        this.step = 'prevote';
        this._cast('prevote', propOk && (this.lockedRound === -1 || this.lockedBlock.hash === prop.hash) ? prop.hash : null);
        return true;
      }
      if (prop.polRound < r && this._quorumFor('prevote', prop.polRound, prop.hash)) {
        this.step = 'prevote';
        this._cast('prevote', propOk && (this.lockedRound <= prop.polRound || this.lockedBlock.hash === prop.hash) ? prop.hash : null);
        return true;
      }
    }

    // Prevote step: > 2/3 prevotes of any kind start the prevote timeout.
    if (this.step === 'prevote' && this._quorumAny('prevote', r) && !this.flags.has('pvto:' + r)) {
      this.flags.add('pvto:' + r);
      this._timer(t.voteMs + r * t.deltaMs, () => {
        if (this.running && this.h === h && this.round === r && this.step === 'prevote') { this.step = 'precommit'; this._cast('precommit', null); this._evaluate(); }
      });
    }

    // Proof-of-lock: proposal + > 2/3 prevotes for it in this round.
    if (this.step !== 'propose' && propOk && this._quorumFor('prevote', r, prop.hash) && !this.flags.has('lock:' + r)) {
      this.flags.add('lock:' + r);
      this.validBlock = prop.block; this.validRound = r;
      if (this.step === 'prevote') {
        this.lockedBlock = prop.block; this.lockedRound = r;
        this.step = 'precommit';
        this._cast('precommit', prop.hash);
      } else this.o.persist(this.snapshot());
      return true;
    }

    // > 2/3 prevotes for nil: precommit nil.
    if (this.step === 'prevote' && this._quorumFor('prevote', r, null)) {
      this.step = 'precommit';
      this._cast('precommit', null);
      return true;
    }

    // > 2/3 precommits of any kind: if no commit happens, move to the next round after a timeout.
    if (this._quorumAny('precommit', r) && !this.flags.has('pcto:' + r)) {
      this.flags.add('pcto:' + r);
      this._timer(t.voteMs + r * t.deltaMs, () => { if (this.running && this.h === h && this.round === r) this._startRound(r + 1); });
    }
    return false;
  }

  _commit(block, round, hash) {
    const votes = [...this.votes.precommit.get(round).values()].filter((v) => v.blockHash === hash).map((v) => ({ validator: v.validator, sig: v.sig }));
    const commit = { height: this.h, round, blockHash: hash, votes };
    this.running = false;
    this._clearTimers();
    this.o.onCommit(block, commit);
  }
}

module.exports = { BftEngine };

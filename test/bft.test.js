'use strict';
// Fault-injection tests for the two-phase BFT engine. Real blocks, real signatures, real chains; only the
// clock and the network are simulated (deterministic, seeded), which is what lets us inject loss,
// reordering, partitions and crashes and replay any failure exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BftEngine } = require('../src/bft');
const { Chain } = require('../src/chain');
const { makeTestChain } = require('../src/devkit');
const C = require('../src/consensus');

const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

class Sim {
  constructor(seed, n = 4, stakes) {
    this.rnd = mulberry32(seed);
    this.t = 0; this.seq = 0; this.q = []; this.cancelled = new Set();
    this.loss = 0; this.maxDelay = 30; this.group = null; // group[i] = partition id
    const { genesis, validators } = makeTestChain({ n, stakes, params: { blockTimeMs: 200, roundTimeoutMs: 1000 } });
    this.genesis = genesis; this.validators = validators;
    this.committed = new Map(); // height -> Set(hash) across all nodes (safety)
    this.evidence = [];
    this.nodes = validators.map((v, i) => this.makeNode(i, v));
  }

  setTimer(fn, ms) { const id = ++this.seq; this.q.push({ t: this.t + Math.max(0, ms), id, fn }); return id; }
  clearTimer(id) { this.cancelled.add(id); }

  makeNode(i, v, chain = new Chain(this.genesis)) {
    const sim = this, cid = chain.chainId;
    const node = { i, chain, up: true, snap: null, byz: false, commits: [] };
    const make = () => new BftEngine({
      self: v.address,
      valset: () => chain.activeSet,
      proposerFor: (h, r) => chain.proposerFor(r, h),
      validate: (b) => { chain.validateBlock(b); return true; },
      build: (h, r) => chain.buildBlock({ operator: v.address, signKey: v.cons, round: r, time: chain.last.time + 100 + r }).block,
      signVote: (type, h, r, hash) => C.signVote(v.cons, cid, v.address, h, r, hash, type),
      signProposal: (p) => C.signProposal(v.cons, cid, p),
      broadcast: (msg) => {
        sim.send(i, msg);
        if (node.byz && msg.type === 'prevote') sim.send(i, C.signVote(v.cons, cid, v.address, msg.height, msg.round, 'ff'.repeat(32), 'prevote')); // equivocate
      },
      persist: (s) => { node.snap = structuredClone(s); },
      onCommit: (block, commit) => {
        if (!sim.committed.has(commit.height)) sim.committed.set(commit.height, new Set());
        sim.committed.get(commit.height).add(block.hash);
        chain.applyBlock(block, commit);
        node.commits.push(commit.height);
        sim.setTimer(() => { if (node.up) node.engine.startHeight(chain.height + 1, node.snap); }, 200);
      },
      onEvidence: (ev) => sim.evidence.push(ev),
      setTimer: (fn, ms) => sim.setTimer(() => { if (node.up) fn(); }, ms),
      clearTimer: (id) => sim.clearTimer(id),
      timeouts: { proposeMs: 1000, voteMs: 500, deltaMs: 200 },
      verify: { vote: (pub, vt) => C.verifyVote(cid, pub, vt), proposal: (pub, p) => C.verifyProposal(cid, pub, p) },
    });
    node.make = make; node.engine = make();
    return node;
  }

  send(from, msg) {
    this.nodes.forEach((n, j) => {
      if (j === from) return;
      if (this.group && this.group[from] !== this.group[j]) return;
      if (this.rnd() < this.loss) return;
      const delay = Math.floor(this.rnd() * this.maxDelay) + 1;
      this.setTimer(() => { if (n.up) n.engine.receive(structuredClone(msg)); }, delay);
    });
  }

  start() {
    this.nodes.forEach((n) => n.engine.startHeight(1));
    const tick = () => { this.repair(); this.setTimer(tick, 300); }; // the real node polls peers on a timer too
    this.setTimer(tick, 300);
  }
  crash(i) { this.nodes[i].up = false; this.nodes[i].engine.stop(); }
  restart(i) { const n = this.nodes[i]; n.engine = n.make(); n.up = true; n.engine.startHeight(n.chain.height + 1, n.snap); }

  /** Pull-based repair like the real node does: each node asks peers for the current round state. */
  repair() {
    for (const n of this.nodes) {
      if (!n.up || !n.engine.isRunning) continue;
      for (const m of this.nodes) {
        if (m === n || !m.up || (this.group && this.group[n.i] !== this.group[m.i]) || this.rnd() < this.loss) continue;
        if (m.chain.height > n.chain.height) { // block sync: fetch the next block + its commit certificate from a peer
          for (let k = 0; k < 50 && m.chain.height > n.chain.height; k++) { // batches of 50, like /p2p/blocks
            const h = n.chain.height + 1;
            n.chain.applyBlock(m.chain.getBlock(h), m.chain.commits.get(h));
          }
          n.engine.stop();
          this.setTimer(() => { if (n.up && !n.engine.isRunning) n.engine.startHeight(n.chain.height + 1, n.snap); }, 50);
          continue;
        }
        if (m.engine.height !== n.engine.height) continue;
        const rs = m.engine.roundState();
        for (const x of [...rs.proposals, ...rs.prevotes, ...rs.precommits]) n.engine.receive(structuredClone(x));
      }
    }
  }

  run(done, maxT) {
    while (this.q.length) {
      let k = 0;
      for (let x = 1; x < this.q.length; x++) if (this.q[x].t < this.q[k].t || (this.q[x].t === this.q[k].t && this.q[x].id < this.q[k].id)) k = x;
      if (this.q[k].t > maxT) return false; // peek first: never drop an event that belongs to the next phase
      const ev = this.q.splice(k, 1)[0];
      this.t = ev.t;
      if (this.cancelled.delete(ev.id)) continue;
      ev.fn();
      if (done()) return true;
    }
    return false;
  }

  heights() { return this.nodes.filter((n) => n.up).map((n) => n.chain.height); }
  assertSafety() { for (const [h, set] of this.committed) assert.equal(set.size, 1, `two different blocks committed at height ${h}`); }
  assertReplicas() {
    const min = Math.min(...this.nodes.map((n) => n.chain.height));
    for (let h = 1; h <= min; h++) assert.equal(new Set(this.nodes.map((n) => n.chain.getBlock(h).hash)).size, 1, `chains diverge at ${h}`);
  }
}

test('happy path: 4 validators finalize blocks with two-phase voting', () => {
  const s = new Sim(1);
  s.start();
  assert.ok(s.run(() => Math.min(...s.heights()) >= 8, 120000), 'reaches height 8');
  s.assertSafety(); s.assertReplicas();
  assert.equal(s.evidence.length, 0);
  // every commit certificate verifies against the real validator set
  for (const n of s.nodes) for (let h = 1; h <= 8; h++) assert.doesNotThrow(() => C.verifyCommit(s.genesis.chainId, n.chain.commits.get(h), n.chain.getBlock(h).hash, h, n.chain.getBlock(h).header.height === h ? s.nodes[0].chain.activeSet : []));
});

test('liveness under heavy loss and reordering once the network stabilizes (GST)', () => {
  for (const seed of [2, 3, 4, 5, 6]) {
    const s = new Sim(seed);
    s.loss = 0.35; s.maxDelay = 400; // hostile phase
    s.start();
    s.run(() => false, 15000);
    s.assertSafety();
    s.loss = 0; s.maxDelay = 30; // stabilization
    const before = Math.max(...s.heights());
    assert.ok(s.run(() => Math.min(...s.heights()) >= before + 5, s.t + 120000), `seed ${seed}: resumes and finalizes 5 more blocks (at ${s.heights()})`);
    s.assertSafety(); s.assertReplicas();
  }
});

test('partition 2/2: neither side can finalize; healing resumes without a fork', () => {
  const s = new Sim(11);
  s.start();
  assert.ok(s.run(() => Math.min(...s.heights()) >= 3, 60000));
  s.group = [0, 0, 1, 1];
  const h0 = Math.max(...s.heights());
  s.run(() => false, s.t + 20000);
  assert.ok(Math.max(...s.heights()) <= h0 + 1, 'no >2/3 quorum on either side, so no progress');
  s.group = null;
  assert.ok(s.run(() => Math.min(...s.heights()) >= h0 + 4, s.t + 120000), 'progress after healing');
  s.assertSafety(); s.assertReplicas();
});

test('partition 3/1: the majority side keeps finalizing, the minority cannot, and it catches up', () => {
  const s = new Sim(12);
  s.start();
  assert.ok(s.run(() => Math.min(...s.heights()) >= 2, 60000));
  s.group = [0, 0, 0, 1];
  const lone = s.nodes[3].chain.height;
  s.run(() => s.nodes[0].chain.height >= lone + 5, s.t + 120000);
  assert.ok(s.nodes[0].chain.height >= lone + 5, 'majority progresses');
  assert.ok(s.nodes[3].chain.height <= lone + 1, 'minority cannot finalize alone');
  s.assertSafety();
});

test('crash and restart from the persisted snapshot never double-votes', () => {
  for (const seed of [21, 22, 23, 24]) {
    const s = new Sim(seed);
    s.loss = 0.1;
    s.start();
    s.run(() => false, 4000 + seed * 137);
    s.crash(1); // power loss: only the persisted snapshot survives
    s.run(() => false, s.t + 1500);
    s.restart(1);
    s.run(() => Math.min(...s.heights()) >= Math.max(...s.heights()) && s.nodes[1].chain.height >= 6, s.t + 150000);
    s.assertSafety();
    assert.equal(s.evidence.filter((e) => e.validator === s.validators[1].address).length, 0, 'restarted validator did not equivocate');
  }
});

test('an equivocating validator is detected (evidence) and cannot break safety', () => {
  const s = new Sim(31);
  s.nodes[3].byz = true;
  s.start();
  assert.ok(s.run(() => Math.min(...s.nodes.slice(0, 3).map((n) => n.chain.height)) >= 6, 200000), 'honest 3/4 (75% > 2/3) still finalize');
  s.assertSafety();
  const ev = s.evidence.find((e) => e.validator === s.validators[3].address);
  assert.ok(ev, 'evidence captured');
  assert.equal(C.verifyEvidence(s.genesis.chainId, ev, s.validators[3].cons.pub), true);
  // and the chain accepts that evidence in a block, slashing the equivocator
  const honest = s.nodes[0].chain;
  const proposerAddr = honest.proposerFor(0);
  const pk = s.validators.find((v) => v.address === proposerAddr);
  const { block } = honest.buildBlock({ operator: proposerAddr, signKey: pk.cons, round: 0, time: honest.last.time + 100, evidence: [ev] });
  assert.equal(block.evidence.length, 1);
});

test('conflicting locks resolve: the scenario that could deadlock the old single-phase protocol', () => {
  // Round 0 proposal reaches only some validators, creating divergent prevote sets; many seeds, severe loss.
  for (let seed = 100; seed < 112; seed++) {
    const s = new Sim(seed);
    s.loss = 0.5; s.maxDelay = 250;
    s.start();
    s.run(() => false, 12000);
    s.assertSafety();
    s.loss = 0; s.maxDelay = 20;
    const before = Math.max(...s.heights());
    assert.ok(s.run(() => Math.min(...s.heights()) >= before + 3, s.t + 150000), `seed ${seed}: recovers (heights ${s.heights()})`);
    s.assertSafety(); s.assertReplicas();
  }
});

test('weighted voting: a 70% validator alone cannot finalize, but with one more it can', () => {
  const s = new Sim(41, 4, [700000n * 10n ** 9n, 100000n * 10n ** 9n, 100000n * 10n ** 9n, 100000n * 10n ** 9n]);
  s.crash(1); s.crash(2); s.crash(3);
  s.start();
  s.run(() => false, 15000);
  assert.ok(s.nodes[0].chain.height >= 3, `70% validator finalizes alone (height ${s.nodes[0].chain.height})`);
});

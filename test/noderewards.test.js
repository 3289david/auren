'use strict';
// Node rewards: bond, prove storage of a challenged historical block, share the epoch pool.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR } = require('../src/util');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const NR = require('../src/noderew');

const P = { blocksPerYear: 1000, unbondingBlocks: 5, node: { bond: (50n * AUR).toString(), epochBlocks: 10, poolBps: 1000 } };

function conserved(chain) {
  let sum = 0n;
  for (const [, a] of chain.state.entries('acct')) sum += a.balance;
  for (const [, v] of chain.state.entries('val')) sum += v.tokens + v.pendingTotal;
  for (const [, u] of chain.state.entries('unb')) sum += u.amount;
  for (const [, p] of chain.state.entries('prop')) sum += p.deposit;
  for (const [, n] of chain.state.entries('node')) sum += n.bond;
  sum += chain.state.get('meta', 'nodePool') || 0n;
  assert.equal(sum, chain.supply, 'token conservation violated');
}
function setup() {
  const s = makeTestChain({ params: P });
  const run = (who, type, body) => produce(s.chain, s.validators, { candidates: [mkTx(s.chain, who, type, body)] }).res.receipts[0];
  const bal = (a) => (s.chain.state.get('acct', a.address) || { balance: 0n }).balance;
  const to = (h) => { while (s.chain.height < h) produce(s.chain, s.validators); };
  return { ...s, run, bal, to };
}
const digestFor = (chain, who, epoch) => NR.proofDigest(who.address, chain.getBlock(NR.challengeHeight(epoch, chain.params, (n) => chain.getBlock(n)?.hash)));

test('a bonded node that proves it stores the chain earns the epoch pool; others earn nothing', () => {
  const { chain, accts, run, bal, to } = setup();
  assert.equal(run(accts.alice, 'registerNode', { payout: accts.bob.address }).status, 1);
  assert.equal(run(accts.alice, 'registerNode', { payout: accts.bob.address }).code, 'NODE_EXISTS');
  to(10);
  assert.ok((chain.state.get('meta', 'nodePool') || 0n) > 0n, 'issuance feeds the pool');
  conserved(chain);
  // epoch 1 begins at height 11
  assert.equal(chain.getNodeInfo().epoch, 1);
  const good = digestFor(chain, accts.alice, 1);
  assert.equal(run(accts.carol, 'nodeProof', { epoch: 1, digest: good }).code, 'NOT_A_NODE');
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: 'ab'.repeat(32) }).code, 'BAD_PROOF');
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 2, digest: good }).code, 'WRONG_EPOCH');
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: digestFor(chain, accts.bob, 1) }).code, 'BAD_PROOF', "another node's proof cannot be copied");
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: good }).status, 1);
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: good }).code, 'ALREADY_PROVEN');
  const before = bal(accts.bob), pool = chain.state.get('meta', 'nodePool');
  to(20);
  assert.ok(bal(accts.bob) - before > 0n, 'payout address received the reward');
  assert.ok(bal(accts.bob) - before >= pool, 'the whole accumulated pool was paid (it kept growing until the epoch ended)');
  assert.ok((chain.state.get('meta', 'nodePool') || 0n) < AUR, 'pool emptied, only dust remains');
  conserved(chain);
});

test('a node registered after the epoch began cannot prove it; with no provers the pool rolls over', () => {
  const { chain, accts, run, to } = setup();
  to(10);
  assert.equal(run(accts.alice, 'registerNode', { payout: accts.alice.address }).status, 1);
  const d = digestFor(chain, accts.alice, 1);
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: d }).code, 'NODE_TOO_NEW');
  const pool = chain.state.get('meta', 'nodePool');
  to(20);
  assert.ok(chain.state.get('meta', 'nodePool') >= pool, 'unclaimed pool rolls over');
  conserved(chain);
});

test('registering needs the bond; unregistering returns it after the unbonding period', () => {
  const { chain, accts, run, bal, to } = setup();
  assert.equal(run(accts.alice, 'nodeProof', { epoch: 1, digest: 'cd'.repeat(32) }).code, 'NOT_A_NODE');
  const start = bal(accts.alice);
  run(accts.alice, 'registerNode', { payout: accts.alice.address });
  assert.ok(start - bal(accts.alice) >= 50n * AUR, 'bond is locked');
  assert.equal(run(accts.alice, 'unregisterNode', {}).status, 1);
  assert.equal(chain.state.has('node', accts.alice.address), false);
  to(chain.height + 6);
  assert.ok(start - bal(accts.alice) < AUR, 'bond came back (minus fees)');
  conserved(chain);
});

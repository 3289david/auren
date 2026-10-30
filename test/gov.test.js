'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR } = require('../src/util');
const { Chain } = require('../src/chain');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const { checkTx } = require('../src/tx');

const GOV = { votingBlocks: 10, timelockBlocks: 5, deposit: (100n * AUR).toString(), quorumBps: 3340, thresholdBps: 5000, vetoBps: 3340 };
const P = { blocksPerYear: 1000, unbondingBlocks: 5, governance: GOV };

/** supply == liquid + bonded + unbonding + accrued rewards + governance deposits held in escrow */
function assertConserved(chain) {
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
  const voter = (i) => ({ kp: s.validators[i].op, address: s.validators[i].address });
  const run = (who, type, body) => produce(s.chain, s.validators, { candidates: [mkTx(s.chain, who, type, body)] }).res.receipts[0];
  const advance = (n) => { for (let i = 0; i < n; i++) produce(s.chain, s.validators); };
  const propose = (changes, who = s.accts.alice) => run(who, 'submitProposal', { title: 'Test proposal', description: 'for tests', changes });
  const prop = (id) => s.chain.getProposals().find((p) => p.id === id);
  return { ...s, voter, run, advance, propose, prop };
}

test('a passed proposal waits out its timelock, then changes live parameters', () => {
  const { chain, voter, run, advance, propose, prop } = setup();
  const before = chain.params.limits.compute;
  assert.equal(propose({ 'limits.compute': 40000000 }).status, 1);
  assertConserved(chain); // deposit is escrowed, not lost
  const p1 = prop(1);
  assert.equal(p1.status, 'voting');
  for (const i of [0, 1, 2]) assert.equal(run(voter(i), 'vote', { id: 1, option: 'yes' }).status, 1);
  advance(p1.votingEnd - chain.height);
  assert.equal(prop(1).status, 'passed');
  assert.equal(prop(1).tally.yes > 0n || BigInt(prop(1).tally.yes) > 0n, true);
  assertConserved(chain);
  assert.equal(chain.params.limits.compute, before, 'not yet: timelock');
  advance(prop(1).executeAt - chain.height - 1);
  assert.equal(chain.params.limits.compute, before, 'still timelocked one block before');
  advance(1);
  assert.equal(prop(1).status, 'executed');
  assert.equal(chain.params.limits.compute, 40000000, 'live parameter changed');
  assertConserved(chain);
  // deposit came back to the proposer: only fees were spent
  const alice = chain.state.get('acct', require('../src/devkit').devAccount('alice').address);
  assert.ok(alice.balance > 1000000n * AUR - 5n * AUR);
});

test('governance changes real behaviour: name price after a passed proposal', () => {
  const { chain, voter, run, advance, propose, prop, accts } = setup();
  propose({ 'domain.price5': (7n * AUR).toString() });
  for (const i of [0, 1, 2, 3]) run(voter(i), 'vote', { id: 1, option: 'yes' });
  advance(prop(1).votingEnd + GOV.timelockBlocks + 1 - chain.height);
  assert.equal(prop(1).status, 'executed');
  const burned0 = chain.burned;
  run(accts.bob, 'registerDomain', { name: 'govname', years: 1 });
  assert.ok(chain.burned - burned0 >= 7n * AUR, 'registration now burns 7 AUR');
  assertConserved(chain);
});

test('no quorum: rejected and the deposit is burned', () => {
  const { chain, run, advance, propose, prop, accts } = setup();
  const burned0 = chain.burned;
  propose({ maxValidators: 50 });
  // alice stakes 1000 AUR (0.25% of bonded stake) and votes: far below the 33.4% quorum
  run(accts.alice, 'delegate', { validator: chain.getValidators()[0].operator, amount: (1000n * AUR).toString() });
  run(accts.alice, 'vote', { id: 1, option: 'yes' });
  advance(prop(1).votingEnd - chain.height);
  assert.equal(prop(1).status, 'rejected');
  assert.equal(prop(1).reason, 'no quorum');
  assert.equal(chain.burned - burned0 >= 100n * AUR, true, 'deposit burned');
  assert.equal(chain.params.maxValidators, 150);
  assertConserved(chain);
});

test('veto: >= 33.4% NoWithVeto rejects and burns the deposit', () => {
  const { chain, voter, run, advance, propose, prop } = setup();
  const burned0 = chain.burned;
  propose({ 'slashing.doubleSignBps': 0 });
  run(voter(0), 'vote', { id: 1, option: 'veto' });
  run(voter(1), 'vote', { id: 1, option: 'veto' });
  run(voter(2), 'vote', { id: 1, option: 'yes' });
  advance(prop(1).votingEnd - chain.height);
  assert.equal(prop(1).status, 'rejected');
  assert.equal(prop(1).reason, 'vetoed');
  assert.ok(chain.burned - burned0 >= 100n * AUR);
  assertConserved(chain);
});

test('threshold: quorum reached but yes <= 50%: rejected, deposit refunded', () => {
  const { chain, voter, run, advance, propose, prop } = setup();
  const burned0 = chain.burned;
  propose({ 'limits.state': 300000 });
  run(voter(0), 'vote', { id: 1, option: 'yes' });
  run(voter(1), 'vote', { id: 1, option: 'no' });
  run(voter(2), 'vote', { id: 1, option: 'no' });
  advance(prop(1).votingEnd - chain.height);
  assert.equal(prop(1).status, 'rejected');
  assert.equal(prop(1).reason, 'threshold not reached');
  assert.ok(chain.burned - burned0 < 100n * AUR, 'deposit not burned');
  assertConserved(chain);
});

test('abstain counts toward quorum but not toward the threshold', () => {
  const { chain, voter, run, advance, propose, prop } = setup();
  propose({ 'limits.state': 300000 });
  run(voter(0), 'vote', { id: 1, option: 'abstain' });
  run(voter(1), 'vote', { id: 1, option: 'abstain' });
  run(voter(2), 'vote', { id: 1, option: 'yes' });
  advance(prop(1).votingEnd - chain.height);
  assert.equal(prop(1).status, 'passed');
});

test('voting rules: weight is bonded stake, votes can change, closed after the period', () => {
  const { chain, voter, run, advance, propose, prop, accts } = setup();
  propose({ 'limits.state': 300000 });
  assert.equal(run(accts.bob, 'vote', { id: 1, option: 'yes' }).status, 1); // no stake: accepted but weightless
  run(voter(0), 'vote', { id: 1, option: 'no' });
  run(voter(0), 'vote', { id: 1, option: 'yes' }); // changes the vote
  assert.equal(run(voter(0), 'vote', { id: 99, option: 'yes' }).code, 'NO_SUCH_PROPOSAL');
  const t = prop(1).tally;
  assert.equal(BigInt(t.no), 0n);
  assert.equal(BigInt(t.yes), 100000n * AUR, 'exactly one validator operator worth of stake, bob counts for nothing');
  advance(prop(1).votingEnd - chain.height);
  assert.equal(run(voter(1), 'vote', { id: 1, option: 'yes' }).code, 'VOTING_CLOSED');
});

test('invalid proposals never reach a block', () => {
  const { chain, accts } = setup();
  const bad = [
    { 'addressPrefix': 'evil' }, { 'blockTimeMs': 1 }, { 'limits.compute': 5 }, { 'maxValidators': 3 }, { 'issuance.floorPpm': 999999 },
    {}, { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, { 'limits.compute': '40000000' },
  ];
  for (const changes of bad) {
    assert.throws(() => checkTx(mkTx(chain, accts.alice, 'submitProposal', { title: 't', description: '', changes }), chain.params, chain.chainId), { code: 'BAD_BODY' }, JSON.stringify(changes));
  }
  assert.throws(() => checkTx(mkTx(chain, accts.alice, 'submitProposal', { title: '', description: '', changes: { maxValidators: 50 } }), chain.params, chain.chainId), { code: 'BAD_BODY' });
  assert.throws(() => checkTx(mkTx(chain, accts.alice, 'vote', { id: 1, option: 'maybe' }), chain.params, chain.chainId), { code: 'BAD_BODY' });
});

test('a proposer without the deposit fails cleanly', () => {
  const { chain, advance, propose, accts, run } = setup();
  void advance; void chain;
  const poor = { ...accts.dave };
  run(accts.dave, 'transfer', { to: accts.alice.address, amount: (999950n * AUR).toString() });
  assert.equal(propose({ maxValidators: 50 }, poor).code, 'INSUFFICIENT_DEPOSIT');
});

test('replay: a second node reaches identical parameters and state after governance changes', () => {
  const { chain, voter, run, advance, propose, prop, genesis, validators } = setup();
  void validators;
  propose({ 'limits.compute': 35000000 });
  for (const i of [0, 1, 2]) run(voter(i), 'vote', { id: 1, option: 'yes' });
  advance(prop(1).votingEnd + GOV.timelockBlocks + 3 - chain.height);
  assert.equal(chain.params.limits.compute, 35000000);
  const replica = new Chain(genesis);
  for (let h = 1; h <= chain.height; h++) replica.applyBlock(chain.getBlock(h), chain.commits.get(h));
  assert.equal(replica.params.limits.compute, 35000000);
  assert.equal(replica.state.root(), chain.state.root());
  assertConserved(replica);
});

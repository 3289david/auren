'use strict';
// Randomized Proof Consensus rewards: the beacon, the draw, and paying the committee every block.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR } = require('../src/util');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const NR = require('../src/noderew');
const D = require('../src/draw');

const P = { blocksPerYear: 1000, node: { bond: (50n * AUR).toString(), epochBlocks: 10, poolBps: 1000 }, rpc: { poolBps: 500, committeeSize: 2 } };

function conserved(chain) {
  let sum = 0n;
  for (const [, a] of chain.state.entries('acct')) sum += a.balance;
  for (const [, v] of chain.state.entries('val')) sum += v.tokens + v.pendingTotal;
  for (const [, u] of chain.state.entries('unb')) sum += u.amount;
  for (const [, p] of chain.state.entries('prop')) sum += p.deposit;
  for (const [, n] of chain.state.entries('node')) sum += n.bond;
  sum += (chain.state.get('meta', 'nodePool') || 0n) + (chain.state.get('meta', 'rpcPool') || 0n);
  assert.equal(sum, chain.supply, 'token conservation violated');
}
const digestFor = (chain, who, epoch) => NR.proofDigest(who.address, chain.getBlock(NR.challengeHeight(epoch, chain.params, (n) => chain.getBlock(n)?.hash)));

test('the draw is deterministic, distinct and uniform over ticket holders', () => {
  assert.deepEqual(D.pick('ab'.repeat(32), 50, 7), D.pick('ab'.repeat(32), 50, 7), 'same beacon, same committee');
  const n = 10, k = 3, rounds = 6000, wins = new Array(n).fill(0);
  for (let r = 0; r < rounds; r++) {
    const idx = D.pick(String(r).padStart(64, '0'), n, k);
    assert.equal(new Set(idx).size, k, 'no one is drawn twice in a round');
    for (const i of idx) wins[i]++;
  }
  const expect = (rounds * k) / n; // 1800
  for (const w of wins) assert.ok(Math.abs(w - expect) < expect * 0.1, `each identity wins about equally (${w} vs ${expect})`);
  assert.deepEqual(D.pick('00'.repeat(32), 2, 7).length, 2, 'a small network draws everyone');
});

test('the beacon changes every block and depends on the finalizing signatures', () => {
  const g = D.genesisBeacon('x');
  const a = D.nextBeacon(g, { votes: [{ sig: 'aa' }, { sig: 'bb' }] }), b = D.nextBeacon(g, { votes: [{ sig: 'bb' }, { sig: 'aa' }] });
  assert.equal(a, b, 'order of the votes does not matter');
  assert.notEqual(a, D.nextBeacon(g, { votes: [{ sig: 'aa' }, { sig: 'cc' }] }));
  assert.notEqual(a, g);
});

test('only ticket holders are paid, every block, and the money is conserved', () => {
  const s = makeTestChain({ params: P });
  const { chain, validators, accts } = s;
  const run = (who, type, body) => produce(chain, validators, { candidates: [mkTx(chain, who, type, body)] }).res.receipts[0];
  const bal = (a) => (chain.state.get('acct', a.address) || { balance: 0n }).balance;
  const to = (h) => { while (chain.height < h) produce(chain, validators); };
  for (const who of [accts.alice, accts.bob, accts.carol, accts.dave]) assert.equal(run(who, 'registerNode', { payout: who.address }).status, 1);
  to(10);
  assert.equal(D.ticketHolders(chain.state, chain.params, chain.height + 1).length, 0, 'no ticket before the first proof');
  // epoch 1: alice, bob and carol prove storage; dave does not
  for (const who of [accts.alice, accts.bob, accts.carol]) assert.equal(run(who, 'nodeProof', { epoch: 1, digest: digestFor(chain, who, 1) }).status, 1);
  assert.equal(D.ticketHolders(chain.state, chain.params, chain.height + 1).length, 3);
  const before = { alice: bal(accts.alice), bob: bal(accts.bob), carol: bal(accts.carol), dave: bal(accts.dave) };
  const won = new Set(); let draws = 0;
  for (let k = 0; k < 8; k++) {
    produce(chain, validators);
    const d = chain.state.get('meta', 'lastDraw');
    if (d && d.height === chain.height) {
      draws++;
      assert.equal(d.winners.length, 2, 'the committee has the configured size');
      assert.equal(new Set(d.winners).size, 2, 'distinct winners');
      for (const w of d.winners) won.add(w);
    }
  }
  assert.ok(draws >= 6, 'a draw is paid in (almost) every block, got ' + draws);
  assert.ok(!won.has(accts.dave.address), 'a bonded node without a ticket never wins');
  assert.ok(won.size >= 2, 'different identities win over time');
  assert.ok(bal(accts.alice) + bal(accts.bob) + bal(accts.carol) > before.alice + before.bob + before.carol, 'winners were paid');
  assert.equal(bal(accts.dave), before.dave, 'dave earned nothing');
  conserved(chain);
});

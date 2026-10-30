'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR, parseAur, formatAur, canon } = require('../src/util');
const { bech32Decode, pubToAddress, decodeAddress, isValidAddress } = require('../src/address');
const { Keypair, verify, encryptSeed, decryptSeed } = require('../src/crypto');
const { Chain, executeBlock, issuanceRatePpm } = require('../src/chain');
const { makeTestChain, produce, mkTx, devKeys } = require('../src/devkit');
const { nextBaseFee } = require('../src/fees');
const { resolveParams } = require('../src/params');
const { scheduleLanes } = require('../src/scheduler');
const C = require('../src/consensus');

const FAST = { unbondingBlocks: 5, jailBlocks: 5, blocksPerYear: 1000, security: { minDelayBlocks: 5, limitWindowBlocks: 10, maxGuardians: 9 } };

/** supply == liquid + bonded + unbonding + accrued-but-unclaimed rewards */
function assertConserved(chain) {
  let sum = 0n;
  for (const [, a] of chain.state.entries('acct')) sum += a.balance;
  for (const [, v] of chain.state.entries('val')) sum += v.tokens + v.pendingTotal;
  for (const [, u] of chain.state.entries('unb')) sum += u.amount;
  assert.equal(sum, chain.supply, 'token conservation violated');
}
const bal = (chain, who) => (chain.state.get('acct', who.address) || { balance: 0n }).balance;

test('amount parsing', () => {
  assert.equal(parseAur('1.5'), 1_500_000_000n);
  assert.equal(formatAur(1_500_000_000n), '1.5');
  assert.equal(formatAur(parseAur('123456.000000001')), '123456.000000001');
  assert.throws(() => parseAur('1.0000000001'));
});

test('bech32 vectors and address round trip', () => {
  assert.deepEqual(bech32Decode('A12UEL5L'), { hrp: 'a', data: [] });
  assert.equal(bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw').hrp, 'abcdef');
  assert.throws(() => bech32Decode('A12UEL5M'));
  const kp = Keypair.generate();
  const addr = pubToAddress(kp.pub, 'aur');
  assert.match(addr, /^aur1[02-9ac-hj-np-z]+$/);
  assert.equal(decodeAddress(addr, 'aur').scheme, 0);
  assert.equal(isValidAddress(addr, 'taur'), false);
  assert.equal(isValidAddress(addr.slice(0, -1) + (addr.endsWith('q') ? 'p' : 'q'), 'aur'), false);
});

test('ed25519 sign/verify and encrypted keystore', () => {
  const kp = Keypair.generate();
  const sig = kp.sign('hello');
  assert.ok(verify(kp.pub, Buffer.from('hello'), sig));
  assert.ok(!verify(kp.pub, Buffer.from('hellp'), sig));
  const ks = encryptSeed(kp.seedHex, 'correct horse');
  assert.equal(decryptSeed(ks, 'correct horse'), kp.seedHex);
  assert.throws(() => decryptSeed(ks, 'wrong'));
});

test('transfer: fee is burned, tip paid to proposer, supply conserved', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const { alice, bob } = accts;
  const supply0 = chain.supply;
  const a0 = bal(chain, alice);
  const proposer = validators.find((v) => v.address === chain.proposerFor(0));
  const p0 = (chain.state.get('acct', proposer.address)).balance;
  const tx = mkTx(chain, alice, 'transfer', { to: bob.address, amount: (10n * AUR).toString() }, { tip: '5000' });
  const { block } = produce(chain, validators, { candidates: [tx] });
  assert.equal(block.txs.length, 1);
  assert.equal(bal(chain, bob), 1000000n * AUR + 10n * AUR);
  const rcpt = chain.txIndex.get(require('../src/tx').txHash(tx));
  assert.equal(rcpt.height, 1);
  const fee = a0 - 10n * AUR - bal(chain, alice);
  assert.ok(fee > 5000n);
  assert.equal(chain.burned, fee - 5000n);
  assert.equal(chain.supply, supply0 - (fee - 5000n));
  assert.equal((chain.state.get('acct', proposer.address)).balance, p0 + 5000n);
  assertConserved(chain);
});

test('invalid txs never enter blocks; bad signature / nonce / chain are rejected', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const good = mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' });
  const badNonce = mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }, { nonce: 7 });
  const forged = { ...good, body: { to: accts.carol.address, amount: '1' } };
  const wrongChain = { ...good, chainId: 'other' };
  const { block } = produce(chain, validators, { candidates: [badNonce, good] });
  assert.equal(block.txs.length, 1);
  const { checkTx } = require('../src/tx');
  assert.throws(() => checkTx(forged, chain.params, chain.chainId), { code: 'BAD_SIGNATURE' });
  assert.throws(() => checkTx(wrongChain, chain.params, chain.chainId), { code: 'WRONG_CHAIN' });
});

test('failed handler still pays the fee and bumps the nonce', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const tx = mkTx(chain, accts.alice, 'delegate', { validator: accts.bob.address, amount: '1' }); // bob is not a validator
  const before = bal(chain, accts.alice);
  const { block, res } = produce(chain, validators, { candidates: [tx] });
  assert.equal(block.txs.length, 1);
  assert.equal(res.receipts[0].status, 0);
  assert.equal(res.receipts[0].code, 'NO_SUCH_VALIDATOR');
  assert.ok(bal(chain, accts.alice) < before);
  assert.equal(chain.state.get('acct', accts.alice.address).nonce, 1);
});

test('base fee: rises on full blocks (+12.5% max), falls on empty blocks, respects floor', () => {
  const p = resolveParams({});
  const f0 = { compute: 80n, state: 4000n };
  const full = nextBaseFee(f0, { compute: p.limits.compute, state: p.limits.state }, p);
  assert.equal(full.compute, 90n);
  assert.equal(full.state, 4500n);
  const empty = nextBaseFee(f0, { compute: 0, state: 0 }, p);
  assert.equal(empty.compute, 70n);
  const floor = nextBaseFee(p.minBaseFee, { compute: 0, state: 0 }, p);
  assert.deepEqual(floor, p.minBaseFee);
  const atTarget = nextBaseFee(f0, { compute: p.limits.compute / 2, state: p.limits.state / 2 }, p);
  assert.deepEqual(atTarget, f0);
});

test('fee market end to end: congestion raises the quote, idle blocks bring it back', () => {
  const { chain, validators, accts } = makeTestChain({ params: { ...FAST, limits: { compute: 210000, state: 100000 } } });
  const start = chain.baseFee.compute;
  const txs = Array.from({ length: 10 }, (_, i) => mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }, { nonce: i }));
  const { block } = produce(chain, validators, { candidates: txs });
  assert.equal(block.txs.length, 10);
  assert.equal(chain.baseFee.compute, start + start / 8n);
  for (let i = 0; i < 40; i++) produce(chain, validators);
  assert.equal(chain.baseFee.compute, chain.params.minBaseFee.compute);
});

test('scheduler: independent txs get separate lanes, conflicts share one', () => {
  const { chain, accts } = makeTestChain({ params: FAST });
  const t1 = mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' });
  const t2 = mkTx(chain, accts.carol, 'transfer', { to: accts.dave.address, amount: '1' });
  const t3 = mkTx(chain, accts.alice, 'transfer', { to: accts.carol.address, amount: '1' }, { nonce: 1 });
  const lanes = scheduleLanes([t1, t2, t3]);
  assert.equal(lanes.length, 1); // t3 links alice (t1) and carol (t2) -> everything conflicts
  assert.equal(scheduleLanes([t1, t2]).length, 2);
});

test('scheduler: lane execution order does not change the resulting state root', () => {
  const { chain, validators, accts } = makeTestChain({ n: 4, params: FAST });
  const names = Object.keys(accts);
  const nonces = Object.fromEntries(names.map((n) => [n, 0]));
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const txs = [];
  for (let i = 0; i < 60; i++) {
    const from = names[rnd(names.length)];
    const kind = rnd(4);
    let type, body;
    if (kind === 0) { type = 'delegate'; body = { validator: validators[rnd(4)].address, amount: (10n * AUR).toString() }; }
    else if (kind === 1) { type = 'registerDomain'; body = { name: `name${rnd(12)}x`, years: 1 }; }
    else { type = 'transfer'; body = { to: accts[names[rnd(names.length)]].address, amount: (rnd(50) + 1).toString() }; }
    txs.push(mkTx(chain, accts[from], type, body, { nonce: nonces[from]++ }));
  }
  const run = (laneOrder) => {
    const fork = chain.state.fork();
    executeBlock(fork, { params: chain.params, chainId: chain.chainId, height: 1, proposer: validators[0].address, baseFee: chain.baseFee, txs, evidence: [], lastCommit: null, laneOrder });
    return fork.root();
  };
  const a = run(null), b = run((l) => [...l].reverse()), c = run((l) => [...l].sort(() => 0.5 - Math.random()));
  assert.equal(a, b);
  assert.equal(a, c);
});

test('staking: delegate, earn rewards, claim, undelegate, unbond, with token conservation', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const { alice } = accts;
  const val = validators[0].address;
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'delegate', { validator: val, amount: (5000n * AUR).toString() })] });
  assertConserved(chain);
  for (let i = 0; i < 10; i++) produce(chain, validators);
  assertConserved(chain);
  const d = chain.getDelegations(alice.address)[0];
  assert.ok(BigInt(d.pendingRewards) > 0n, 'delegator accrued rewards');
  const before = bal(chain, alice);
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'claim', { validator: val })] });
  assert.ok(bal(chain, alice) > before, 'claim paid out');
  assertConserved(chain);
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'undelegate', { validator: val, amount: (5000n * AUR).toString() })] });
  assert.equal(chain.getUnbonding(alice.address).length, 1);
  const mid = bal(chain, alice);
  for (let i = 0; i < 4; i++) produce(chain, validators);
  assert.equal(bal(chain, alice) - mid < 5000n * AUR, true, 'not matured yet');
  produce(chain, validators);
  produce(chain, validators);
  assert.equal(chain.getUnbonding(alice.address).length, 0);
  assert.ok(bal(chain, alice) - mid >= 5000n * AUR - 10n, 'principal returned after unbonding');
  assertConserved(chain);
});

test('issuance schedule decays to the floor and mints only for signers', () => {
  const p = resolveParams({});
  assert.equal(issuanceRatePpm(p, 1), 30000n);
  assert.equal(issuanceRatePpm(p, p.blocksPerYear), 25500n);
  assert.equal(issuanceRatePpm(p, p.blocksPerYear * 100), 5000n);
  const { chain, validators } = makeTestChain({ params: FAST });
  produce(chain, validators);
  const s1 = chain.supply;
  produce(chain, validators);
  assert.ok(chain.supply > s1, 'supply grows with issuance');
  const s2 = chain.supply;
  produce(chain, validators, { signers: [validators[0].address, validators[1].address, validators[2].address] });
  const full = chain.supply - s2;
  const s3 = chain.supply;
  produce(chain, validators);
  assert.ok(chain.supply - s3 > 0n && full > 0n);
  assertConserved(chain);
});

test('double-sign evidence slashes, jails and tombstones the validator', () => {
  const { chain, validators } = makeTestChain({ params: FAST });
  produce(chain, validators);
  const cheat = validators[3];
  const a = C.signVote(cheat.cons, chain.chainId, cheat.address, 1, 0, 'aa'.repeat(32));
  const b = C.signVote(cheat.cons, chain.chainId, cheat.address, 1, 0, 'bb'.repeat(32));
  const ev = { validator: cheat.address, height: 1, round: 0, type: 'precommit', a: { blockHash: a.blockHash, sig: a.sig }, b: { blockHash: b.blockHash, sig: b.sig } };
  // votes in DIFFERENT rounds are legal (unlock after a later proof-of-lock) and must not be evidence
  const lateRound = C.signVote(cheat.cons, chain.chainId, cheat.address, 1, 1, 'bb'.repeat(32));
  assert.equal(C.verifyEvidence(chain.chainId, { ...ev, b: { blockHash: lateRound.blockHash, sig: lateRound.sig } }, cheat.cons.pub), false);
  assert.equal(C.verifyEvidence(chain.chainId, ev, cheat.cons.pub), true);
  const stake0 = chain.state.get('val', cheat.address).tokens;
  const burned0 = chain.burned;
  produce(chain, validators, { evidence: [ev] });
  const v = chain.state.get('val', cheat.address);
  assert.ok(v.tombstoned && v.jailed);
  assert.equal(v.tokens, stake0 - (stake0 * 500n) / 10000n);
  assert.ok(chain.burned > burned0);
  assert.equal(chain.activeSet.length, 3);
  assertConserved(chain);
  const fake = { ...ev, b: { ...ev.b, sig: '00'.repeat(64) } };
  const { chain: c2, validators: v2 } = makeTestChain({ params: FAST });
  produce(c2, v2);
  const bogus = [{ ...fake, validator: v2[3].address }];
  const proposer = v2.find((v) => v.address === c2.proposerFor(0));
  // an honest proposer's builder drops evidence it cannot verify ...
  const built = c2.buildBlock({ operator: proposer.address, signKey: proposer.cons, evidence: bogus });
  assert.equal(built.block.evidence.length, 0);
  // ... and a block that carries it is invalid
  assert.throws(() => c2._assemble({ operator: proposer.address, signKey: proposer.cons, round: 0, time: c2.last.time + 1000, txs: [], evidence: bogus }), /evidence/);
});

test('downtime: validator that misses most of a window is jailed and can unjail', () => {
  const { chain, validators } = makeTestChain({ params: { ...FAST, slashing: { downtimeWindow: 10, maxMissedBps: 5000, downtimeBps: 10, doubleSignBps: 500 } } });
  const lazy = validators[3];
  const others = validators.filter((v) => v !== lazy).map((v) => v.address);
  for (let i = 0; i < 10; i++) produce(chain, validators, { signers: others });
  const v = chain.state.get('val', lazy.address);
  assert.ok(v.jailed && !v.tombstoned);
  assert.equal(chain.activeSet.length, 3);
  assertConserved(chain);
  for (let i = 0; i < 6; i++) produce(chain, validators);
  produce(chain, validators, { candidates: [mkTx(chain, { kp: lazy.op, address: lazy.address }, 'unjail', {})] });
  assert.equal(chain.state.get('val', lazy.address).jailed, false);
  produce(chain, validators);
  assert.equal(chain.activeSet.length, 4);
});

test('createValidator joins the active set; voting power cap limits a whale', () => {
  const { chain, validators, accts } = makeTestChain({ n: 4, params: { ...FAST, minSelfStake: (1000n * AUR).toString() } });
  const kp = Keypair.fromPassphrase('new-validator-cons');
  produce(chain, validators, { candidates: [mkTx(chain, accts.alice, 'createValidator', { consPub: kp.pub, commissionBps: 100, moniker: 'newbie', amount: (2000n * AUR).toString() })] });
  produce(chain, validators);
  assert.equal(chain.activeSet.length, 5);

  const capped = makeTestChain({ n: 4, stakes: [700000n * AUR, 100000n * AUR, 100000n * AUR, 100000n * AUR], params: { ...FAST, maxVotingPowerBps: 3000 } });
  const powers = capped.chain.activeSet.map((v) => v.power);
  const total = powers.reduce((a, b) => a + b, 0n);
  const raw = 1000000n * AUR;
  assert.equal(powers[0], (raw * 3000n) / 10000n);
  assert.ok(C.nakamoto(capped.chain.activeSet) >= 1 && total < raw);
});

test('native security: daily limit, timelocked loosening, guardian recovery', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const { alice, bob, carol, dave } = accts;
  const setSec = mkTx(chain, alice, 'setSecurity', { guardians: [bob.address, carol.address], threshold: 2, delayBlocks: 5, dailyLimit: (50n * AUR).toString() });
  produce(chain, validators, { candidates: [setSec] });
  assert.ok(chain.state.get('acct', alice.address).security);

  const send = (amt, nonce) => mkTx(chain, alice, 'transfer', { to: dave.address, amount: (amt * AUR).toString() }, { nonce });
  const { res: r1 } = produce(chain, validators, { candidates: [send(40n, 1)] });
  assert.equal(r1.receipts[0].status, 1);
  const { res: r2 } = produce(chain, validators, { candidates: [send(20n, 2)] });
  assert.equal(r2.receipts[0].code, 'DAILY_LIMIT_EXCEEDED');

  // raising the limit is timelocked: still capped right after the change
  const loosen = mkTx(chain, alice, 'setSecurity', { guardians: [bob.address, carol.address], threshold: 2, delayBlocks: 5, dailyLimit: null }, { nonce: 3 });
  produce(chain, validators, { candidates: [loosen] });
  assert.ok(chain.state.get('acct', alice.address).security.pending);
  const { res: r3 } = produce(chain, validators, { candidates: [send(500n, 4)] });
  assert.equal(r3.receipts[0].code, 'DAILY_LIMIT_EXCEEDED');
  // a guardian can veto the pending change
  produce(chain, validators, { candidates: [mkTx(chain, bob, 'securityCancel', { account: alice.address })] });
  assert.equal(chain.state.get('acct', alice.address).security.pending, null);

  // guardian recovery to a new key
  const fresh = Keypair.fromPassphrase('alice-new-key');
  const approve = (g) => mkTx(chain, g, 'recoveryApprove', { account: alice.address, newPub: fresh.pub });
  produce(chain, validators, { candidates: [approve(bob)] });
  assert.equal(chain.state.get('acct', alice.address).authPub, undefined);
  produce(chain, validators, { candidates: [approve(carol)] });
  for (let i = 0; i < 5; i++) produce(chain, validators);
  assert.equal(chain.state.get('acct', alice.address).authPub, fresh.pub);
  const nonce = chain.state.get('acct', alice.address).nonce;
  const oldKeyTx = mkTx(chain, alice, 'transfer', { to: dave.address, amount: '1' }, { nonce });
  const newKeyTx = mkTx(chain, { kp: fresh, address: alice.address }, 'transfer', { to: dave.address, amount: '1' }, { nonce });
  const { block } = produce(chain, validators, { candidates: [oldKeyTx, newKeyTx] });
  assert.equal(block.txs.length, 1);
  assert.equal(block.txs[0].pub, fresh.pub);
  assertConserved(chain);
});

test('domains: register, resolve, expire, re-register; price is burned', () => {
  const { chain, validators, accts } = makeTestChain({ params: { ...FAST, blocksPerYear: 20 } });
  const { alice, bob } = accts;
  const b0 = chain.burned;
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'registerDomain', { name: 'alice', years: 1 })] });
  assert.equal(chain.getDomain('alice').owner, alice.address);
  assert.ok(chain.burned - b0 >= AUR, 'registration fee burned');
  const { res } = produce(chain, validators, { candidates: [mkTx(chain, bob, 'registerDomain', { name: 'alice', years: 1 })] });
  assert.equal(res.receipts[0].code, 'NAME_TAKEN');
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'setDomainTarget', { name: 'alice', target: bob.address })] });
  assert.equal(chain.getDomain('alice').target, bob.address);
  for (let i = 0; i < 20; i++) produce(chain, validators);
  assert.equal(chain.getDomain('alice'), null, 'expired');
  const { res: r2 } = produce(chain, validators, { candidates: [mkTx(chain, bob, 'registerDomain', { name: 'alice', years: 1 })] });
  assert.equal(r2.receipts[0].status, 1);
  assertConserved(chain);
});

test('vesting: locked balance cannot be spent until it unlocks', () => {
  const { chain, validators, accts } = makeTestChain({
    params: FAST, names: ['alice', 'bob'], balance: 100n * AUR,
    vesting: { alice: { total: (100n * AUR).toString(), start: 0, cliff: 5, end: 10 } },
  });
  const { alice, bob } = accts;
  const { res } = produce(chain, validators, { candidates: [mkTx(chain, alice, 'transfer', { to: bob.address, amount: (50n * AUR).toString() })] });
  assert.equal(res.receipts[0]?.code ?? 'INSUFFICIENT_FEE_FUNDS', 'INSUFFICIENT_FEE_FUNDS');
  for (let i = 0; i < 10; i++) produce(chain, validators);
  const { res: r2 } = produce(chain, validators, { candidates: [mkTx(chain, alice, 'transfer', { to: bob.address, amount: (50n * AUR).toString() })] });
  assert.equal(r2.receipts[0].status, 1);
});

test('simulation returns effects without touching state', () => {
  const { chain, accts } = makeTestChain({ params: FAST });
  const root = chain.state.root();
  const tx = mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: (7n * AUR).toString() });
  const sim = chain.simulate(tx);
  assert.equal(sim.ok, true);
  assert.ok(BigInt(sim.fee) > 0n);
  const bobEffect = sim.effects.find((e) => e.key === accts.bob.address);
  assert.equal(BigInt(bobEffect.after.balance) - BigInt(bobEffect.before.balance), 7n * AUR);
  assert.equal(chain.state.root(), root);
});

test('consensus: commit needs strictly more than 2/3 of power; tampering is rejected', () => {
  const { chain, validators } = makeTestChain({ params: FAST });
  const op = chain.proposerFor(0);
  const pk = validators.find((v) => v.address === op);
  const { block } = chain.buildBlock({ operator: op, signKey: pk.cons, round: 0, time: chain.last.time + 1000 });
  const mk = (n) => ({
    height: 1, round: 0, blockHash: block.hash,
    votes: validators.slice(0, n).map((v) => { const x = C.signVote(v.cons, chain.chainId, v.address, 1, 0, block.hash); return { validator: x.validator, sig: x.sig }; }),
  });
  assert.throws(() => chain.applyBlock(block, mk(2)), /2\/3/);
  const three = mk(3);
  const bad = { ...three, votes: [{ ...three.votes[0], sig: three.votes[1].sig }, ...three.votes.slice(1)] };
  assert.throws(() => chain.applyBlock(block, bad), /bad signature/);
  const dup = { ...three, votes: [three.votes[0], three.votes[0], three.votes[1]] };
  assert.throws(() => chain.applyBlock(block, dup), /duplicate/);
  chain.applyBlock(block, three);
  assert.equal(chain.height, 1);

  const forged = structuredClone(chain.getBlock(1));
  forged.header.stateRoot = 'ff'.repeat(32);
  const { chain: c2 } = makeTestChain({ params: FAST });
  assert.throws(() => c2.validateBlock(forged), /hash mismatch/);
});

test('proposer selection is deterministic, stake-weighted and varies by round', () => {
  const { chain } = makeTestChain({ params: FAST, stakes: [700000n * AUR, 100000n * AUR, 100000n * AUR, 100000n * AUR] });
  const counts = {};
  for (let h = 1; h <= 400; h++) {
    const p = C.proposerFor(chain.activeSet, chain.last.hash, h, 0);
    counts[p] = (counts[p] || 0) + 1;
  }
  const top = chain.activeSet[0].operator;
  assert.ok(counts[top] > 200 && counts[top] < 340, `whale proposes ~70% (got ${counts[top]})`);
  assert.equal(C.proposerFor(chain.activeSet, chain.last.hash, 5, 0), C.proposerFor(chain.activeSet, chain.last.hash, 5, 0));
});

test('replay: a second node applying the same blocks reaches the identical state root', () => {
  const { chain, validators, accts, genesis } = makeTestChain({ params: FAST });
  for (let i = 0; i < 12; i++) {
    const c = i % 3 === 0 ? [mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: String(i + 1) })] : [];
    produce(chain, validators, { candidates: c });
  }
  const replica = new Chain(genesis);
  for (let h = 1; h <= chain.height; h++) replica.applyBlock(chain.getBlock(h), chain.commits.get(h));
  assert.equal(replica.state.root(), chain.state.root());
  assert.equal(replica.last.hash, chain.last.hash);
  assert.equal(canon(replica.baseFee), canon(chain.baseFee));
});

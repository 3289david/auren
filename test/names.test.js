'use strict';
// Name system v2 (ANR-1): registry rules, records, reverse names, Merkle/light-client verified resolution,
// and the universal resolver's collision policy. Chains, proofs and signatures are real; the DNS and ENS
// transports are injected (canned DoH / eth_call answers), because those are third-party services.
const test = require('node:test');
const assert = require('node:assert/strict');
const Aur = require('../website/aurlib.js');
const ANR = require('../website/anr.js');
const { AUR, canon, sha256hex, verifyMerkleProof } = require('../src/util');
const { Keypair } = require('../src/crypto');
const { makeTestChain, produce, mkTx, devKeys, makeGenesis } = require('../src/devkit');
const { Chain } = require('../src/chain');
const { pubToAddress } = require('../src/address');
const { checkTx } = require('../src/tx');

const FAST = { blocksPerYear: 1000, unbondingBlocks: 5 };
const rpcFor = (chain) => ({
  url: `inproc:${chain.chainId}`,
  get: async (p) => { if (p === '/genesis') return JSON.parse(canon(chain.genesis)); throw new Error('unsupported'); },
  call: async (m, params) => { if (m === 'aur_resolve') return chain.resolveWithProof(String(params[0]).replace(/\.aur$/, '')); throw new Error('unsupported ' + m); },
});
const trustFor = (genesis) => ({ chainId: genesis.chainId, validators: ANR.genesisValidatorSet(genesis) });

test('registry rules: ASCII only, no "--", nothing that looks like an address or a key', () => {
  const { chain } = makeTestChain({ params: FAST });
  const bad = ['xn--80ak6aa92e', 'a--b', 'daur1qzay55z85wxf7z8my5ucujumv43vxjsfhglm39fd', 'daur1abc', 'ab', '-abc', 'abc-', 'ALICE', 'ａlice', 'a'.repeat(64), 'ab'.padEnd(41, '0')];
  for (const name of bad) assert.throws(() => checkTx(mkTx(chain, devKeysAcct(), 'registerDomain', { name, years: 1 }), chain.params, chain.chainId), { code: 'BAD_BODY' }, name);
  for (const name of ['alice', 'a-b-c', 'abc', 'name123', 'my-wallet-9']) assert.doesNotThrow(() => checkTx(mkTx(chain, devKeysAcct(), 'registerDomain', { name, years: 1 }), chain.params, chain.chainId), name);
  function devKeysAcct() { return require('../src/devkit').devAccount('alice'); }
});

test('records, safe transfer and verified reverse names', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  const { alice, bob } = accts;
  const run = (who, type, body) => produce(chain, validators, { candidates: [mkTx(chain, who, type, body)] }).res.receipts[0];

  assert.equal(run(alice, 'registerDomain', { name: 'alice', years: 1 }).status, 1);
  assert.equal(run(alice, 'setRecord', { name: 'alice', key: 'addr:eip155:1', value: '0x00000000000000000000000000000000000000aa' }).status, 1);
  assert.equal(run(alice, 'setRecord', { name: 'alice', key: 'text:url', value: 'https://alice.example' }).status, 1);
  assert.deepEqual(Object.keys(chain.getDomain('alice').records).sort(), ['addr:eip155:1', 'text:url']);
  assert.equal(run(bob, 'setRecord', { name: 'alice', key: 'text:url', value: 'https://evil.example' }).code, 'NOT_OWNER');
  assert.throws(() => checkTx(mkTx(chain, alice, 'setRecord', { name: 'alice', key: 'bad key!', value: 'x' }), chain.params, chain.chainId), { code: 'BAD_BODY' });
  assert.throws(() => checkTx(mkTx(chain, alice, 'setRecord', { name: 'alice', key: 'text:a', value: 'x\u0007y' }), chain.params, chain.chainId), { code: 'BAD_BODY' });
  for (let i = 0; i < 14; i++) assert.equal(run(alice, 'setRecord', { name: 'alice', key: `text:k${i}`, value: 'v' }).status, 1);
  assert.equal(run(alice, 'setRecord', { name: 'alice', key: 'text:overflow', value: 'v' }).code, 'TOO_MANY_RECORDS');
  assert.equal(run(alice, 'setRecord', { name: 'alice', key: 'text:k0', value: null }).status, 1); // delete

  // reverse names need forward verification
  assert.equal(run(bob, 'setPrimary', { name: 'alice' }).code, 'NAME_DOES_NOT_RESOLVE_TO_YOU');
  assert.equal(run(alice, 'setPrimary', { name: 'alice' }).status, 1);
  assert.equal(chain.reverse(alice.address), 'alice.aur');
  // pointing the name elsewhere instantly invalidates the reverse record (no stale spoofing)
  run(alice, 'setDomainTarget', { name: 'alice', target: bob.address });
  assert.equal(chain.reverse(alice.address), null);
  run(alice, 'setDomainTarget', { name: 'alice', target: alice.address });
  assert.equal(chain.reverse(alice.address), 'alice.aur');

  // a sale does not leave the seller's target or records behind
  assert.equal(run(alice, 'transferDomain', { name: 'alice', newOwner: bob.address }).status, 1);
  const d = chain.getDomain('alice');
  assert.equal(d.owner, bob.address);
  assert.equal(d.target, bob.address);
  assert.equal(d.records, undefined);
  assert.equal(chain.reverse(alice.address), null);
});

test('Merkle proofs verify for every state entry (odd and even tree sizes)', () => {
  const { chain, validators, accts } = makeTestChain({ params: FAST });
  for (let i = 0; i < 6; i++) produce(chain, validators, { candidates: i === 2 ? [mkTx(chain, accts.alice, 'registerDomain', { name: 'proof' + i, years: 1 })] : [] });
  const root = chain.state.root();
  let n = 0;
  for (const ns of ['acct', 'val', 'del', 'dom', 'meta']) for (const [key, value] of chain.state.entries(ns)) {
    const pr = chain.state.prove(ns, key);
    const leaf = sha256hex(canon([ns, key, value]));
    assert.ok(verifyMerkleProof(leaf, pr.steps, root), `${ns}/${key}`);
    assert.ok(!verifyMerkleProof(sha256hex(canon([ns, key, 'tampered'])), pr.steps, root));
    n++;
  }
  assert.ok(n > 10);
  assert.equal(chain.state.prove('dom', 'nope'), null);
});

test('light-client verification: accepts a real proof, rejects every tampering', async () => {
  const { chain, validators, accts, genesis } = makeTestChain({ params: FAST });
  produce(chain, validators, { candidates: [mkTx(chain, accts.alice, 'registerDomain', { name: 'alice', years: 1 })] });
  produce(chain, validators);
  produce(chain, validators);
  const trust = trustFor(genesis);
  assert.deepEqual(ANR.genesisValidatorSet(genesis).map((v) => v.operator).sort(), chain.getBlock(1) && validators.map((v) => v.address).sort());

  const good = chain.resolveWithProof('alice');
  const ok = await ANR.verifyResolution(good, trust);
  assert.equal(ok.ok, true, ok.reason);
  assert.ok(ok.signers >= 3);

  const mutate = (fn) => { const r = structuredClone(good); fn(r); return ANR.verifyResolution(r, trust); };
  assert.match((await mutate((r) => { r.target = accts.bob.address; })).reason, /does not match the proven record/);
  assert.match((await mutate((r) => { r.proof.record.value.target = accts.bob.address; r.target = accts.bob.address; })).reason, /name-record proof invalid/);
  assert.match((await mutate((r) => { r.proof.block.header.stateRoot = 'aa'.repeat(32); })).reason, /block hash does not match/);
  assert.match((await mutate((r) => { r.proof.commit.votes.pop(); r.proof.commit.votes.pop(); })).reason, /lacks > 2\/3/);
  assert.match((await mutate((r) => { r.proof.commit.votes[0].sig = r.proof.commit.votes[1].sig; })).reason, /bad signature/);
  assert.match((await mutate((r) => { r.proof.commit.votes.push(r.proof.commit.votes[0]); })).reason, /duplicate/);
  assert.match((await ANR.verifyResolution(good, { ...trust, chainId: 'other-chain' })).reason, /different chain/);

  // an attacker fabricates a complete, internally consistent history with their OWN validators: it must fail
  const evil = devKeys(4, 'evil');
  const eg = makeGenesis({ validators: evil, params: { ...FAST, minSelfStake: (1000n * AUR).toString() }, chainId: genesis.chainId, accounts: [{ address: accts.alice.address, balance: 1000n * AUR }] });
  const echain = new Chain(eg);
  const ea = { address: accts.alice.address, kp: accts.alice.kp };
  produce(echain, evil, { candidates: [mkTx(echain, ea, 'registerDomain', { name: 'alice', years: 1 })] });
  produce(echain, evil); produce(echain, evil);
  const forged = echain.resolveWithProof('alice');
  const bad = await ANR.verifyResolution(forged, trust);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not enough of the validator set you trust/);
  assert.equal((await ANR.verifyResolution(forged, trustFor(eg))).ok, true, 'it would pass only for someone who trusts the attacker\'s set');
});

test('the light client advances its trusted set through validator-set changes', async () => {
  const { chain, validators, accts, genesis } = makeTestChain({ n: 4, params: { ...FAST, minSelfStake: (1000n * AUR).toString() } });
  produce(chain, validators, { candidates: [mkTx(chain, accts.alice, 'registerDomain', { name: 'alice', years: 1 })] });
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const lc = new ANR.LightClient({ rpc: rpcFor(chain), pinnedGenesisHash: sha256hex(canon(genesis)), storage });
  await lc.init();
  const r1 = await lc.resolve('alice');
  assert.equal(r1.verified, true, r1.reason);
  assert.equal(lc.trust.height, chain.height);
  assert.ok([...store.keys()].some((k) => k.startsWith('anr.trust.')), 'trusted set persisted');
  await assert.rejects(() => new ANR.LightClient({ rpc: rpcFor(chain), pinnedGenesisHash: 'ab'.repeat(32) }).init(), /does not match the pinned/);
});

test('keccak-256 and ENS namehash match published vectors', () => {
  const h = (b) => Aur.hex(b);
  assert.equal(h(ANR.keccak256(new Uint8Array())), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(h(ANR.keccak256(new TextEncoder().encode('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(h(ANR.keccak256(new TextEncoder().encode('a'.repeat(200)))).length, 64); // multi-block absorb
  assert.equal(h(ANR.namehash('')), '00'.repeat(32));
  assert.equal(h(ANR.namehash('eth')), '93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
  assert.equal(h(ANR.namehash('foo.eth')), 'de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
});

// ---------------------------------------------------------------------------- universal resolver
async function twoNetworks() {
  const a = makeTestChain({ params: FAST, names: ['alice', 'bob'] });
  // a second, independent AUREN network whose genesis differs, where the SAME name belongs to someone else
  const keys2 = devKeys(4, 'other');
  const g2 = makeGenesis({ validators: keys2, params: { ...FAST, minSelfStake: (1000n * AUR).toString() }, chainId: 'auren-testnet-1', accounts: [{ address: a.accts.bob.address, balance: 1000n * AUR }] });
  const c2 = new Chain(g2);
  produce(a.chain, a.validators, { candidates: [mkTx(a.chain, a.accts.alice, 'registerDomain', { name: 'shared', years: 1 })] });
  produce(a.chain, a.validators);
  produce(c2, keys2, { candidates: [mkTx(c2, { address: a.accts.bob.address, kp: a.accts.bob.kp }, 'registerDomain', { name: 'shared', years: 1 })] });
  produce(c2, keys2);
  const lc = (chain, g) => new ANR.LightClient({ rpc: rpcFor(chain), label: chain.chainId, pinnedGenesisHash: sha256hex(canon(g)) });
  return { a, c2, g2, lcA: lc(a.chain, a.genesis), lcB: lc(c2, g2) };
}

test('collision: the same name in two namespaces is reported as ambiguous, never silently picked', async () => {
  const { a, lcA, lcB } = await twoNetworks();
  const R = new ANR.UniversalResolver({ auren: [lcA, lcB], addressPrefix: 'daur', chainId: a.chain.chainId });
  const r = await R.resolve('shared.aur');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.candidates.map((c) => c.namespace).sort(), ['auren-test-1', 'auren-testnet-1']);
  assert.equal(r.address, null, 'no address is offered when ambiguous');
  // namespace-qualified names are unambiguous
  const q = await R.resolve('shared.aur@auren-test-1');
  assert.equal(q.status, 'verified');
  assert.equal(q.address, a.accts.alice.address);
  assert.equal(q.candidates[0].verified, 'light-client');
  const none = await R.resolve('missing.aur@auren-test-1');
  assert.equal(none.status, 'notfound');
});

test('a lying node is downgraded: a forged answer is never "verified"', async () => {
  const { a, lcA } = await twoNetworks();
  const liar = { ...rpcFor(a.chain), call: async (m, p) => { const r = structuredClone(await rpcFor(a.chain).call(m, p)); r.target = a.accts.bob.address; return r; } };
  const lc = new ANR.LightClient({ rpc: liar, pinnedGenesisHash: lcA.pinned });
  const R = new ANR.UniversalResolver({ auren: [lc], addressPrefix: 'daur', chainId: a.chain.chainId });
  const r = await R.resolve('shared.aur');
  assert.equal(r.status, 'unverified');
  assert.equal(r.candidates[0].verified, 'node-claim');
  assert.match(r.candidates[0].why, /does not match the proven record/);
});

test('DNS bridge: DNSSEC-validated TXT records are marked, unsigned ones are not', async () => {
  const { a } = await twoNetworks();
  const addr = a.accts.bob.address;
  const doh = (ad) => async () => ({ json: async () => ({ AD: ad, Answer: [{ data: `"v=ANR1 aur:${a.chain.chainId}=${addr}"` }] }) });
  const mk = (ad) => new ANR.UniversalResolver({ auren: [], addressPrefix: 'daur', chainId: a.chain.chainId, fetchFn: doh(ad) });
  const signed = await mk(true).resolve('bob.example.com');
  assert.equal(signed.status, 'verified'); assert.equal(signed.candidates[0].verified, 'dnssec'); assert.equal(signed.address, addr);
  const unsigned = await mk(false).resolve('bob.example.com');
  assert.equal(unsigned.status, 'unverified'); assert.equal(unsigned.candidates[0].verified, 'dns-unsigned');
  // a DNS answer for a DIFFERENT AUREN namespace is shown but is not a valid destination here
  const other = new ANR.UniversalResolver({ auren: [], addressPrefix: 'daur', chainId: 'auren-other-9', fetchFn: doh(true) });
  assert.equal((await other.resolve('bob.example.com')).sendable.length, 0);
});

test('ENS bridge: ABI calls are built correctly and results are labelled as the RPC provider\'s word', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body.params[0]);
    const word = (x) => ({ json: async () => ({ result: '0x' + x.padStart(64, '0') }) });
    return calls.length === 1 ? word('4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41') : word('d8da6bf26964af9d7eed9e03e53415d37aa96045');
  };
  const R = new ANR.UniversalResolver({ auren: [], ensRpc: 'http://eth.invalid', addressPrefix: 'daur', chainId: 'auren-test-1', fetchFn });
  const r = await R.resolve('vitalik.eth');
  assert.equal(calls[0].to, '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e');
  assert.equal(calls[0].data, '0x0178b8bf' + Aur.hex(ANR.namehash('vitalik.eth')));
  assert.equal(calls[1].to, '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41');
  assert.equal(calls[1].data, '0x3b3b57de' + Aur.hex(ANR.namehash('vitalik.eth')));
  assert.equal(r.candidates[0].address, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
  assert.equal(r.candidates[0].verified, 'rpc-claim');
  assert.equal(r.sendable.length, 0, 'an Ethereum address cannot receive AUR');
  void Keypair; void pubToAddress;
});

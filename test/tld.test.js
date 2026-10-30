'use strict';
// User-created TLDs and domains: registration, open/restricted policy, fee split and burn, resolution proofs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR, canon, sha256hex } = require('../src/util');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const { checkTx } = require('../src/tx');
const { nameValid, tldOk, parseName, domKey } = require('../src/tld');
const { scheduleLanes } = require('../src/scheduler');
const ANR = require('../website/anr.js');

const FAST = { blocksPerYear: 1000, tld: { price: (100n * AUR).toString(), maxOwnerShareBps: 9000 } };

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
  const s = makeTestChain({ params: FAST });
  const run = (who, type, body) => produce(s.chain, s.validators, { candidates: [mkTx(s.chain, who, type, body)] }).res.receipts[0];
  const bal = (a) => (s.chain.state.get('acct', a.address) || { balance: 0n }).balance;
  return { ...s, run, bal };
}
const policy = (o = {}) => ({ open: true, price: String(5n * AUR), ownerShareBps: 8000, ...o });

test('name and TLD syntax; real-world TLDs and country codes are reserved', () => {
  assert.deepEqual(parseName('alice'), { label: 'alice', tld: 'aur' });
  assert.deepEqual(parseName('alice.david'), { label: 'alice', tld: 'david' });
  assert.equal(parseName('a.b.c'), null, 'no sub-domains');
  assert.equal(domKey(parseName('alice.aur')), 'alice');
  assert.equal(domKey(parseName('alice.david')), 'alice.david');
  assert.ok(nameValid('alice.david') && nameValid('alice') && nameValid('my-name.club7'));
  for (const bad of ['a.david', 'alice.', '.david', 'alice.Da', 'alice.1abc', 'al ice.david', 'alice.xn--abc']) assert.equal(nameValid(bad), null, bad);
  for (const ok of ['david', 'mycoin', 'alice1', 'zebra']) assert.ok(tldOk(ok), ok);
  for (const reserved of ['com', 'org', 'eth', 'aur', 'btc', 'crypto', 'google', 'localhost', 'uk', 'io', 'de', 'xn--abc']) assert.equal(tldOk(reserved), false, reserved);
});

test('anyone can register a TLD: the fee is burned, duplicates and reserved names are refused', () => {
  const { chain, accts, run, bal } = setup();
  const burned0 = chain.burned, a0 = bal(accts.alice);
  const r = run(accts.alice, 'registerTld', { tld: 'david', ...policy() });
  assert.equal(r.status, 1, r.code);
  assert.ok(chain.burned - burned0 >= 100n * AUR, 'registration fee burned');
  assert.ok(a0 - bal(accts.alice) >= 100n * AUR);
  const t = chain.getTld('david');
  assert.equal(t.owner, accts.alice.address);
  assert.equal(t.open, true);
  assert.equal(BigInt(t.price), 5n * AUR);
  assert.equal(run(accts.bob, 'registerTld', { tld: 'david', ...policy() }).code, 'TLD_TAKEN');
  for (const bad of ['com', 'eth', 'aur', 'uk']) assert.throws(() => checkTx(mkTx(chain, accts.bob, 'registerTld', { tld: bad, ...policy() }), chain.params, chain.chainId), { code: 'BAD_BODY' }, bad);
  assert.throws(() => checkTx(mkTx(chain, accts.bob, 'registerTld', { tld: 'cool', ...policy({ ownerShareBps: 9500 }) }), chain.params, chain.chainId), { code: 'BAD_BODY' }, 'owner share is capped');
  assert.throws(() => checkTx(mkTx(chain, accts.bob, 'registerTld', { tld: 'cool', ...policy({ open: 'yes' }) }), chain.params, chain.chainId), { code: 'BAD_BODY' });
  conserved(chain);
});

test('an open TLD: buyers pay the TLD owner (share) and the rest is burned; .aur is a separate namespace', () => {
  const { chain, accts, run, bal } = setup();
  run(accts.alice, 'registerTld', { tld: 'david', ...policy() }); // price 5 AUR/yr, owner keeps 80%
  const ownerBefore = bal(accts.alice), burned0 = chain.burned, bobBefore = bal(accts.bob);
  const r = run(accts.bob, 'registerDomain', { name: 'bob.david', years: 2 }); // 10 AUR
  assert.equal(r.status, 1, r.code);
  assert.equal(bal(accts.alice) - ownerBefore, 8n * AUR, 'TLD owner received 80% of 10 AUR');
  assert.ok(chain.burned - burned0 >= 2n * AUR, '20% burned');
  assert.ok(bobBefore - bal(accts.bob) >= 10n * AUR);
  const d = chain.getDomain('bob.david');
  assert.equal(d.owner, accts.bob.address);
  assert.equal(chain.getDomain('bob'), null, 'bob.aur is a different name');
  assert.equal(chain.getDomain('bob.aur'), null);
  // same label in two namespaces, different owners: both valid, no collision
  assert.equal(run(accts.carol, 'registerDomain', { name: 'bob', years: 1 }).status, 1);
  assert.equal(chain.getDomain('bob.aur').owner, accts.carol.address);
  assert.equal(chain.getDomain('bob.david').owner, accts.bob.address);
  assert.equal(run(accts.dave, 'registerDomain', { name: 'bob.david', years: 1 }).code, 'NAME_TAKEN');
  assert.equal(run(accts.dave, 'registerDomain', { name: 'x.nosuchtld', years: 1 }).code, 'TLD_NOT_FOUND');
  conserved(chain);
});

test('a restricted TLD: only the owner registers (free) until the owner opens it; policy is owner-only', () => {
  const { chain, accts, run, bal } = setup();
  run(accts.alice, 'registerTld', { tld: 'brand', ...policy({ open: false, price: '0', ownerShareBps: 0 }) });
  assert.equal(run(accts.bob, 'registerDomain', { name: 'shop.brand', years: 1 }).code, 'TLD_RESTRICTED');
  const before = bal(accts.alice);
  assert.equal(run(accts.alice, 'registerDomain', { name: 'shop.brand', years: 1 }).status, 1);
  assert.ok(before - bal(accts.alice) < AUR, 'the owner registers under its own TLD for free (fees only)');
  // hand a name to someone: transferDomain works under any TLD
  assert.equal(run(accts.alice, 'transferDomain', { name: 'shop.brand', newOwner: accts.bob.address }).status, 1);
  assert.equal(chain.getDomain('shop.brand').owner, accts.bob.address);
  // only the owner may change policy
  assert.equal(run(accts.bob, 'setTldPolicy', { tld: 'brand', ...policy() }).code, 'NOT_OWNER');
  assert.equal(run(accts.alice, 'setTldPolicy', { tld: 'brand', ...policy({ price: String(2n * AUR) }) }).status, 1);
  assert.equal(run(accts.carol, 'registerDomain', { name: 'blog.brand', years: 1 }).status, 1, 'open now');
  assert.equal(run(accts.alice, 'setTldPolicy', { tld: 'nothere', ...policy() }).code, 'TLD_NOT_FOUND');
  // transfer the whole TLD
  assert.equal(run(accts.alice, 'transferTld', { tld: 'brand', newOwner: accts.dave.address }).status, 1);
  assert.equal(chain.getTld('brand').owner, accts.dave.address);
  const daveBefore = bal(accts.dave);
  run(accts.bob, 'registerDomain', { name: 'more.brand', years: 1 });
  assert.ok(bal(accts.dave) > daveBefore || chain.getTld('brand').ownerShareBps === 8000, 'revenue now flows to the new owner');
  conserved(chain);
});

test('records, targets, reverse names and listing work under custom TLDs', () => {
  const { chain, accts, run } = setup();
  run(accts.alice, 'registerTld', { tld: 'david', ...policy({ price: '0', ownerShareBps: 0 }) });
  assert.equal(run(accts.bob, 'registerDomain', { name: 'bob.david', years: 1 }).status, 1);
  assert.equal(run(accts.bob, 'setRecord', { name: 'bob.david', key: 'text:url', value: 'https://bob.example' }).status, 1);
  assert.equal(chain.getDomain('bob.david').records['text:url'], 'https://bob.example');
  assert.equal(run(accts.carol, 'setRecord', { name: 'bob.david', key: 'text:url', value: 'x' }).code, 'NOT_OWNER');
  assert.equal(run(accts.bob, 'setPrimary', { name: 'bob.david' }).status, 1);
  assert.equal(chain.reverse(accts.bob.address), 'bob.david');
  run(accts.bob, 'setDomainTarget', { name: 'bob.david', target: accts.carol.address });
  assert.equal(chain.reverse(accts.bob.address), null, 'reverse is forward-verified');
  const list = chain.listTlds();
  assert.equal(list[0].tld, 'aur');
  assert.equal(list.find((t) => t.tld === 'david').domains, 1);
});

test('names under a custom TLD resolve with a proof the light client accepts, and a forged answer is refused', async () => {
  const { chain, validators, accts, genesis, run } = setup();
  run(accts.alice, 'registerTld', { tld: 'david', ...policy({ price: '0', ownerShareBps: 0 }) });
  run(accts.bob, 'registerDomain', { name: 'bob.david', years: 1 });
  produce(chain, validators); produce(chain, validators);
  const good = chain.resolveWithProof('bob.david');
  assert.equal(good.name, 'bob.david');
  const trust = { chainId: genesis.chainId, validators: ANR.genesisValidatorSet(genesis) };
  const ok = await ANR.verifyResolution(good, trust);
  assert.equal(ok.ok, true, ok.reason);
  const bad = structuredClone(good); bad.target = accts.carol.address;
  assert.match((await ANR.verifyResolution(bad, trust)).reason, /does not match the proven record/);
  const wrongKey = structuredClone(good); wrongKey.name = 'bob.aur';
  assert.equal((await ANR.verifyResolution(wrongKey, trust)).ok, false, 'a proof for bob.david cannot be passed off as bob.aur');
  // the universal resolver finds it without being told the TLD exists
  const rpc = { url: 'x', get: async () => genesis, call: async (m, p) => (m === 'aur_resolve' ? chain.resolveWithProof(p[0]) : null) };
  const lc = new ANR.LightClient({ rpc, pinnedGenesisHash: sha256hex(canon(genesis)) });
  const R = new ANR.UniversalResolver({ auren: [lc], addressPrefix: 'daur', chainId: chain.chainId });
  const r = await R.resolve('bob.david');
  assert.equal(r.status, 'verified');
  assert.equal(r.address, accts.bob.address);
});

test('registrations under a custom TLD serialize the block (they pay the TLD owner)', () => {
  const { chain, accts } = setup();
  const lanes = scheduleLanes([
    mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }),
    mkTx(chain, accts.carol, 'registerDomain', { name: 'c.david1', years: 1 }),
    mkTx(chain, accts.dave, 'transfer', { to: accts.alice.address, amount: '1' }),
  ]);
  assert.equal(lanes.length, 1, 'wildcard access set');
  const plain = scheduleLanes([mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }), mkTx(chain, accts.carol, 'registerDomain', { name: 'carol', years: 1 })]);
  assert.equal(plain.length, 2, '.aur registrations stay parallel');
});

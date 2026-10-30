'use strict';
// The browser wallet library must produce transactions the real chain accepts.
const test = require('node:test');
const assert = require('node:assert/strict');
const Aur = require('../website/aurlib.js');
const { canon, AUR } = require('../src/util');
const { pubToAddress } = require('../src/address');
const { Keypair } = require('../src/crypto');
const { checkTx, txHash } = require('../src/tx');
const { makeTestChain, produce, devAccount } = require('../src/devkit');

test('canonical JSON, amounts and addresses match the node implementation', async () => {
  const sample = { b: [3, { z: 1n, a: 'x' }], a: null, c: { y: 'é', x: [] }, u: undefined, 10: 'ten', 2: 'two' };
  assert.equal(Aur.canon(sample), canon(sample));
  assert.equal(Aur.formatAur(Aur.parseAur('1234567.000000001')), '1,234,567.000000001');
  assert.equal(Aur.parseAur('1.5'), 1500000000n);
  assert.throws(() => Aur.parseAur('1.0000000001'));
  for (let i = 0; i < 20; i++) {
    const kp = Keypair.generate();
    for (const hrp of ['aur', 'taur', 'daur']) {
      const a = await Aur.pubToAddress(kp.pub, hrp);
      assert.equal(a, pubToAddress(kp.pub, hrp));
      assert.ok(Aur.isValidAddress(a, hrp));
      assert.ok(!Aur.isValidAddress(a, 'xaur'));
    }
  }
  assert.ok(!Aur.isValidAddress('daur1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'daur'));
});

test('keys derived from a seed match the node, and signatures verify both ways', async () => {
  const seed = Aur.randomSeedHex();
  const web = await Aur.keyFromSeed(seed);
  assert.equal(web.pub, Keypair.fromSeedHex(seed).pub);
  const msg = new TextEncoder().encode('hello');
  const sig = await Aur.sign(web, msg);
  assert.ok(await Aur.verify(web.pub, msg, sig));
  assert.ok(!(await Aur.verify(web.pub, new TextEncoder().encode('hellp'), sig)));
  assert.equal(sig, Keypair.fromSeedHex(seed).sign(Buffer.from('hello'))); // Ed25519 is deterministic
});

test('encrypted keystore round trip', async () => {
  const seed = Aur.randomSeedHex();
  const ks = await Aur.encryptSeed(seed, 'correct horse battery', 1000);
  assert.equal(await Aur.decryptSeed(ks, 'correct horse battery'), seed);
  await assert.rejects(() => Aur.decryptSeed(ks, 'nope'), /Wrong password/);
});

test('a transaction signed in the browser library is accepted and executed by the chain', async () => {
  const { chain, validators, accts } = makeTestChain({ params: { blocksPerYear: 1000 } });
  const alice = await Aur.keyFromSeed(accts.alice.kp.seedHex);
  const from = await Aur.pubToAddress(alice.pub, 'daur');
  assert.equal(from, accts.alice.address);

  const mk = async (type, body, nonce) => Aur.signTx(alice, { chainId: chain.chainId, type, from, nonce, maxFee: '100000000', tip: '1000', body });
  const t1 = await mk('transfer', { to: accts.bob.address, amount: (7n * AUR).toString() }, 0);
  const t2 = await mk('registerDomain', { name: 'webwallet', years: 1 }, 1);
  const t3 = await mk('setSecurity', { guardians: [accts.bob.address], threshold: 1, delayBlocks: 50000, dailyLimit: (500n * AUR).toString() }, 2);
  for (const t of [t1, t2, t3]) {
    assert.doesNotThrow(() => checkTx(t, chain.params, chain.chainId));
    assert.equal(await Aur.txHash(t), txHash(t));
  }
  const { res } = produce(chain, validators, { candidates: [t1, t2, t3] });
  assert.deepEqual(res.receipts.map((r) => r.status), [1, 1, 1]);
  assert.equal(chain.getDomain('webwallet').owner, from);
  assert.equal(chain.state.get('acct', accts.bob.address).balance, 1000000n * AUR + 7n * AUR);
  void devAccount;
});

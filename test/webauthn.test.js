'use strict';
// Hardware-key (WebAuthn / passkey) signature scheme. The authenticator is emulated with real P-256
// cryptography and the exact byte formats a browser returns, so the chain-side verification and the
// browser library's challenge/serialization code are genuinely exercised. A physical YubiKey or Touch ID
// cannot be driven from a test runner; see docs/hardware-wallets.md for the manual device checklist.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Aur = require('../website/aurlib.js');
const { AUR } = require('../src/util');
const { pubToAddress } = require('../src/address');
const { checkTx, signTx } = require('../src/tx');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const { Keypair } = require('../src/crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest();

/** A software authenticator that behaves like navigator.credentials.get() for one P-256 credential. */
function makeAuthenticator(rpId = 'localhost', { flags = 0x05 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
  let counter = 0;
  const get = async ({ publicKey: o }) => {
    const authData = Buffer.concat([sha(rpId), Buffer.from([flags]), Buffer.alloc(4, ++counter)]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(o.challenge).toString('base64url'), origin: `http://${rpId}` }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), { key: privateKey, dsaEncoding: 'der' });
    const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    return { response: { authenticatorData: ab(authData), clientDataJSON: ab(clientData), signature: ab(signature) } };
  };
  return { pub, get, key: { kind: 'webauthn', scheme: 2, credId: 'AAAA', rpId, pub } };
}

test.beforeEach(() => { globalThis.__nav = globalThis.navigator; });

function withAuthenticator(auth, fn) {
  Object.defineProperty(globalThis, 'navigator', { value: { credentials: { get: auth.get } }, configurable: true });
  return fn().finally(() => { Object.defineProperty(globalThis, 'navigator', { value: globalThis.__nav, configurable: true }); });
}

test('address derivation for scheme 2 matches between browser library and node', async () => {
  const a = makeAuthenticator();
  assert.equal(await Aur.pubToAddress(a.pub, 'daur', 2), pubToAddress(a.pub, 'daur', 2));
  assert.notEqual(pubToAddress(a.pub, 'daur', 2), pubToAddress(Keypair.generate().pub, 'daur', 0));
});

test('a passkey-signed transaction is accepted, executed, and bound to its exact contents', async () => {
  const { chain, validators, accts } = makeTestChain({ params: { blocksPerYear: 1000 } });
  const auth = makeAuthenticator();
  const from = pubToAddress(auth.pub, 'daur', 2);
  chain.state.set('acct', from, { balance: 500n * AUR, nonce: 0 });

  const unsigned = { chainId: chain.chainId, type: 'transfer', from, nonce: 0, maxFee: '100000000', tip: '1000', body: { to: accts.bob.address, amount: (5n * AUR).toString() } };
  const tx = await withAuthenticator(auth, () => Aur.signTx(auth.key, unsigned));
  assert.equal(tx.scheme, 2);
  assert.doesNotThrow(() => checkTx(tx, chain.params, chain.chainId));

  // any change to the signed contents invalidates the assertion
  assert.throws(() => checkTx({ ...tx, body: { ...tx.body, amount: (6n * AUR).toString() } }, chain.params, chain.chainId), { code: 'BAD_SIGNATURE' });
  assert.throws(() => checkTx({ ...tx, nonce: 1 }, chain.params, chain.chainId), { code: 'BAD_SIGNATURE' });
  assert.throws(() => checkTx({ ...tx, chainId: 'elsewhere' }, { ...chain.params }, 'elsewhere'), { code: 'BAD_SIGNATURE' });
  // a valid assertion for a different transaction cannot be transplanted
  const other = await withAuthenticator(auth, () => Aur.signTx(auth.key, { ...unsigned, nonce: 5 }));
  assert.throws(() => checkTx({ ...tx, sig: other.sig }, chain.params, chain.chainId), { code: 'BAD_SIGNATURE' });
  // the signature is not accepted under the Ed25519 scheme or with a key of the wrong shape
  assert.throws(() => checkTx({ ...tx, scheme: undefined }, chain.params, chain.chainId));
  assert.throws(() => checkTx({ ...tx, scheme: 7 }, chain.params, chain.chainId), { code: 'BAD_SCHEME' });

  const { res } = produce(chain, validators, { candidates: [tx] });
  assert.equal(res.receipts[0].status, 1);
  assert.equal(chain.state.get('acct', accts.bob.address).balance, 1000000n * AUR + 5n * AUR);
  assert.equal(chain.state.get('acct', from).nonce, 1);
});

test('the user-present flag is mandatory', async () => {
  const { chain } = makeTestChain();
  const auth = makeAuthenticator('localhost', { flags: 0x00 }); // no user presence
  const from = pubToAddress(auth.pub, 'daur', 2);
  const tx = await withAuthenticator(auth, () => Aur.signTx(auth.key, { chainId: chain.chainId, type: 'claim', from, nonce: 0, maxFee: '1', tip: '0', body: { validator: from } }));
  assert.throws(() => checkTx(tx, chain.params, chain.chainId), { code: 'BAD_SIGNATURE' });
});

test('guardian recovery can move an account onto a hardware key (and the old key stops working)', async () => {
  const { chain, validators, accts } = makeTestChain({ params: { blocksPerYear: 1000, security: { minDelayBlocks: 5, limitWindowBlocks: 10, maxGuardians: 9 } } });
  const { alice, bob, carol } = accts;
  produce(chain, validators, { candidates: [mkTx(chain, alice, 'setSecurity', { guardians: [bob.address, carol.address], threshold: 2, delayBlocks: 5, dailyLimit: null })] });
  const auth = makeAuthenticator();
  const approve = (g) => mkTx(chain, g, 'recoveryApprove', { account: alice.address, newPub: auth.pub, newScheme: 2 });
  produce(chain, validators, { candidates: [approve(bob)] });
  produce(chain, validators, { candidates: [approve(carol)] });
  for (let i = 0; i < 6; i++) produce(chain, validators);
  const acct = chain.state.get('acct', alice.address);
  assert.equal(acct.authPub, auth.pub);
  assert.equal(acct.authScheme, 2);

  const nonce = acct.nonce;
  const body = { to: bob.address, amount: '1' };
  const unsigned = { chainId: chain.chainId, type: 'transfer', from: alice.address, nonce, maxFee: '100000000', tip: '1000', body };
  const viaKey = await withAuthenticator(auth, () => Aur.signTx(auth.key, unsigned));
  const viaOld = signTx(alice.kp, unsigned);
  const { block } = produce(chain, validators, { candidates: [viaOld, viaKey] });
  assert.equal(block.txs.length, 1, 'only the hardware-key transaction is included');
  assert.equal(block.txs[0].scheme, 2);
});

'use strict';
// EVM on the chain: native-signed and Ethereum-signed (secp256k1) transactions, contract deployment and calls,
// gas refunds, reverts, daily limits, replay. The raw Ethereum transactions in the fixture were signed by ethers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { AUR } = require('../src/util');
const { Chain } = require('../src/chain');
const { makeTestChain, produce, mkTx } = require('../src/devkit');
const { checkTx } = require('../src/tx');
const { envelopeFromRaw, parseRaw } = require('../src/evm/ethtx');
const { keyFromHex, hexOf, WEI } = require('../src/evm/host');
const { createAddress } = require('../src/evm/vm');
const fx = require('./fixtures/eth-raw.json');

const P = { blocksPerYear: 1000, unbondingBlocks: 5, security: { minDelayBlocks: 5, limitWindowBlocks: 100, maxGuardians: 9 } };
const sender = fx.sender.replace(/^0x/, '');
const contract = fx.contract.replace(/^0x/, '');

function conserved(chain) {
  let sum = 0n;
  for (const [, a] of chain.state.entries('acct')) sum += a.balance;
  for (const [, v] of chain.state.entries('val')) sum += v.tokens + v.pendingTotal;
  for (const [, u] of chain.state.entries('unb')) sum += u.amount;
  for (const [, p] of chain.state.entries('prop')) sum += p.deposit;
  for (const [, n] of chain.state.entries('node')) sum += n.bond;
  sum += chain.state.get('meta', 'nodePool') || 0n;
  sum += chain.state.get('meta', 'rpcPool') || 0n;
  assert.equal(sum, chain.supply, 'token conservation violated');
}

function setup() {
  const s = makeTestChain({ params: P });
  const key = keyFromHex(sender, 4, 'daur');
  s.chain.state.set('acct', key, { balance: 1000n * AUR, nonce: 0 });
  s.chain.state.set('meta', 'supply', s.chain.supply + 1000n * AUR);
  const bal = (hex, scheme = 0) => (s.chain.state.get('acct', keyFromHex(hex, scheme, 'daur')) || { balance: 0n }).balance;
  const env = (name) => envelopeFromRaw(fx.raw[name], s.chain.params, s.chain.chainId);
  const send = (...txs) => produce(s.chain, s.validators, { candidates: txs }).res.receipts;
  return { ...s, key, bal, env, send };
}

test('parseRaw recovers the signer of ethers-signed transactions (legacy and EIP-1559)', () => {
  for (const name of ['create', 'call', 'send', 'legacy']) {
    const p = parseRaw(fx.raw[name]);
    assert.equal(require('../src/evm/keccak').keccak256(Buffer.from(p.pub, 'hex')).subarray(12).toString('hex'), sender, name);
    assert.equal(p.chainId, 77000n);
  }
  assert.equal(parseRaw(fx.raw.create).hash, fx.hash.create);
  assert.equal(parseRaw(fx.raw.legacy).hash, fx.hash.legacy);
  assert.equal(parseRaw(fx.raw.legacy).type, 0);
  assert.equal(parseRaw(fx.raw.create).type, 2);
});

test('envelope: wrong EVM chain id and sub-spark values are rejected', () => {
  const { chain } = setup();
  assert.throws(() => envelopeFromRaw(fx.raw.badChain, chain.params, chain.chainId), { code: 'WRONG_CHAIN' });
  assert.throws(() => envelopeFromRaw(fx.raw.fractional, chain.params, chain.chainId), { code: 'BAD_BODY' });
  assert.throws(() => envelopeFromRaw('0x1234', chain.params, chain.chainId), { code: 'BAD_RAW' });
});

test('an Ethereum-signed transaction cannot be altered: every envelope field is bound to the raw bytes', () => {
  const { chain, env } = setup();
  const good = env('create');
  assert.doesNotThrow(() => checkTx(good, chain.params, chain.chainId));
  for (const mutate of [(t) => { t.nonce = 9; }, (t) => { t.body.gasLimit = 150000; }, (t) => { t.body.value = '1000000000'; }, (t) => { t.maxFee = '1'; }, (t) => { t.body.data = '00'; }, (t) => { t.from = chain.activeSet[0].operator; }]) {
    const t = structuredClone(good); mutate(t);
    assert.throws(() => checkTx(t, chain.params, chain.chainId), (e) => ['BAD_SIGNATURE', 'NOT_AUTHORIZED', 'BAD_FEE'].includes(e.code), JSON.stringify(t).slice(0, 80));
  }
  const nonEvm = structuredClone(good); nonEvm.type = 'transfer'; nonEvm.body = { to: chain.activeSet[0].operator, amount: '1' };
  assert.throws(() => checkTx(nonEvm, chain.params, chain.chainId), { code: 'BAD_SCHEME' });
});

test('deploy, call, send and legacy transactions signed by an Ethereum wallet execute on chain', () => {
  const { chain, key, bal, env, send } = setup();
  const start = bal(sender, 4);
  assert.equal(env('create').from, key);

  const [create] = send(env('create'));
  assert.equal(create.status, 1, create.code);
  assert.equal(create.evm.contractAddress, contract);
  assert.equal(create.evm.success, true);
  assert.equal(chain.state.get('ecode', contract), '600054600052602060' + '00f3');
  assert.equal(chain.state.get('estor', `${contract}:${'0'.repeat(64)}`), '2a');
  assert.ok(chain.state.get('acct', keyFromHex(contract, 3, 'daur')), 'contract account exists');

  const [call] = send(env('call'));
  assert.equal(call.status, 1);
  assert.equal(call.evm.output, '2a'.padStart(64, '0'));
  assert.ok(call.evm.gasUsed > 21000 && call.evm.gasUsed < 30000, `gas used ${call.evm.gasUsed}`);
  // unused gas is refunded: the fee is far below the 60,000-gas reservation
  const reserved = 60000n * chain.baseFee.compute + 60n * chain.baseFee.state;
  assert.ok(BigInt(call.fee) < reserved * 3n / 4n, `fee ${call.fee} vs reserved ${reserved}`);

  const [sendR] = send(env('send'));
  assert.equal(sendR.status, 1);
  assert.equal(bal(fx.recipient), 1n * AUR, '1 AUR = 1e18 wei arrived');
  const [leg] = send(env('legacy'));
  assert.equal(leg.status, 1);
  assert.equal(bal(fx.recipient), 1n * AUR + AUR / 2n);

  assert.equal(chain.state.get('acct', key).nonce, 4);
  assert.ok(start - bal(sender, 4) > AUR + AUR / 2n, 'sender paid value plus fees');
  conserved(chain);
});

test('a replayed Ethereum transaction is rejected (nonce)', () => {
  const { chain, validators, env, send } = setup();
  send(env('create'));
  const { block } = produce(chain, validators, { candidates: [env('create')] });
  assert.equal(block.txs.length, 0, 'the same nonce cannot be used twice');
});

test('native-signed EVM transactions: deploy, call, revert keeps the fee but not the state', () => {
  const { chain, validators, accts, send } = setup();
  const alice = accts.alice;
  const aliceHex = hexOf(alice.address, 'daur');
  const [dep] = send(mkTx(chain, alice, 'evm', { to: null, value: '0', data: fx.init, gasLimit: 200000 }));
  assert.equal(dep.status, 1, dep.code);
  const addr = createAddress(aliceHex, 0);
  assert.equal(dep.evm.contractAddress, addr);
  const [call] = send(mkTx(chain, alice, 'evm', { to: addr, value: '0', data: '', gasLimit: 60000 }));
  assert.equal(call.evm.output, '2a'.padStart(64, '0'));

  // contract whose runtime always reverts: 60006000fd; initcode copies it
  const rt = '60006000fd';
  const initRevert = '600560' + '0c' + '6000' + '39' + '6005' + '6000' + 'f3' + rt; // CODECOPY(0, 12, 5); RETURN(0, 5)
  const [dep2] = send(mkTx(chain, alice, 'evm', { to: null, value: '0', data: initRevert, gasLimit: 100000 }));
  assert.equal(dep2.status, 1, dep2.code);
  const reverter = dep2.evm.contractAddress;
  const aBefore = chain.state.get('acct', alice.address).balance;
  const rootBefore = chain.state.entries('estor').length;
  const [bad] = send(mkTx(chain, alice, 'evm', { to: reverter, value: String(WEI * 5n), data: '', gasLimit: 80000 }));
  assert.equal(bad.status, 0);
  assert.equal(bad.code, 'EVM_REVERT');
  assert.ok(BigInt(bad.fee) > 0n, 'a reverted call still pays for the gas it burned');
  assert.equal(chain.state.get('acct', alice.address).balance, aBefore - BigInt(bad.fee), 'value was not transferred');
  assert.equal(chain.state.entries('estor').length, rootBefore);
  assert.equal((chain.state.get('acct', keyFromHex(reverter, 3, 'daur')) || { balance: 0n }).balance, 0n);
  void validators;
  conserved(chain);
});

test('the daily limit also caps value sent by EVM transactions', () => {
  const { chain, accts, send } = setup();
  const alice = accts.alice;
  send(mkTx(chain, alice, 'setSecurity', { guardians: [accts.bob.address], threshold: 1, delayBlocks: 5, dailyLimit: String(1n * AUR) }));
  const to = fx.recipient;
  const [over] = send(mkTx(chain, alice, 'evm', { to, value: String(5n * AUR * WEI), data: '', gasLimit: 21000 }));
  assert.equal(over.code, 'DAILY_LIMIT_EXCEEDED');
  const [ok] = send(mkTx(chain, alice, 'evm', { to, value: String(AUR * WEI / 2n), data: '', gasLimit: 21000 }));
  assert.equal(ok.status, 1);
});

test('EVM blocks replay deterministically on a second node', () => {
  const { chain, genesis, env, send, accts } = setup();
  send(env('create'));
  send(env('call'));
  send(mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '5' }), env('send'));
  const replica = new Chain(genesis);
  replica.state.set('acct', keyFromHex(sender, 4, 'daur'), { balance: 1000n * AUR, nonce: 0 });
  replica.state.set('meta', 'supply', replica.supply + 1000n * AUR);
  for (let h = 1; h <= chain.height; h++) replica.applyBlock(chain.getBlock(h), chain.commits.get(h));
  assert.equal(replica.state.root(), chain.state.root());
});

test('SDK sizes the max fee from the gas limit, so a 200k-gas deployment built by Wallet.build is accepted', async () => {
  const { Wallet } = require('../src/client');
  const { quote } = require('../src/fees');
  const { chain, validators, accts } = setup();
  const rpc = {
    status: async () => ({ chainId: chain.chainId, addressPrefix: 'daur' }),
    account: async (a) => ({ pendingNonce: (chain.state.get('acct', a) || { nonce: 0 }).nonce }),
    feeQuote: async () => ({ baseFee: { compute: chain.baseFee.compute.toString(), state: chain.baseFee.state.toString() }, quote: quote(chain.baseFee) }),
  };
  const w = new Wallet(accts.alice.kp, 'daur');
  const tx = await w.build(rpc, 'evm', { to: null, value: '0', data: fx.init, gasLimit: 200000 });
  const { res } = produce(chain, validators, { candidates: [tx] });
  assert.equal(res.receipts.length, 1, 'transaction was included');
  assert.equal(res.receipts[0].status, 1);
});

test('EVM transactions run strictly in block order (wildcard access set)', () => {
  const { chain, env, accts } = setup();
  const { scheduleLanes } = require('../src/scheduler');
  const lanes = scheduleLanes([mkTx(chain, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }), env('create'), mkTx(chain, accts.carol, 'transfer', { to: accts.dave.address, amount: '1' })]);
  assert.deepEqual(lanes, [[0, 1, 2]]);
});

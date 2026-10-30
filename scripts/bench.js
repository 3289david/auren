#!/usr/bin/env node
'use strict';
// Measures REAL single-thread throughput of this reference implementation's execution engine
// (validation + execution + state root), excluding networking. Numbers depend on your CPU.
//   node scripts/bench.js [senders=2000] [blocks=4]
const { devKeys, makeGenesis, produce } = require('../src/devkit');
const { AUR } = require('../src/util');
const { Keypair } = require('../src/crypto');
const { signTx, clearSigCache } = require('../src/tx');
const { pubToAddress } = require('../src/address');
const { Chain } = require('../src/chain');

const SENDERS = Number(process.argv[2] || 2000);
const BLOCKS = Number(process.argv[3] || 4);

const validators = devKeys(4);
const kps = Array.from({ length: SENDERS }, (_, i) => Keypair.fromPassphrase(`bench/${i}`));
const addr = (kp) => pubToAddress(kp.pub, 'daur');
const genesis = makeGenesis({
  validators,
  params: { minSelfStake: (1000n * AUR).toString(), limits: { compute: 21000 * SENDERS * 2, state: 100 * SENDERS * 2 } },
  accounts: [...kps.map((k) => ({ address: addr(k), balance: 1000n * AUR })), ...validators.map((v) => ({ address: v.address, balance: 10000n * AUR }))],
});
const producer = new Chain(genesis);
const replica = new Chain(genesis);

// Disjoint sender pairs (0<->1, 2<->3, ...) so independent transfers can run in parallel lanes.
const mk = (nonce) => kps.map((kp, i) => signTx(kp, {
  chainId: producer.chainId, type: 'transfer', from: addr(kp), nonce, maxFee: (10n ** 12n).toString(), tip: '1000',
  body: { to: addr(kps[i ^ 1] || kps[0]), amount: '1' },
}));

let n = 0, tProduce = 0, tValidate = 0;
for (let b = 0; b < BLOCKS; b++) {
  const txs = mk(b);
  let t0 = process.hrtime.bigint();
  const { block, commit, res } = produce(producer, validators, { candidates: txs });
  const dp = Number(process.hrtime.bigint() - t0) / 1e6;

  clearSigCache(); // a real validator has not seen these signatures before
  t0 = process.hrtime.bigint();
  replica.applyBlock(block, commit);
  const dv = Number(process.hrtime.bigint() - t0) / 1e6;

  if (replica.state.root() !== producer.state.root()) throw new Error('replica diverged');
  n += block.txs.length; tProduce += dp; tValidate += dv;
  console.log(`block ${block.header.height}: ${block.txs.length} txs in ${res.lanes} independent lanes | produce ${dp.toFixed(0)} ms | validate (cold signatures) ${dv.toFixed(0)} ms`);
}
console.log(`\nproducer path : ${Math.round(n / (tProduce / 1000))} tx/s`);
console.log(`validator path: ${Math.round(n / (tValidate / 1000))} tx/s  <- the number that bounds a network of replicas`);
console.log('Single thread, in-memory, no networking or disk. Transfers only; other tx types cost more. Treat as a reference-implementation figure, not a network TPS.');

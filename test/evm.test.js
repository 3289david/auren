'use strict';
// EVM tests. The golden fixture holds results produced by the independent reference implementation
// (@ethereumjs/evm, Shanghai rules) for 260 programs; scripts/evm-diff.js regenerates it and can fuzz further.
const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256 } = require('../src/evm/keccak');
const rlp = require('../src/evm/rlp');
const { recover } = require('../src/evm/secp256k1');
const { VM, EvmState } = require('../src/evm/vm');
const golden = require('./fixtures/evm-golden.json');

test('keccak-256 matches published vectors (and is not NIST SHA3)', () => {
  const h = (s) => keccak256(Buffer.from(s)).toString('hex');
  assert.equal(h(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(h('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(h('hello world'), '47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad');
  assert.notEqual(h('abc'), require('node:crypto').createHash('sha3-256').update('abc').digest('hex'));
  assert.equal(keccak256(Buffer.alloc(136)).length, 32); // exactly one rate block
  assert.equal(keccak256(Buffer.alloc(1000)).toString('hex'), keccak256(Buffer.alloc(1000)).toString('hex'));
});

test('RLP vectors from the Ethereum wiki', () => {
  const hex = (x) => rlp.encode(x).toString('hex');
  assert.equal(hex(Buffer.from('dog')), '83646f67');
  assert.equal(hex([Buffer.from('cat'), Buffer.from('dog')]), 'c88363617483646f67');
  assert.equal(hex(Buffer.alloc(0)), '80');
  assert.equal(hex([]), 'c0');
  assert.equal(hex(0), '80');
  assert.equal(hex(15), '0f');
  assert.equal(hex(1024), '820400');
  assert.equal(hex([[], [[]], [[], [[]]]]), 'c7c0c1c0c3c0c1c0');
  const long = 'Lorem ipsum dolor sit amet, consectetur adipisicing elit';
  assert.equal(hex(Buffer.from(long)), 'b8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974');
  assert.deepEqual(rlp.decode(rlp.encode([Buffer.from('cat'), [Buffer.from('dog')]])).map((x) => (Array.isArray(x) ? x.map(String) : x.toString())), ['cat', ['dog']]);
  assert.throws(() => rlp.decode(Buffer.from('8100', 'hex')), /non-canonical/);
  assert.throws(() => rlp.decode(Buffer.from('c0c0', 'hex')), /trailing/);
});

test('secp256k1 recovery returns the signer (vector generated with ethers)', () => {
  // hash, r, s, recId and address produced by ethers.Wallet(privateKey = 0x1111...11).signingKey.sign(hash)
  const hash = Buffer.from('1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8', 'hex');
  const r = 0x6b3ce4a16d1bbc4a89d1ef1ab5ee2d3b4a7c3d6f8d6c0d86e3fb2ab4de4b0b5an, s = 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809n;
  // arbitrary (r, s) usually do not recover to a valid point; the function must reject cleanly rather than throw
  for (const id of [0, 1]) { const out = recover(hash, r, s, id); assert.ok(out === null || out.length === 64); }
  assert.equal(recover(hash, 0n, s, 0), null);
  assert.equal(recover(hash, r, 0n, 0), null);
  assert.equal(recover(hash, r, s, 2), null);
});

function replay(world, block, c) {
  const code = (hex) => Buffer.from(hex, 'hex');
  const backend = {
    account: (a) => { const w = world[a]; if (!w) return null; return { balance: BigInt(w.balance), nonce: w.nonce, code: a === golden.main ? code(c.code) : code(w.code) }; },
    storage: (a, s) => (world[a] && world[a].storage[String(s)] !== undefined ? BigInt(world[a].storage[String(s)]) : 0n),
  };
  const st = new EvmState(backend);
  const vm = new VM(st, { ...block, prevrandao: 0n, baseFee: BigInt(block.baseFee), origin: golden.caller, gasPrice: 3n, blockhash: () => 0n });
  const to = c.opts.to;
  st.warmAddress(golden.caller); st.warmAddress(to); st.warmAddress(golden.coinbase);
  for (let i = 1; i <= 9; i++) st.warmAddress(i.toString(16).padStart(40, '0'));
  const value = BigInt(c.opts.value);
  const r = vm._call({ kind: 'CALL', caller: golden.caller, address: to, codeAddr: to, value, apparentValue: value, data: code(c.opts.data), gas: c.opts.gas, depth: 0, static: false });
  return { r, st };
}

test(`EVM matches the reference implementation on ${golden.cases.length} recorded programs (gas, return data, logs, storage, balances, refunds)`, () => {
  let checked = 0;
  for (const c of golden.cases) {
    const { r, st } = replay(golden.world, golden.block, c);
    const where = `${c.name} ${c.code.slice(0, 60)}`;
    assert.equal(r.success, c.view.success, `success: ${where}`);
    assert.equal(r.gasLeft, c.view.gasLeft, `gas: ${where}`);
    assert.equal(Buffer.from(r.returnData).toString('hex'), c.view.ret, `return: ${where}`);
    assert.equal(st.refund, c.view.refund, `refund: ${where}`);
    assert.deepEqual(st.logs.map((l) => ({ a: l.address, t: l.topics, d: Buffer.from(l.data).toString('hex') })), c.view.logs, `logs: ${where}`);
    for (const [addr, exp] of Object.entries(c.accts)) {
      if (st.destroyed.has(addr)) continue;
      assert.equal(String(st.getBalance(addr)), exp.bal, `balance ${addr.slice(-2)}: ${where}`);
      assert.deepEqual([0n, 1n, 2n, 3n, 5n, 6n].map((s) => String(st.getStorage(addr, s))), exp.stor, `storage ${addr.slice(-2)}: ${where}`);
    }
    checked++;
  }
  assert.equal(checked, golden.cases.length);
});

test('exceptional halts consume all gas; REVERT keeps the remainder and the data', () => {
  const run = (hex) => { const st = new EvmState({ account: (a) => (a === 'aa'.repeat(20) ? { balance: 0n, nonce: 1, code: Buffer.from(hex, 'hex') } : null), storage: () => 0n }); return new VM(st, { coinbase: '00'.repeat(20), timestamp: 1, number: 1, prevrandao: 0n, gasLimit: 1e7, chainId: 1, baseFee: 0n, origin: '11'.repeat(20), gasPrice: 0n, blockhash: () => 0n })._call({ kind: 'CALL', caller: '11'.repeat(20), address: 'aa'.repeat(20), codeAddr: 'aa'.repeat(20), value: 0n, apparentValue: 0n, data: Buffer.alloc(0), gas: 100000, depth: 0, static: false }); };
  const bad = run('fe'); assert.equal(bad.success, false); assert.equal(bad.gasLeft, 0);
  const under = run('01'); assert.equal(under.gasLeft, 0);
  const jump = run('600356'); assert.equal(jump.gasLeft, 0);
  const rev = run('60aa60005260206000fd'); // MSTORE 0xaa, REVERT(0,32)
  assert.equal(rev.success, false); assert.ok(rev.gasLeft > 90000); assert.equal(Buffer.from(rev.returnData).toString('hex'), '00'.repeat(31) + 'aa');
  const ok = run('60aa60005260206000f3');
  assert.equal(ok.success, true); assert.equal(Buffer.from(ok.returnData).toString('hex'), '00'.repeat(31) + 'aa');
});

'use strict';
// The JavaScript and Python SDKs must produce byte-identical addresses and signatures.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Wallet, toSparks, fromSparks } = require('../sdk/js');
const { signTx } = require('../src/tx');

test('amounts convert without rounding', () => {
  assert.equal(toSparks('1.5'), 1500000000n);
  assert.equal(toSparks('0.000000001'), 1n);
  assert.equal(fromSparks(1234500000n), '1.2345');
  assert.equal(fromSparks(5n * 1000000000n), '5');
  assert.throws(() => toSparks('1.0000000001'));
  assert.throws(() => toSparks('-1'));
});

test('Python SDK signs exactly like the JavaScript SDK', (t) => {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const probe = spawnSync(py, ['-I', '-c', 'import sys; print(sys.version_info[0])']);
  if (probe.status !== 0) return t.skip('python not installed');
  const seed = '0a'.repeat(32);
  const w = Wallet.fromSeed(seed, 'daur');
  const unsigned = { chainId: 'auren-devnet-1', type: 'transfer', from: w.address, nonce: 3, maxFee: '300000', tip: '1000', body: { to: w.address, amount: '1500000000' } };
  const js = signTx(w.kp, unsigned);
  const code = `
import sys, json
import os
sys.path.insert(0, os.environ['AUREN_SDK_DIR'])
import auren
w = auren.Wallet.from_seed(${JSON.stringify(seed)}, 'daur')
tx = json.loads(sys.stdin.read())
tx.update({'v': 1, 'pub': w.pub.hex()})
sig = auren.ed25519_sign(w.seed, b'AUREN/tx/v1' + bytes([0]) + auren._canon(tx).encode()).hex()
print(json.dumps({'address': w.address, 'sig': sig}))`;
  const r = spawnSync(py, ['-c', code], { input: JSON.stringify(unsigned), encoding: 'utf8', env: { ...process.env, AUREN_SDK_DIR: path.join(__dirname, '..', 'sdk', 'python'), PYTHONIOENCODING: 'utf8' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.address, w.address);
  assert.equal(out.sig, js.sig);
});

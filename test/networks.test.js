'use strict';
// Network identity: every network must be unambiguous so a transaction for one can never be valid on another.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canon, sha256hex } = require('../src/util');
const { resolveParams, DEFAULTS } = require('../src/params');
const { validateGenesis } = require('../src/genesis');
const { Chain } = require('../src/chain');

const root = path.join(__dirname, '..', 'networks');
const nets = JSON.parse(fs.readFileSync(path.join(root, 'networks.json'), 'utf8'));
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, n, 'genesis.json'), 'utf8'));

test('committed genesis files are valid, load into a chain, and match the pinned hashes', () => {
  for (const n of ['devnet', 'testnet']) {
    const g = load(n);
    assert.ok(validateGenesis(g));
    assert.equal(g.chainId, nets[n].chainId);
    assert.equal(sha256hex(canon(g)), nets[n].genesisHash, `${n}: networks.json hash is stale`);
    assert.equal(sha256hex(canon(g)), JSON.parse(fs.readFileSync(path.join(root, n, 'network.json'), 'utf8')).genesisHash);
    assert.equal(g.params.addressPrefix, nets[n].addressPrefix);
    assert.ok(new Chain(g).activeSet.length >= 4, `${n} starts with at least 4 validators`);
  }
});

test('every network has its own chain id, address prefix and EVM chain id (no cross-network replay)', () => {
  const ids = { devnet: resolveParams(load('devnet').params).evmChainId, testnet: resolveParams(load('testnet').params).evmChainId, mainnet: DEFAULTS.evmChainId };
  assert.equal(new Set(Object.values(ids)).size, 3, JSON.stringify(ids));
  assert.deepEqual(ids, { devnet: 77001, testnet: 77002, mainnet: 77000 });
  assert.equal(new Set(Object.values(nets).map((n) => n.addressPrefix)).size, 3);
  assert.equal(new Set(Object.values(nets).map((n) => n.chainId)).size, 3);
});

test('testnet and devnet carry explicit governance parameters shorter than mainnet defaults', () => {
  assert.ok(resolveParams(load('devnet').params).governance.votingBlocks < DEFAULTS.governance.votingBlocks);
  assert.ok(resolveParams(load('testnet').params).governance.votingBlocks < DEFAULTS.governance.votingBlocks);
});

test('mainnet has no genesis in the repo (it is built by the ceremony)', () => {
  assert.equal(fs.existsSync(path.join(root, 'mainnet', 'genesis.json')), false);
});

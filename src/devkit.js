'use strict';
// Helpers for tests, benchmarks and the devnet generator: deterministic keys, an in-process
// "all validators sign" block producer, and transaction builders. NOT used by the production node path.
const { Keypair } = require('./crypto');
const { pubToAddress } = require('./address');
const { AUR } = require('./util');
const { Chain } = require('./chain');
const { signTx, costOfTx } = require('./tx');
const C = require('./consensus');

function devKeys(n, tag = 'test', prefix = 'daur') {
  return Array.from({ length: n }, (_, i) => {
    const op = Keypair.fromPassphrase(`auren/${tag}/operator/${i}`);
    const cons = Keypair.fromPassphrase(`auren/${tag}/consensus/${i}`);
    return { op, cons, address: pubToAddress(op.pub, prefix), index: i };
  });
}

function devAccount(name, tag = 'test', prefix = 'daur') {
  const kp = Keypair.fromPassphrase(`auren/${tag}/account/${name}`);
  return { kp, address: pubToAddress(kp.pub, prefix) };
}

function makeGenesis({ validators, stakes, accounts = [], params = {}, chainId = 'auren-test-1', genesisTime = 1700000000000, prefix = 'daur' }) {
  return {
    chainId, network: 'test', genesisTime,
    params: { addressPrefix: prefix, maxVotingPowerBps: 10000, ...params },
    accounts: accounts.map((a) => ({ address: a.address, balance: a.balance.toString(), ...(a.vesting ? { vesting: a.vesting } : {}) })),
    validators: validators.map((v, i) => ({
      operator: v.address, consPub: v.cons.pub, moniker: `val-${i}`, commissionBps: 500,
      selfStake: (stakes ? stakes[i] : 100000n * AUR).toString(),
    })),
  };
}

/** A chain with n validators (equal stake) plus named funded accounts. */
function makeTestChain({ n = 4, stakes, names = ['alice', 'bob', 'carol', 'dave'], balance = 1000000n * AUR, params = {}, vesting = {} } = {}) {
  const validators = devKeys(n);
  const accts = {};
  for (const name of names) accts[name] = devAccount(name);
  const genesis = makeGenesis({
    validators, stakes, params: { minSelfStake: (1000n * AUR).toString(), ...params },
    accounts: [
      ...Object.values(accts).map((a, i) => ({ address: a.address, balance, ...(vesting[names[i]] ? { vesting: vesting[names[i]] } : {}) })),
      ...validators.map((v) => ({ address: v.address, balance: 10000n * AUR })),
    ],
  });
  return { chain: new Chain(genesis), validators, accts, genesis };
}

/** Produce and commit one block in-process. `signers` limits which validators vote. */
function produce(chain, validators, { candidates = [], evidence = [], round = 0, signers = null, time = null } = {}) {
  const op = chain.proposerFor(round);
  const pk = validators.find((v) => v.address === op);
  const t = time ?? chain.last.time + chain.params.blockTimeMs;
  const { block, res } = chain.buildBlock({ operator: op, signKey: pk.cons, round, time: t, candidates, evidence });
  const set = chain.activeSet;
  const votes = validators
    .filter((v) => set.some((s) => s.operator === v.address) && (!signers || signers.includes(v.address)))
    .map((v) => C.signVote(v.cons, chain.chainId, v.address, block.header.height, round, block.hash));
  const commit = { height: block.header.height, round, blockHash: block.hash, votes: votes.map((x) => ({ validator: x.validator, sig: x.sig })) };
  chain.applyBlock(block, commit);
  return { block, res, commit };
}

function mkTx(chain, who, type, body, { nonce, maxFee, tip = '1000' } = {}) {
  const addr = who.address;
  const acct = chain.state.get('acct', addr);
  const baseFee = chain.baseFee;
  return signTx(who.kp || who.op, {
    chainId: chain.chainId, type, from: addr, nonce: nonce ?? (acct ? acct.nonce : 0),
    maxFee: (maxFee ?? costOfTx({ type, body }, baseFee) * 2n + BigInt(tip)).toString(), tip: String(tip), body,
  });
}

module.exports = { devKeys, devAccount, makeGenesis, makeTestChain, produce, mkTx };

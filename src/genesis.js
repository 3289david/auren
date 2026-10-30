'use strict';
// Genesis construction and validation.
const { canon, sha256hex, AUR } = require('./util');
const { resolveParams } = require('./params');
const { isValidAddress } = require('./address');

function validateGenesis(g) {
  const err = (m) => { throw new Error(`invalid genesis: ${m}`); };
  if (!g || typeof g !== 'object') err('not an object');
  if (typeof g.chainId !== 'string' || !/^[a-z0-9-]{3,40}$/.test(g.chainId)) err('chainId');
  if (!Number.isSafeInteger(g.genesisTime)) err('genesisTime must be unix milliseconds');
  const p = resolveParams(g.params);
  const seen = new Set();
  for (const a of g.accounts || []) {
    if (!isValidAddress(a.address, p.addressPrefix)) err(`bad account address ${a.address}`);
    if (seen.has(a.address)) err(`duplicate account ${a.address}`);
    seen.add(a.address);
    if (!/^\d+$/.test(a.balance)) err(`bad balance for ${a.address}`);
  }
  const ops = new Set(), keys = new Set();
  for (const v of g.validators || []) {
    if (!isValidAddress(v.operator, p.addressPrefix)) err(`bad validator operator ${v.operator}`);
    if (ops.has(v.operator) || keys.has(v.consPub)) err('duplicate validator');
    ops.add(v.operator); keys.add(v.consPub);
    if (!/^[0-9a-f]{64}$/.test(v.consPub)) err('bad consPub');
    if (BigInt(v.selfStake) < p.minSelfStake) err(`validator ${v.operator} below minSelfStake`);
    if (v.commissionBps > p.maxCommissionBps) err('commission too high');
  }
  if (!(g.validators || []).length) err('no validators');
  return true;
}

const genesisHash = (g) => sha256hex(canon(g));

function totalSupply(g) {
  return (g.accounts || []).reduce((s, a) => s + BigInt(a.balance), 0n) + (g.validators || []).reduce((s, v) => s + BigInt(v.selfStake), 0n);
}

module.exports = { validateGenesis, genesisHash, totalSupply, AUR };

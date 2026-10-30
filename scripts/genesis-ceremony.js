#!/usr/bin/env node
'use strict';
// Mainnet genesis assembly from public inputs:
//   --allocations allocations.json   [{ "address": "aur1...", "amount": "1000000", "label": "...", "vesting": { "cliffYears": 1, "years": 4 } }]
//   --gentx-dir ./gentxs             one JSON per validator, produced by `aurenctl gentx`
//   --genesis-time <unix ms>         the agreed launch time
//   --out networks/mainnet
// Every step is verifiable by anyone who has the same inputs: the output hash must match.
const fs = require('node:fs');
const path = require('node:path');
const { verify } = require('../src/crypto');
const { pubToAddress, isValidAddress } = require('../src/address');
const { AUR, canon, sha256hex, parseAur } = require('../src/util');
const { resolveParams } = require('../src/params');
const { validateGenesis, totalSupply } = require('../src/genesis');

const a = Object.fromEntries(process.argv.slice(2).reduce((acc, x, i, arr) => (x.startsWith('--') ? [...acc, [x.slice(2), arr[i + 1]]] : acc), []));
const fail = (m) => { console.error(`ceremony failed: ${m}`); process.exit(1); };
for (const k of ['allocations', 'gentx-dir', 'genesis-time', 'out']) if (!a[k]) fail(`missing --${k}`);

const overrides = { addressPrefix: 'aur' };
const params = resolveParams(overrides);
const chainId = a['chain-id'] || 'auren-mainnet-1';
const allocs = JSON.parse(fs.readFileSync(a.allocations, 'utf8'));
const byAddr = new Map();
for (const x of allocs) {
  if (!isValidAddress(x.address, params.addressPrefix)) fail(`allocation has invalid address "${x.address}"`);
  if (byAddr.has(x.address)) fail(`duplicate allocation for ${x.address}`);
  byAddr.set(x.address, { ...x, spark: parseAur(x.amount) });
}

const validators = [];
for (const f of fs.readdirSync(a['gentx-dir']).filter((n) => n.endsWith('.json')).sort()) {
  const g = JSON.parse(fs.readFileSync(path.join(a['gentx-dir'], f), 'utf8'));
  const { pub, sig, ...body } = g;
  if (body.chainId !== chainId) fail(`${f}: wrong chain id`);
  if (pubToAddress(pub, params.addressPrefix) !== body.operator) fail(`${f}: operator does not match public key`);
  if (!verify(pub, Buffer.concat([Buffer.from('AUREN/gentx/v1\0'), Buffer.from(canon(body))]), sig)) fail(`${f}: bad signature`);
  const stake = BigInt(body.selfStake);
  if (stake < params.minSelfStake) fail(`${f}: self-stake below minimum`);
  const alloc = byAddr.get(body.operator);
  if (!alloc || alloc.spark < stake) fail(`${f}: operator's allocation does not cover its self-stake`);
  alloc.spark -= stake;
  validators.push({ operator: body.operator, consPub: body.consPub, moniker: body.moniker, commissionBps: body.commissionBps, selfStake: stake.toString() });
}
if (validators.length < 4) fail(`need at least 4 gentxs, got ${validators.length}`);

const accounts = [...byAddr.values()].filter((x) => x.spark > 0n).map((x) => {
  const acct = { address: x.address, balance: x.spark.toString() };
  if (x.vesting) {
    const bpy = params.blocksPerYear;
    acct.vesting = { total: x.spark.toString(), start: 0, cliff: Math.round((x.vesting.cliffYears || 0) * bpy), end: Math.round(x.vesting.years * bpy) };
  }
  return acct;
}).sort((p, q) => (p.address < q.address ? -1 : 1));

const genesis = { chainId, network: 'mainnet', genesisTime: Number(a['genesis-time']), params: overrides, accounts, validators };
validateGenesis(genesis);
fs.mkdirSync(a.out, { recursive: true });
fs.writeFileSync(path.join(a.out, 'genesis.json'), JSON.stringify(genesis, null, 2) + '\n');
const hash = sha256hex(canon(genesis));
fs.writeFileSync(path.join(a.out, 'network.json'), JSON.stringify({ chainId, network: 'mainnet', addressPrefix: 'aur', genesisHash: hash, genesisTime: genesis.genesisTime, validators: validators.map(({ operator, moniker, consPub }) => ({ operator, moniker, consPub })) }, null, 2) + '\n');
console.log(`genesis written: ${validators.length} validators, ${accounts.length} accounts, supply ${totalSupply(genesis) / AUR} AUR`);
console.log(`genesis hash: ${hash}\nPublish this hash through several independent channels; every validator must verify it before launch.`);

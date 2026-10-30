'use strict';
// Protocol parameters. Genesis files override any of these; amounts are decimal strings of sparks.
const { AUR } = require('./util');

const DEFAULTS = {
  symbol: 'AUR',
  decimals: 9,
  addressPrefix: 'aur',

  // timing
  blockTimeMs: 2000,
  roundTimeoutMs: 4000,
  maxClockDriftMs: 5000,
  blocksPerYear: 15768000, // 365 d at 2 s

  // validators & staking
  maxValidators: 150,
  minSelfStake: (10000n * AUR).toString(),
  maxVotingPowerBps: 1000, // 10% cap on a single validator's voting power (needs >= ~20 validators to bind)
  maxCommissionBps: 2000,
  unbondingBlocks: 1209600, // 28 days at 2 s
  jailBlocks: 43200, // 1 day at 2 s

  // execution resources (Adaptive Execution Market): two independently priced dimensions
  limits: { compute: 30000000, state: 200000 },
  initialBaseFee: { compute: '40', state: '2000' }, // sparks per resource unit
  minBaseFee: { compute: '10', state: '500' },
  baseFeeChangeDenominator: 8, // max 12.5% change per block per dimension

  // monetary policy (see docs/tokenomics.md)
  issuance: { initialPpm: 30000, decayBps: 1500, floorPpm: 5000 }, // 3.0% -> decays 15%/yr -> 0.5% floor

  slashing: { doubleSignBps: 500, downtimeBps: 10, downtimeWindow: 10000, maxMissedBps: 5000 },

  // native account security
  security: { minDelayBlocks: 43200, limitWindowBlocks: 43200, maxGuardians: 9 },

  evmChainId: 77000, // numeric chain id for Ethereum tooling (wallets, signatures). Check chainlist.org before mainnet.

  // on-chain governance (see docs/governance.md)
  governance: { votingBlocks: 201600, timelockBlocks: 86400, deposit: (1000n * AUR).toString(), quorumBps: 3340, thresholdBps: 5000, vetoBps: 3340 },

  // custom top-level domains: one-time registration fee (burned) and the most a TLD owner may keep of each registration
  tld: { price: (10000n * AUR).toString(), maxOwnerShareBps: 9000 },

  // node rewards (src/noderew.js): bonded full nodes that prove they store the chain share `poolBps` of issuance each epoch
  node: { bond: (10000n * AUR).toString(), epochBlocks: 14400, poolBps: 1000 },

  // optional .aur naming module (burned fees, per year)
  domain: { price3: (100n * AUR).toString(), price4: (20n * AUR).toString(), price5: AUR.toString(), maxYears: 10 },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

/** Merge genesis overrides onto DEFAULTS and convert amount fields to BigInt. */
function resolveParams(overrides = {}) {
  const p = merge(DEFAULTS, overrides);
  p.minSelfStake = BigInt(p.minSelfStake);
  p.initialBaseFee = { compute: BigInt(p.initialBaseFee.compute), state: BigInt(p.initialBaseFee.state) };
  p.minBaseFee = { compute: BigInt(p.minBaseFee.compute), state: BigInt(p.minBaseFee.state) };
  p.domain = { ...p.domain, price3: BigInt(p.domain.price3), price4: BigInt(p.domain.price4), price5: BigInt(p.domain.price5) };
  p.governance = { ...p.governance, deposit: BigInt(p.governance.deposit) };
  p.tld = { ...p.tld, price: BigInt(p.tld.price) };
  p.node = { ...p.node, bond: BigInt(p.node.bond) };
  return p;
}

module.exports = { DEFAULTS, resolveParams, merge };

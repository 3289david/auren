'use strict';
// On-chain governance: stake-weighted proposals that change whitelisted protocol parameters.
//
// Lifecycle: submit (deposit escrowed) -> voting period -> tally -> [timelock] -> executed.
//   quorum   : voted stake >= quorumBps of all bonded stake, else the proposal is rejected and the deposit burned
//   veto     : NoWithVeto >= vetoBps of voted stake  -> rejected, deposit burned
//   passes   : yes / (yes + no + veto) > thresholdBps (abstain counts toward quorum only)
//   timelock : a passed proposal waits timelockBlocks before it takes effect, so users can exit or react
// Voting weight is the voter's bonded stake (all delegations, at tally time). Validators do not vote for their
// delegators: a delegator's own vote is the only one that counts for their stake.
const { SCALE } = require('./util');

const isDec = (s) => typeof s === 'string' && /^\d{1,30}$/.test(s);
const intIn = (lo, hi) => (v) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const amountIn = (lo, hi) => (v) => isDec(v) && BigInt(v) >= BigInt(lo) && BigInt(v) <= BigInt(hi);

/** The only parameters governance may change, with their allowed ranges. Everything else needs a new network. */
const GOV_PARAMS = {
  'limits.compute': intIn(1_000_000, 1_000_000_000),
  'limits.state': intIn(10_000, 10_000_000),
  'baseFeeChangeDenominator': intIn(2, 64),
  'minBaseFee.compute': amountIn(1, 1_000_000),
  'minBaseFee.state': amountIn(1, 1_000_000),
  'maxValidators': intIn(4, 300),
  'maxVotingPowerBps': intIn(100, 10000),
  'maxCommissionBps': intIn(0, 5000),
  'issuance.decayBps': intIn(0, 5000),
  'issuance.floorPpm': intIn(0, 50000),
  'slashing.doubleSignBps': intIn(0, 5000),
  'slashing.downtimeBps': intIn(0, 1000),
  'tld.price': amountIn(0, 10n ** 16n),
  'domain.price3': amountIn(0, 10n ** 15n),
  'domain.price4': amountIn(0, 10n ** 15n),
  'domain.price5': amountIn(0, 10n ** 15n),
};

const OPTIONS = ['yes', 'no', 'abstain', 'veto'];
const propKey = (id) => String(id).padStart(10, '0');

/** Returns an error string, or null if the change set is acceptable. */
function validateChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return 'changes must be an object';
  const keys = Object.keys(changes);
  if (keys.length < 1 || keys.length > 5) return 'a proposal changes between 1 and 5 parameters';
  for (const k of keys) {
    if (!GOV_PARAMS[k]) return `parameter "${k}" cannot be changed by governance`;
    if (!GOV_PARAMS[k](changes[k])) return `value for "${k}" is outside its allowed range`;
  }
  return null;
}

/** Apply dotted-path changes to a (JSON) override object. */
function applyChanges(overrides, changes) {
  const out = structuredClone(overrides || {});
  for (const [path, value] of Object.entries(changes)) {
    const parts = path.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] = o[p] || {};
    o[parts[parts.length - 1]] = value;
  }
  return out;
}

/** Bonded tokens per delegator (sum of the token value of all their delegations) and the grand total. */
function bondedWeights(state) {
  const vals = new Map(state.entries('val').map(([k, v]) => [k, v]));
  const w = new Map();
  let total = 0n;
  for (const v of vals.values()) total += v.tokens;
  for (const [k, d] of state.entries('del')) {
    const [val, del] = k.split('|');
    const v = vals.get(val);
    if (!v || v.shares === 0n) continue;
    w.set(del, (w.get(del) || 0n) + (d.shares * v.tokens) / v.shares);
  }
  return { weights: w, total };
}

function computeTally(state, id) {
  const { weights, total } = bondedWeights(state);
  const t = { yes: 0n, no: 0n, abstain: 0n, veto: 0n };
  for (const [k, opt] of state.entries('vote')) {
    const [pid, voter] = k.split('|');
    if (pid !== propKey(id)) continue;
    t[opt.option] += weights.get(voter) || 0n;
  }
  return { ...t, voted: t.yes + t.no + t.abstain + t.veto, bonded: total };
}

/**
 * End-of-block settlement: tally proposals whose voting period ended, execute passed ones whose timelock expired.
 * Returns { burned, overrides|null } where overrides is the new parameter-override object if anything executed.
 */
function settleProposals(state, params, height) {
  const g = params.governance;
  let burned = 0n;
  let overrides = null;
  for (const [k, p] of state.entries('prop')) {
    if (p.status === 'voting' && height >= p.votingEnd) {
      const t = computeTally(state, p.id);
      const quorum = t.bonded > 0n && t.voted * 10000n >= t.bonded * BigInt(g.quorumBps);
      const vetoed = t.voted > 0n && t.veto * 10000n >= t.voted * BigInt(g.vetoBps);
      const decisive = t.yes + t.no + t.veto;
      const passed = quorum && !vetoed && decisive > 0n && t.yes * 10000n > decisive * BigInt(g.thresholdBps);
      p.tally = { yes: t.yes, no: t.no, abstain: t.abstain, veto: t.veto, bonded: t.bonded };
      if (!quorum || vetoed) { burned += p.deposit; } else {
        const a = state.get('acct', p.proposer) || { balance: 0n, nonce: 0 };
        a.balance += p.deposit; state.set('acct', p.proposer, a);
      }
      p.deposit = 0n;
      p.status = passed ? 'passed' : 'rejected';
      p.reason = passed ? null : !quorum ? 'no quorum' : vetoed ? 'vetoed' : 'threshold not reached';
      if (passed) p.executeAt = height + g.timelockBlocks;
      for (const [vk] of state.entries('vote')) if (vk.startsWith(propKey(p.id) + '|')) state.del('vote', vk);
      state.set('prop', k, p);
    }
    if (p.status === 'passed' && height >= p.executeAt) {
      const err = validateChanges(p.changes);
      if (err) { p.status = 'failed'; p.reason = err; } else {
        overrides = applyChanges(overrides || state.get('meta', 'params') || {}, p.changes);
        p.status = 'executed'; p.executedAt = height;
      }
      state.set('prop', k, p);
    }
  }
  return { burned, overrides };
}

module.exports = { GOV_PARAMS, OPTIONS, propKey, validateChanges, applyChanges, computeTally, settleProposals, SCALE };

'use strict';
// Adaptive Execution Market: two independently priced resource dimensions (compute, state).
// Each dimension has its own EIP-1559-style base fee that moves toward a 50% utilization target.
// The base fee is burned; tips go to the proposer.
const { TYPES, costOf } = require('./tx');

const DIMENSIONS = ['compute', 'state'];

function nextBaseFee(prev, used, params) {
  const out = {};
  const D = BigInt(params.baseFeeChangeDenominator);
  for (const dim of DIMENSIONS) {
    const target = BigInt(params.limits[dim]) / 2n;
    const u = BigInt(used[dim]);
    const p = prev[dim];
    let n = p;
    if (u > target) {
      const delta = (p * (u - target)) / target / D;
      n = p + (delta > 0n ? delta : 1n);
    } else if (u < target) {
      n = p - (p * (target - u)) / target / D;
    }
    if (n < params.minBaseFee[dim]) n = params.minBaseFee[dim];
    out[dim] = n;
  }
  return out;
}

/** Fee quote for every transaction type at a given base fee. */
function quote(baseFee) {
  const out = {};
  for (const type of Object.keys(TYPES)) {
    const c = TYPES[type].cost;
    out[type] = typeof c === 'function'
      ? { cost: { compute: 'gasLimit', state: 'ceil(gasLimit/1000)' }, baseFee: costOf(type, baseFee).toString(), note: 'minimum (21,000 gas); see eth_gasPrice for the per-gas price' }
      : { cost: c, baseFee: costOf(type, baseFee).toString() };
  }
  return out;
}

module.exports = { DIMENSIONS, nextBaseFee, quote };

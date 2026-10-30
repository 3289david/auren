'use strict';
// Conflict-aware lane scheduler. Transactions whose access sets share no key are independent and
// land in different lanes; conflicting transactions share a lane and keep their block order.
// Lanes may run in any order (or on different threads) and produce the same final state, because
// fees/burns/tips are accumulated and applied at end of block rather than touched mid-lane.
const { accessSet } = require('./tx');

function scheduleLanes(txs) {
  const parent = txs.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const owner = new Map();
  // EVM transactions may touch any account or contract: they declare the wildcard '*', which serializes the block.
  if (txs.some((tx) => accessSet(tx).includes('*'))) return [txs.map((_, i) => i)];
  txs.forEach((tx, i) => {
    for (const key of accessSet(tx)) {
      if (owner.has(key)) parent[find(i)] = find(owner.get(key));
      else owner.set(key, i);
    }
  });
  const lanes = new Map();
  txs.forEach((_, i) => {
    const r = find(i);
    if (!lanes.has(r)) lanes.set(r, []);
    lanes.get(r).push(i);
  });
  return [...lanes.values()].sort((a, b) => a[0] - b[0]);
}

module.exports = { scheduleLanes };

'use strict';
// Randomized Proof Consensus (RPC) rewards: a verifiable random draw that pays a small committee every block.
//
//  - Tickets: a node holds a ticket when it is bonded (registerNode) and has proved it stores the chain in the
//    current or previous epoch (nodeProof). One ticket per bonded identity, so extra identities each cost a bond.
//  - Beacon: a hash chain that folds in the precommit signatures that finalized the previous block.
//    beacon(h) = sha256(beacon(h-1) | sorted precommit signatures of block h-1)
//    Nobody can compute it before block h-1 is final, and every node computes the same value.
//  - Draw: k distinct ticket holders are picked uniformly (equal weight; hardware, balance and stake do not matter).
//  - Pay: the block's share of issuance goes equally to the drawn nodes' payout addresses.
//
// Full protocol and threat model: docs/rpc-consensus.md. Reference implementation and simulations:
// https://github.com/3289david/rpc-consensus
const { sha256hex } = require('./util');
const { epochOf } = require('./noderew');

const genesisBeacon = (chainId) => sha256hex(`AUREN/beacon/genesis|${chainId}`);

/** Next beacon value from the previous one and the commit that finalized the previous block. */
function nextBeacon(prev, lastCommit) {
  const sigs = lastCommit && lastCommit.votes ? lastCommit.votes.map((v) => v.sig).sort().join('') : '';
  return sha256hex(`AUREN/beacon/v1|${prev}|${sigs}`);
}

/** Ticket holders at `height`, sorted by address (the order every node uses). */
function ticketHolders(state, params, height) {
  const ep = epochOf(height, params);
  const out = [];
  for (const [addr, n] of state.entries('node')) {
    if (n.provenEpoch >= 1 && ep - n.provenEpoch <= 1 && n.provenEpoch <= ep) out.push([addr, n]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Pick k distinct indexes out of n, uniformly, from the beacon. Anyone can recompute and verify this. */
function pick(beacon, n, k) {
  const pool = Array.from({ length: n }, (_, i) => i), out = [];
  for (let i = 0; i < Math.min(k, n); i++) {
    const r = Number(BigInt('0x' + sha256hex(`AUREN/draw/v1|${beacon}|${i}`)) % BigInt(pool.length));
    out.push(pool.splice(r, 1)[0]);
  }
  return out;
}

/**
 * Run the draw for the block being executed and pay the pool. Mutates state; returns nothing.
 * The pool only grows when there is nobody to pay, so a quiet network never loses the reward.
 */
function runDraw(state, params, height, chainId, lastCommit, getAcct, putAcct) {
  const beacon = nextBeacon(state.get('meta', 'beacon') || genesisBeacon(chainId), lastCommit);
  state.set('meta', 'beacon', beacon);
  const holders = ticketHolders(state, params, height);
  const pool = state.get('meta', 'rpcPool') || 0n;
  if (!holders.length || pool <= 0n) return;
  const idx = pick(beacon, holders.length, params.rpc.committeeSize);
  const each = pool / BigInt(idx.length);
  if (each <= 0n) return;
  const winners = idx.map((i) => holders[i]);
  for (const [, n] of winners) { const a = getAcct(state, n.payout); a.balance += each; putAcct(state, n.payout, a); }
  state.set('meta', 'rpcPool', pool - each * BigInt(idx.length));
  state.set('meta', 'lastDraw', { height, winners: winners.map(([addr]) => addr), each });
}

module.exports = { genesisBeacon, nextBeacon, ticketHolders, pick, runDraw };

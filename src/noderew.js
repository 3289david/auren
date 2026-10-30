'use strict';
// Node rewards: any full node earns AUR by proving it stores the chain.
//
// 1. An operator bonds `params.node.bond` with `registerNode` (the bond is returned after unbonding).
// 2. Every epoch (`params.node.epochBlocks` blocks) the chain derives a challenge from the last block
//    of the previous epoch: one historical block. A node proves it holds the history by sending
//    `nodeProof` with sha256(address | header | txs) of that block. Only a node with the data can compute it.
// 3. `params.node.poolBps` of every block's issuance goes into a pool. At the end of each epoch the pool is
//    split equally between the nodes that proved storage, and paid to their payout addresses.
//    With no provers the pool rolls over.
// The bond limits Sybil identities: k identities cost k bonds and earn k equal shares, the same return as k honest nodes.
const { canon, sha256hex } = require('./util');

const epochOf = (height, params) => Math.floor((height - 1) / params.node.epochBlocks);
/** Epoch 0 has no history to challenge; proofs start in epoch 1. */
const epochStart = (epoch, params) => epoch * params.node.epochBlocks + 1;

/** The historical block (1..last block of the previous epoch) a node must prove it stores. */
function challengeHeight(epoch, params, blockHashAt) {
  const last = epoch * params.node.epochBlocks;
  const h = last >= 1 ? blockHashAt(last) : null;
  if (!h) return null;
  return 1 + Number(BigInt('0x' + h.slice(0, 16)) % BigInt(last));
}
const proofDigest = (address, block) => sha256hex(`${address}|${canon({ header: block.header, txs: block.txs })}`);

/** Pay the pool to the nodes that proved storage in the epoch that ends at `height`. Returns nothing; mutates state. */
function settleEpoch(state, params, height, getAcct, putAcct) {
  if (height % params.node.epochBlocks !== 0) return;
  const epoch = height / params.node.epochBlocks - 1;
  const pool = state.get('meta', 'nodePool') || 0n;
  const winners = [];
  for (const [addr, n] of state.entries('node')) if (n.provenEpoch === epoch) winners.push([addr, n]);
  if (pool <= 0n || winners.length === 0) return;
  const each = pool / BigInt(winners.length);
  if (each <= 0n) return;
  for (const [, n] of winners) { const a = getAcct(state, n.payout); a.balance += each; putAcct(state, n.payout, a); }
  state.set('meta', 'nodePool', pool - each * BigInt(winners.length));
}

module.exports = { epochOf, epochStart, challengeHeight, proofDigest, settleEpoch };

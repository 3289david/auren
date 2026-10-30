'use strict';
// BFT voting primitives: signed votes, commit certificates (> 2/3 voting power), stake-weighted
// proposer selection, double-sign evidence.
const { canon, sha256, unhex, BlockInvalid } = require('./util');
const { verify } = require('./crypto');

const VOTE_TAG = Buffer.from('AUREN/vote/v1\0');
const BLOCK_TAG = Buffer.from('AUREN/block/v1\0');

const PROPOSAL_TAG = Buffer.from('AUREN/proposal/v1\0');

/** A vote signs (chainId, type, height, round, blockHash|null). type is 'prevote' or 'precommit'; null = nil. */
const voteBytes = (chainId, v) => Buffer.concat([VOTE_TAG, Buffer.from(canon({ chainId, type: v.type || 'precommit', height: v.height, round: v.round, blockHash: v.blockHash ?? null }))]);

function signVote(key, chainId, operator, height, round, blockHash, type = 'precommit') {
  const v = { type, height, round, blockHash };
  return { ...v, validator: operator, sig: key.sign(voteBytes(chainId, v)) };
}
const verifyVote = (chainId, consPub, vote) => verify(consPub, voteBytes(chainId, vote), vote.sig);

const proposalBytes = (chainId, p) => Buffer.concat([PROPOSAL_TAG, Buffer.from(canon({ chainId, height: p.height, round: p.round, polRound: p.polRound, blockHash: p.blockHash }))]);
const signProposal = (key, chainId, p) => key.sign(proposalBytes(chainId, p));
const verifyProposal = (chainId, consPub, p) => verify(consPub, proposalBytes(chainId, p), p.sig);

const signBlockHash = (key, hash) => key.sign(Buffer.concat([BLOCK_TAG, unhex(hash)]));
const verifyBlockSig = (consPub, hash, sig) => verify(consPub, Buffer.concat([BLOCK_TAG, unhex(hash)]), sig);

const totalPower = (set) => set.reduce((s, v) => s + v.power, 0n);
const isQuorum = (power, total) => power * 3n > total * 2n; // strictly more than 2/3

/**
 * Verify a commit certificate for `blockHash` against validator set `set`.
 * Returns the set of signer addresses. Throws BlockInvalid if the signatures do not carry > 2/3 of power.
 */
function verifyCommit(chainId, commit, blockHash, height, set) {
  if (!commit || commit.blockHash !== blockHash || commit.height !== height) throw new BlockInvalid('commit does not match block');
  const byOp = new Map(set.map((v) => [v.operator, v]));
  const seen = new Set();
  let power = 0n;
  for (const vt of commit.votes || []) {
    const val = byOp.get(vt.validator);
    if (!val || seen.has(vt.validator)) throw new BlockInvalid('commit has unknown or duplicate signer');
    if (!verifyVote(chainId, val.consPub, { height, round: commit.round, blockHash, sig: vt.sig })) throw new BlockInvalid('commit has bad signature');
    seen.add(vt.validator);
    power += val.power;
  }
  if (!isQuorum(power, totalPower(set))) throw new BlockInvalid('commit lacks > 2/3 voting power');
  return seen;
}

/** Deterministic stake-weighted proposer for (height, round). */
function proposerFor(set, prevHash, height, round) {
  const total = totalPower(set);
  if (total === 0n) throw new Error('empty validator set');
  const seed = sha256(Buffer.concat([unhex(prevHash), Buffer.from(`${height}:${round}`)]));
  let r = BigInt('0x' + seed.toString('hex')) % total;
  for (const v of set) {
    if (r < v.power) return v.operator;
    r -= v.power;
  }
  return set[set.length - 1].operator;
}

/**
 * Equivocation evidence: two validly signed votes of the same type, for the same height AND round,
 * naming different blocks (nil counts as different from a block). Votes in different rounds are legal
 * (a validator may unlock after a later proof-of-lock), so they are not evidence.
 */
function verifyEvidence(chainId, ev, consPub) {
  if (!ev || !ev.a || !ev.b || !['prevote', 'precommit'].includes(ev.type) || !Number.isSafeInteger(ev.round)) return false;
  if ((ev.a.blockHash ?? null) === (ev.b.blockHash ?? null)) return false;
  return [ev.a, ev.b].every((x) => verifyVote(chainId, consPub, { type: ev.type, height: ev.height, round: ev.round, blockHash: x.blockHash, sig: x.sig }));
}

/** Smallest number of validators controlling more than `num/den` of power (decentralization metric). */
function nakamoto(set, num = 1n, den = 3n) {
  const total = totalPower(set);
  const sorted = [...set].sort((a, b) => (a.power > b.power ? -1 : 1));
  let acc = 0n;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].power;
    if (acc * den > total * num) return i + 1;
  }
  return sorted.length;
}

module.exports = {
  signVote, verifyVote, signProposal, verifyProposal, signBlockHash, verifyBlockSig, totalPower, isQuorum,
  verifyCommit, proposerFor, verifyEvidence, nakamoto,
};

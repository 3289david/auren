'use strict';
// The chain: genesis, deterministic block execution, block building and validation.
const {
  canon, sha256hex, merkleRoot, SCALE, TxInvalid, BlockInvalid,
} = require('./util');
const { State } = require('./state');
const { resolveParams, merge } = require('./params');
const gov = require('./gov');
const { nameValid, domKey, fullName } = require('./tld');
const { checkTx, applyTx, txHash, costOf, txCost, TYPES, getAcct, putAcct, spendable } = require('./tx');
const { nextBaseFee, DIMENSIONS } = require('./fees');
const { scheduleLanes } = require('./scheduler');
const C = require('./consensus');
const NR = require('./noderew');
const DRAW = require('./draw');

const HEADER_VERSION = 1;
const emptyHash = sha256hex('');
const jsonify = (x) => JSON.parse(canon(x));
const strFee = (f) => ({ compute: f.compute.toString(), state: f.state.toString() });
const parseFee = (f) => ({ compute: BigInt(f.compute), state: BigInt(f.state) });

// ---------------------------------------------------------------- monetary policy
/** Annual issuance rate (parts per million) at a height: starts at initialPpm, decays yearly to a floor. */
function issuanceRatePpm(params, height) {
  const { initialPpm, decayBps, floorPpm } = params.issuance;
  const floor = BigInt(floorPpm);
  let r = BigInt(initialPpm);
  const years = Math.floor(height / params.blocksPerYear);
  for (let i = 0; i < years && r > floor; i++) r = (r * BigInt(10000 - decayBps)) / 10000n;
  return r < floor ? floor : r;
}

// ---------------------------------------------------------------- validator set
function computeActiveSet(state, params) {
  const vals = state.entries('val').map(([, v]) => v)
    .filter((v) => !v.jailed && !v.tombstoned && v.tokens >= params.minSelfStake);
  vals.sort((a, b) => (a.tokens > b.tokens ? -1 : a.tokens < b.tokens ? 1 : a.operator < b.operator ? -1 : 1));
  const top = vals.slice(0, params.maxValidators);
  const total = top.reduce((s, v) => s + v.tokens, 0n);
  const cap = params.maxVotingPowerBps >= 10000 ? null : (total * BigInt(params.maxVotingPowerBps)) / 10000n;
  return top.map((v) => ({ operator: v.operator, consPub: v.consPub, power: cap !== null && v.tokens > cap ? cap : v.tokens }));
}

// ---------------------------------------------------------------- slashing
function slash(state, v, bps, unbondFromHeight) {
  const b = BigInt(bps);
  let burned = (v.tokens * b) / 10000n;
  v.tokens -= burned;
  if (unbondFromHeight !== null) {
    for (const [k, u] of state.entries('unb')) {
      if (u.validator === v.operator && u.created >= unbondFromHeight) {
        const cut = (u.amount * b) / 10000n;
        u.amount -= cut; burned += cut;
        state.set('unb', k, u);
      }
    }
  }
  return burned;
}

function applyEvidence(env, ev, chainId) {
  const { state, params, height } = env;
  const v = state.get('val', ev.validator);
  if (!v) throw new BlockInvalid('evidence: unknown validator');
  if (v.tombstoned) throw new BlockInvalid('evidence: validator already tombstoned');
  if (!(ev.height < height && ev.height >= height - params.unbondingBlocks)) throw new BlockInvalid('evidence: outside window');
  if (!C.verifyEvidence(chainId, ev, v.consPub)) throw new BlockInvalid('evidence: invalid');
  const burned = slash(state, v, params.slashing.doubleSignBps, ev.height);
  v.jailed = true; v.tombstoned = true; v.jailedUntil = Number.MAX_SAFE_INTEGER;
  state.set('val', v.operator, v);
  return burned;
}

function trackLiveness(env, lastCommit, lastValset) {
  const { state, params, height } = env;
  if (!lastCommit || lastValset.length === 0) return 0n;
  const signed = new Set(lastCommit.votes.map((x) => x.validator));
  const sl = params.slashing;
  let burned = 0n;
  const boundary = height % sl.downtimeWindow === 0;
  for (const ent of lastValset) {
    const v = state.get('val', ent.operator);
    if (!v) continue;
    let dirty = false;
    if (!signed.has(ent.operator)) { v.missed += 1; dirty = true; }
    if (boundary) {
      if (!v.jailed && v.missed * 10000 > sl.downtimeWindow * sl.maxMissedBps) {
        burned += slash(state, v, sl.downtimeBps, null);
        v.jailed = true; v.jailedUntil = height + params.jailBlocks;
      }
      v.missed = 0; dirty = true;
    }
    if (dirty) state.set('val', v.operator, v);
  }
  return burned;
}

// ---------------------------------------------------------------- block execution
/**
 * Execute a block's contents on `state` (a fork). Deterministic: identical inputs give identical
 * outputs on every node. `laneOrder` exists only so tests can prove lanes are order-independent.
 */
function executeBlock(state, p) {
  const { params, chainId, height, proposer, baseFee, txs, evidence, lastCommit, laneOrder, time, blockHashAt, blockAt } = p;
  const env = { state, params, height, baseFee, proposer, time, blockHashAt, blockAt };
  const activeSet = state.get('meta', 'activeSet');
  const lastValset = state.get('meta', 'lastValset');
  let burned = 0n, tips = 0n;

  for (const ev of evidence) burned += applyEvidence(env, ev, chainId);
  burned += trackLiveness(env, lastCommit, lastValset);

  const used = { compute: 0, state: 0 };
  for (const tx of txs) { const c = txCost(tx); for (const d of DIMENSIONS) used[d] += c[d]; }
  for (const d of DIMENSIONS) if (used[d] > params.limits[d]) throw new BlockInvalid(`block exceeds ${d} limit`);

  let lanes = scheduleLanes(txs);
  if (laneOrder) lanes = laneOrder(lanes);
  const receipts = new Array(txs.length);
  for (const lane of lanes) {
    for (const i of lane) {
      const tx = txs[i];
      const r = applyTx(env, tx);
      burned += r.baseCost + r.burned;
      tips += r.tip;
      receipts[i] = { hash: txHash(tx), index: i, status: r.status, code: r.code, fee: (r.baseCost + r.tip).toString(), burned: (r.baseCost + r.burned).toString(), ...(r.extra ? { evm: r.extra } : {}) };
    }
  }

  // ---- end of block ----
  if (tips > 0n) { const a = getAcct(state, proposer); a.balance += tips; putAcct(state, proposer, a); }

  for (const [k, u] of state.entries('unb')) {
    if (Number(k.slice(0, 12)) > height) break;
    const a = getAcct(state, u.delegator); a.balance += u.amount; putAcct(state, u.delegator, a);
    state.del('unb', k);
  }
  for (const [acc, r] of state.entries('rec')) {
    if (r.readyAt > height) continue;
    const a = getAcct(state, acc);
    if (a.security && a.security.recovery) { a.authPub = a.security.recovery.newPub; a.authScheme = a.security.recovery.newScheme ?? 0; a.security.recovery = null; }
    putAcct(state, acc, a);
    state.del('rec', acc);
  }

  // governance: tally finished votes, execute passed proposals whose timelock expired (params apply from the next block)
  const gs = gov.settleProposals(state, params, height);
  burned += gs.burned;
  if (gs.overrides) state.set('meta', 'params', gs.overrides);

  // issuance: minted pro rata to validators that signed the previous block
  let supply = state.get('meta', 'supply');
  let minted = 0n;
  if (lastCommit && lastValset.length) {
    const signed = new Set(lastCommit.votes.map((x) => x.validator));
    const totalLast = C.totalPower(lastValset);
    const mintTotal = (supply * issuanceRatePpm(params, height)) / (1000000n * BigInt(params.blocksPerYear));
    const nodeCut = (mintTotal * BigInt(params.node.poolBps)) / 10000n;
    if (nodeCut > 0n) { state.set('meta', 'nodePool', (state.get('meta', 'nodePool') || 0n) + nodeCut); minted += nodeCut; }
    const rpcCut = (mintTotal * BigInt(params.rpc.poolBps)) / 10000n;
    if (rpcCut > 0n) { state.set('meta', 'rpcPool', (state.get('meta', 'rpcPool') || 0n) + rpcCut); minted += rpcCut; }
    const valMint = mintTotal - nodeCut - rpcCut;
    for (const ent of lastValset) {
      if (!signed.has(ent.operator)) continue;
      const v = state.get('val', ent.operator);
      if (!v || v.shares === 0n) continue;
      const share = (valMint * ent.power) / totalLast;
      const commission = (share * BigInt(v.commissionBps)) / 10000n;
      const rest = share - commission;
      v.commission += commission;
      v.rewardIndex += (rest * SCALE) / v.shares;
      v.pendingTotal += share;
      state.set('val', v.operator, v);
      minted += share;
    }
  }
  NR.settleEpoch(state, params, height, getAcct, putAcct);
  DRAW.runDraw(state, params, height, chainId, lastCommit, getAcct, putAcct);
  supply = supply + minted - burned;
  state.set('meta', 'supply', supply);
  state.set('meta', 'burned', state.get('meta', 'burned') + burned);
  state.set('meta', 'lastValset', activeSet);
  state.set('meta', 'activeSet', computeActiveSet(state, params));

  return { receipts, used, lanes: lanes.length, burned, tips, minted };
}

// ---------------------------------------------------------------- chain
class Chain {
  constructor(genesis) {
    this.genesis = genesis;
    this.chainId = genesis.chainId;
    this.params = resolveParams(genesis.params);
    this.genesisHash = sha256hex(canon(genesis));
    this.state = new State();
    this.height = 0;
    this.blocks = [];
    this.commits = new Map();
    this.txIndex = new Map();
    this.last = { hash: this.genesisHash, time: genesis.genesisTime };
    this.baseFee = { ...this.params.initialBaseFee };
    this._cache = null;
    this._initState();
  }

  /** Effective parameters = genesis parameters + whatever governance has executed (kept in state). */
  _loadParams() {
    const o = this.state.get('meta', 'params');
    this.params = o ? resolveParams(merge(this.genesis.params || {}, o)) : resolveParams(this.genesis.params);
  }

  getProposals() {
    return this.state.entries('prop').map(([, p]) => {
      const out = jsonify(p);
      if (p.status === 'voting') { const t = gov.computeTally(this.state, p.id); out.tally = jsonify({ yes: t.yes, no: t.no, abstain: t.abstain, veto: t.veto, bonded: t.bonded }); }
      return out;
    }).reverse();
  }

  _initState() {
    const s = this.state, p = this.params;
    let supply = 0n;
    for (const a of this.genesis.accounts || []) {
      const acct = { balance: BigInt(a.balance), nonce: 0 };
      if (a.vesting) acct.vesting = { total: BigInt(a.vesting.total), start: a.vesting.start, cliff: a.vesting.cliff, end: a.vesting.end };
      s.set('acct', a.address, acct);
      supply += acct.balance;
    }
    for (const v of this.genesis.validators || []) {
      const stake = BigInt(v.selfStake);
      s.set('val', v.operator, {
        operator: v.operator, consPub: v.consPub, moniker: v.moniker, commissionBps: v.commissionBps,
        tokens: stake, shares: stake, rewardIndex: 0n, commission: 0n, pendingTotal: 0n,
        jailed: false, jailedUntil: 0, tombstoned: false, missed: 0, created: 0,
      });
      s.set('del', `${v.operator}|${v.operator}`, { shares: stake, index: 0n });
      supply += stake;
    }
    s.set('meta', 'supply', supply);
    s.set('meta', 'burned', 0n);
    s.set('meta', 'lastValset', []);
    s.set('meta', 'activeSet', computeActiveSet(s, p));
    if (this.activeSet.length === 0) throw new Error('genesis has no eligible validators');
  }

  get activeSet() { return this.state.get('meta', 'activeSet'); }
  get supply() { return this.state.get('meta', 'supply'); }
  get burned() { return this.state.get('meta', 'burned'); }
  proposerFor(round, height = this.height + 1) { return C.proposerFor(this.activeSet, this.last.hash, height, round); }
  getBlock(h) { return this.blocks[h - 1] || null; }
  get tip() { return this.blocks[this.height - 1] || null; }

  // ---- building ----
  _selectTxs(candidates, baseFee, height) {
    const trial = this.state.fork();
    const env = { state: trial, params: this.params, height, baseFee };
    const used = { compute: 0, state: 0 };
    const out = [];
    for (const tx of candidates) {
      const c = txCost(tx);
      if (DIMENSIONS.some((d) => used[d] + c[d] > this.params.limits[d])) continue;
      try { applyTx(env, tx); } catch (e) { if (e instanceof TxInvalid) continue; throw e; }
      for (const d of DIMENSIONS) used[d] += c[d];
      out.push(tx);
    }
    return out;
  }

  _assemble({ operator, signKey, round, time, txs, evidence }) {
    const height = this.height + 1;
    const baseFee = this.baseFee;
    const lastCommit = height > 1 ? this.commits.get(this.height) : null;
    const fork = this.state.fork();
    const res = executeBlock(fork, { params: this.params, chainId: this.chainId, height, proposer: operator, baseFee, txs, evidence, lastCommit, time, blockHashAt: (n) => this.getBlock(n)?.hash, blockAt: (n) => this.getBlock(n) });
    const header = {
      v: HEADER_VERSION, chainId: this.chainId, height, round, time, prevHash: this.last.hash, proposer: operator,
      baseFee: strFee(baseFee),
      txRoot: merkleRoot(txs.map(txHash)),
      evidenceRoot: evidence.length ? merkleRoot(evidence.map((e) => sha256hex(canon(e)))) : emptyHash,
      lastCommitHash: lastCommit ? sha256hex(canon(lastCommit)) : emptyHash,
      receiptsRoot: merkleRoot(res.receipts.map((r) => sha256hex(canon(r)))),
      stateRoot: fork.root(),
      used: { compute: String(res.used.compute), state: String(res.used.state) },
      txCount: txs.length,
    };
    const hash = sha256hex(canon(header));
    const block = { header, hash, txs, evidence, lastCommit, sig: C.signBlockHash(signKey, hash) };
    this._cache = { hash, fork, res };
    return { block, res };
  }

  /** Build a proposal for the next height. Drops candidate txs that are not currently valid. */
  buildBlock({ operator, signKey, round = 0, time = Date.now(), candidates = [], evidence = [] }) {
    const t = Math.max(time, this.last.time + 1);
    const txs = this._selectTxs(candidates, this.baseFee, this.height + 1);
    try {
      return this._assemble({ operator, signKey, round, time: t, txs, evidence });
    } catch (e) {
      if (!txs.length && !evidence.length) throw e;
      return this._assemble({ operator, signKey, round, time: t, txs: [], evidence: [] }); // fall back to an empty block
    }
  }

  // ---- validation ----
  /** Fully validate a block against current state without committing. Throws BlockInvalid. */
  validateBlock(block, { now = null } = {}) {
    if (this._cache && this._cache.hash === block.hash) {
      if (now !== null && block.header.time > now + this.params.maxClockDriftMs) throw new BlockInvalid('block time too far in the future');
      return this._cache;
    }
    const h = block.header;
    if (!h || h.v !== HEADER_VERSION) throw new BlockInvalid('bad header version');
    if (h.chainId !== this.chainId) throw new BlockInvalid('wrong chain');
    if (h.height !== this.height + 1) throw new BlockInvalid(`expected height ${this.height + 1}`);
    if (h.prevHash !== this.last.hash) throw new BlockInvalid('wrong parent');
    if (sha256hex(canon(h)) !== block.hash) throw new BlockInvalid('hash mismatch');
    if (!(h.time > this.last.time)) throw new BlockInvalid('time not increasing');
    if (now !== null && h.time > now + this.params.maxClockDriftMs) throw new BlockInvalid('block time too far in the future');
    if (!Number.isSafeInteger(h.round) || h.round < 0) throw new BlockInvalid('bad round');

    const set = this.activeSet;
    if (C.proposerFor(set, this.last.hash, h.height, h.round) !== h.proposer) throw new BlockInvalid('wrong proposer for round');
    const pv = set.find((v) => v.operator === h.proposer);
    if (!C.verifyBlockSig(pv.consPub, block.hash, block.sig)) throw new BlockInvalid('bad proposer signature');

    const exp = this.baseFee;
    if (h.baseFee.compute !== exp.compute.toString() || h.baseFee.state !== exp.state.toString()) throw new BlockInvalid('wrong base fee');

    let lastCommit = null;
    if (h.height > 1) {
      lastCommit = block.lastCommit;
      C.verifyCommit(this.chainId, lastCommit, this.last.hash, h.height - 1, this.state.get('meta', 'lastValset'));
    } else if (block.lastCommit) throw new BlockInvalid('unexpected lastCommit');
    if ((lastCommit ? sha256hex(canon(lastCommit)) : emptyHash) !== h.lastCommitHash) throw new BlockInvalid('lastCommit hash mismatch');

    const txs = block.txs, evidence = block.evidence || [];
    if (merkleRoot(txs.map(txHash)) !== h.txRoot) throw new BlockInvalid('txRoot mismatch');
    if ((evidence.length ? merkleRoot(evidence.map((e) => sha256hex(canon(e)))) : emptyHash) !== h.evidenceRoot) throw new BlockInvalid('evidenceRoot mismatch');
    if (txs.length !== h.txCount) throw new BlockInvalid('txCount mismatch');

    const fork = this.state.fork();
    let res;
    try {
      for (const tx of txs) checkTx(tx, this.params, this.chainId);
      res = executeBlock(fork, { params: this.params, chainId: this.chainId, height: h.height, proposer: h.proposer, baseFee: exp, txs, evidence, lastCommit, time: h.time, blockHashAt: (n) => this.getBlock(n)?.hash, blockAt: (n) => this.getBlock(n) });
    } catch (e) {
      if (e instanceof TxInvalid) throw new BlockInvalid(`invalid transaction: ${e.code} ${e.message}`);
      throw e;
    }
    if (merkleRoot(res.receipts.map((r) => sha256hex(canon(r)))) !== h.receiptsRoot) throw new BlockInvalid('receiptsRoot mismatch');
    if (String(res.used.compute) !== h.used.compute || String(res.used.state) !== h.used.state) throw new BlockInvalid('resource usage mismatch');
    if (fork.root() !== h.stateRoot) throw new BlockInvalid('stateRoot mismatch');
    const out = { hash: block.hash, fork, res };
    this._cache = out;
    return out;
  }

  /** Validate (or reuse cached validation), verify the commit certificate, then commit the block. */
  applyBlock(block, commit) {
    const v = this.validateBlock(block);
    C.verifyCommit(this.chainId, commit, block.hash, block.header.height, this.activeSet);
    v.fork.commit();
    this.height = block.header.height;
    this.blocks.push(block);
    this.commits.set(this.height, commit);
    this.last = { hash: block.hash, time: block.header.time };
    this.baseFee = nextBaseFee(parseFee(block.header.baseFee), { compute: block.header.used.compute, state: block.header.used.state }, this.params);
    this._loadParams(); // a governance proposal may have just changed parameters; they apply from the next block
    block.txs.forEach((tx, i) => this.txIndex.set(txHash(tx), { height: this.height, index: i }));
    this._cache = null;
    return v.res;
  }

  // ---- read APIs ----
  getAccount(addr) {
    const a = this.state.get('acct', addr);
    if (!a) return { address: addr, balance: '0', spendable: '0', nonce: 0, exists: false };
    const out = jsonify({ address: addr, ...a, exists: true });
    out.spendable = spendable(a, this.height + 1).toString();
    return out;
  }
  getDelegations(addr) {
    const out = [];
    for (const [k, d] of this.state.entries('del')) {
      const [val, del] = k.split('|');
      if (del !== addr) continue;
      const v = this.state.get('val', val);
      const pending = (d.shares * (v.rewardIndex - d.index)) / SCALE + (addr === val ? v.commission : 0n);
      out.push(jsonify({ validator: val, shares: d.shares, tokens: v.shares ? (d.shares * v.tokens) / v.shares : 0n, pendingRewards: pending }));
    }
    return out;
  }
  /** Node-reward status: the pool, the current epoch, this epoch's storage challenge and registered nodes. */
  getNodeInfo(addr) {
    const P = this.params, h = this.height + 1, ep = NR.epochOf(h, P);
    const ch = ep >= 1 ? NR.challengeHeight(ep, P, (n) => this.getBlock(n)?.hash) : null;
    const nodes = this.state.entries('node').map(([a, n]) => ({ address: a, bond: n.bond, payout: n.payout, since: n.since, proven: n.provenEpoch === ep, lastProvenEpoch: n.provenEpoch }));
    return jsonify({
      pool: this.state.get('meta', 'nodePool') || 0n, bond: P.node.bond, epochBlocks: P.node.epochBlocks, poolBps: P.node.poolBps,
      epoch: ep, epochEndsAtHeight: (ep + 1) * P.node.epochBlocks, challengeHeight: ch, nodes: addr ? nodes.filter((n) => n.address === addr) : nodes,
    });
  }
  /** Random-draw (RPC) status: the beacon, the pool, who holds a ticket and the last draw. */
  getDrawInfo() {
    const P = this.params, h = this.height + 1;
    const holders = DRAW.ticketHolders(this.state, P, h);
    return jsonify({
      beacon: this.state.get('meta', 'beacon') || DRAW.genesisBeacon(this.chainId), pool: this.state.get('meta', 'rpcPool') || 0n,
      poolBps: P.rpc.poolBps, committeeSize: P.rpc.committeeSize, epoch: NR.epochOf(h, P),
      ticketHolders: holders.map(([a, n]) => ({ address: a, payout: n.payout, provenEpoch: n.provenEpoch })), lastDraw: this.state.get('meta', 'lastDraw') || null,
    });
  }
  getUnbonding(addr) {
    return this.state.entries('unb').filter(([, u]) => u.delegator === addr)
      .map(([k, u]) => jsonify({ validator: u.validator, amount: u.amount, matureAtHeight: Number(k.slice(0, 12)) }));
  }
  getValidators() {
    const active = new Map(this.activeSet.map((v) => [v.operator, v.power]));
    return this.state.entries('val').map(([, v]) => jsonify({
      operator: v.operator, moniker: v.moniker, consPub: v.consPub, tokens: v.tokens, commissionBps: v.commissionBps,
      jailed: v.jailed, tombstoned: v.tombstoned, jailedUntil: v.jailedUntil, missed: v.missed,
      active: active.has(v.operator), power: active.get(v.operator) ?? 0n,
    })).sort((a, b) => (BigInt(b.tokens) > BigInt(a.tokens) ? 1 : -1));
  }
  /** Look up a name: "alice.aur", "alice.mytld", or a bare label (= .aur). */
  getDomain(name) {
    const n = nameValid(String(name).toLowerCase());
    if (!n) return null;
    const d = this.state.get('dom', domKey(n));
    if (!d || d.expiresAt <= this.height) return null;
    return jsonify(d);
  }
  getTld(tld) { const t = this.state.get('tld', tld); return t ? jsonify({ tld, ...t, domains: this._domainCount(tld) }) : null; }
  _domainCount(tld) { let n = 0; for (const [k, d] of this.state.entries('dom')) if (d.expiresAt > this.height && (tld === 'aur' ? !k.includes('.') : k.endsWith('.' + tld))) n++; return n; }
  listTlds() {
    const out = [{ tld: 'aur', owner: null, builtIn: true, open: true, price: null, ownerShareBps: 0, domains: this._domainCount('aur') }];
    for (const [tld] of this.state.entries('tld')) out.push(this.getTld(tld));
    return out;
  }
  /** Reverse name for an address, only if it still resolves forward to the same address (anti-spoofing). */
  reverse(addr) {
    const r = this.state.get('rev', addr);
    if (!r) return null;
    const d = this.getDomain(r.name);
    return d && d.target === addr ? r.name : null;
  }

  /**
   * A resolution a client can verify without trusting this node: the name record and the validator set that
   * signed the latest block, each with a Merkle proof against that block's stateRoot, plus the block header
   * and its commit certificate. See docs/name-resolution.md for the client-side checks.
   */
  resolveWithProof(name) {
    const n = nameValid(String(name).toLowerCase());
    if (!n) return null;
    const key = domKey(n);
    const d = this.state.get('dom', key);
    if (!d || d.expiresAt <= this.height || this.height < 1) return null;
    const block = this.getBlock(this.height);
    return jsonify({
      name: fullName(n), chainId: this.chainId, genesisHash: this.genesisHash, owner: d.owner, target: d.target, expiresAt: d.expiresAt, records: d.records || {},
      proof: {
        height: this.height, block: { header: block.header, hash: block.hash }, commit: this.commits.get(this.height),
        record: { ns: 'dom', key, value: d, steps: this.state.prove('dom', key).steps },
        validators: { ns: 'meta', key: 'lastValset', value: this.state.get('meta', 'lastValset'), steps: this.state.prove('meta', 'lastValset').steps },
      },
    });
  }

  bondedTokens() { return this.state.entries('val').reduce((s, [, v]) => s + v.tokens, 0n); }
  tipRateInfo() {
    return { ratePpm: issuanceRatePpm(this.params, this.height + 1).toString() };
  }

  /** Dry-run a signed transaction on a throwaway fork and return fee and state effects. */
  simulate(tx) {
    checkTx(tx, this.params, this.chainId);
    const fork = this.state.fork();
    const env = { state: fork, params: this.params, height: this.height + 1, baseFee: this.baseFee, time: Date.now(), proposer: this.activeSet[0].operator, blockHashAt: (n) => this.getBlock(n)?.hash, blockAt: (n) => this.getBlock(n) };
    const r = applyTx(env, tx);
    return jsonify({
      ok: r.status === 1, code: r.code, fee: r.baseCost + r.tip, burned: r.baseCost + r.burned,
      effects: fork.diff().filter((d) => d.ns !== 'meta').map((d) => ({ ns: d.ns, key: d.key, before: d.before, after: d.after })),
    });
  }
}

module.exports = { Chain, executeBlock, computeActiveSet, issuanceRatePpm, jsonify, parseFee, strFee, costOf };

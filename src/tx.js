'use strict';
// Transactions: format, signing, resource costs, access sets and state-transition handlers.
//
// Every transaction type declares (1) a fixed resource cost {compute, state}, (2) an access set
// (the state keys it may read or write) and (3) a handler. Fixed costs make fees quotable ahead of
// time; access sets let the block executor prove which transactions are independent (see scheduler.js).
const { canon, sha256hex, SCALE, ceilDiv, minB, TxInvalid, TxFail } = require('./util');
const { verify, verifyWebAuthn } = require('./crypto');
const gov = require('./gov');
const NR = require('./noderew');
const { WEI, runEvm } = require('./evm/host');
const { envelopeFromRaw } = require('./evm/ethtx');
const { pubToAddress, isValidAddress } = require('./address');

const TX_VERSION = 1;
const SIG_TAG = Buffer.from('AUREN/tx/v1\0');

const isDec = (s) => typeof s === 'string' && /^(0|[1-9]\d{0,29})$/.test(s);
const isPos = (s) => isDec(s) && BigInt(s) > 0n;
const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
/** Public-key format per signature scheme: 0 = Ed25519 (32 bytes), 2 = WebAuthn ECDSA P-256 (uncompressed, 65 bytes). */
const pubOk = (scheme, pub) => (scheme === 2 ? typeof pub === 'string' && /^04[0-9a-f]{128}$/.test(pub) : scheme === 4 ? typeof pub === 'string' && /^[0-9a-f]{128}$/.test(pub) : isHex64(pub));
/** May this transaction act for `acct`? After a recovery the account has an explicit authorized key + scheme. */
function isAuthorized(acct, tx, prefix) {
  const scheme = tx.scheme ?? 0;
  if (acct.authPub) return tx.pub === acct.authPub && scheme === (acct.authScheme ?? 0);
  return pubToAddress(tx.pub, prefix, scheme) === tx.from;
}
const isInt = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/**
 * Registration rules that blunt look-alike and phishing names: ASCII only (no homograph alphabets),
 * no "--" (blocks IDNA/punycode "xn--" spoofing), and a name may not look like an address or a raw key
 * (it cannot start with "<prefix>1", and 40+ hex characters are rejected).
 */
function nameOk(name, params) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('--')) return false;
  if (name.startsWith(`${params.addressPrefix}1`) || /^[a-z]{1,6}1[02-9ac-hj-np-z]{20,}$/.test(name) || /^[0-9a-f]{40,}$/.test(name)) return false;
  return true;
}
const RECORD_KEY_RE = /^(addr:[a-z0-9-]{3,8}:[A-Za-z0-9-]{1,32}|text:[a-z0-9._-]{1,32}|content)$/;
const MAX_RECORDS = 16;
const { parseName, domKey, fullName, nameValid, tldOk } = require('./tld');
function checkPolicy(b, p) {
  if (typeof b.open !== 'boolean') throw new TxInvalid('BAD_BODY', 'open must be true or false');
  if (!isDec(b.price)) throw new TxInvalid('BAD_BODY', 'price must be sparks per year, as a decimal string');
  if (!isInt(b.ownerShareBps, 0, p.tld.maxOwnerShareBps)) throw new TxInvalid('BAD_BODY', `ownerShareBps must be 0-${p.tld.maxOwnerShareBps}`);
}

const signingBytes = (tx) => {
  const { sig, ...rest } = tx;
  return Buffer.concat([SIG_TAG, Buffer.from(canon(rest))]);
};
const txHash = (tx) => sha256hex(canon(tx));
function signTx(keypair, unsigned) {
  const tx = { ...unsigned, v: TX_VERSION, pub: keypair.pub };
  return { ...tx, sig: keypair.sign(signingBytes(tx)) };
}

// ---------- account helpers ----------
const getAcct = (s, a) => s.get('acct', a) || { balance: 0n, nonce: 0 };
const putAcct = (s, a, v) => s.set('acct', a, v);
const delKey = (val, del) => `${val}|${del}`;

/** Vesting-aware spendable balance. */
function spendable(a, height) {
  let locked = 0n;
  const v = a.vesting;
  if (v && height < v.end) {
    if (height < v.cliff) locked = v.total;
    else locked = (v.total * BigInt(v.end - Math.max(height, v.start))) / BigInt(v.end - v.start);
  }
  return a.balance > locked ? a.balance - locked : 0n;
}

/** Apply a queued security change once its timelock has expired. */
function settleSecurity(a, height) {
  const sec = a.security;
  if (sec && sec.pending && sec.pending.readyAt <= height) {
    Object.assign(sec, sec.pending.config);
    sec.pending = null;
  }
}

/** Daily send limit (docs/security.md). Applies to native transfers AND to value sent by EVM transactions. */
function enforceLimit(a, amt, height, params) {
  settleSecurity(a, height);
  const sec = a.security;
  if (sec && sec.dailyLimit !== null) {
    const w = Math.floor(height / params.security.limitWindowBlocks);
    if (sec.window !== w) { sec.window = w; sec.spent = 0n; }
    if (sec.spent + amt > sec.dailyLimit) throw new TxFail('DAILY_LIMIT_EXCEEDED');
    sec.spent += amt;
  }
}

function settleReward(v, d) {
  const pend = (d.shares * (v.rewardIndex - d.index)) / SCALE;
  d.index = v.rewardIndex;
  return pend;
}

/** Pay out a delegator's accrued rewards (and the operator's commission) into account `a`. */
function payRewards(v, d, a, from) {
  const pend = settleReward(v, d);
  v.pendingTotal -= pend;
  a.balance += pend;
  if (from === v.operator && v.commission > 0n) {
    a.balance += v.commission;
    v.pendingTotal -= v.commission;
    v.commission = 0n;
  }
  return pend;
}

function domainPrice(params, name, years) {
  const d = params.domain;
  const per = name.length === 3 ? d.price3 : name.length === 4 ? d.price4 : d.price5;
  return per * BigInt(years);
}

const sortedUnique = (arr) => [...new Set(arr)].sort();

// ---------- transaction types ----------
const TYPES = {
  transfer: {
    cost: { compute: 21000, state: 100 },
    check: (b, p) => {
      if (!isValidAddress(b.to, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid recipient');
      if (!isPos(b.amount)) throw new TxInvalid('BAD_BODY', 'invalid amount');
    },
    access: (tx) => [`acct:${tx.from}`, `acct:${tx.body.to}`],
    run({ state, height, params }, tx) {
      const amt = BigInt(tx.body.amount);
      const a = getAcct(state, tx.from);
      enforceLimit(a, amt, height, params);
      if (spendable(a, height) < amt) throw new TxFail('INSUFFICIENT_BALANCE');
      if (tx.body.to === tx.from) { putAcct(state, tx.from, a); return {}; }
      a.balance -= amt;
      putAcct(state, tx.from, a);
      const b = getAcct(state, tx.body.to);
      b.balance += amt;
      putAcct(state, tx.body.to, b);
      return {};
    },
  },

  delegate: {
    cost: { compute: 60000, state: 250 },
    check: (b, p) => {
      if (!isValidAddress(b.validator, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid validator');
      if (!isPos(b.amount)) throw new TxInvalid('BAD_BODY', 'invalid amount');
    },
    access: (tx) => [`acct:${tx.from}`, `val:${tx.body.validator}`, `del:${delKey(tx.body.validator, tx.from)}`],
    run({ state, height }, tx) {
      const amt = BigInt(tx.body.amount);
      const v = state.get('val', tx.body.validator);
      if (!v) throw new TxFail('NO_SUCH_VALIDATOR');
      if (v.tombstoned) throw new TxFail('VALIDATOR_TOMBSTONED');
      const a = getAcct(state, tx.from);
      const dk = delKey(v.operator, tx.from);
      const d = state.get('del', dk) || { shares: 0n, index: v.rewardIndex };
      payRewards(v, d, a, tx.from);
      if (spendable(a, height) < amt) throw new TxFail('INSUFFICIENT_BALANCE');
      const shares = v.shares === 0n || v.tokens === 0n ? amt : (amt * v.shares) / v.tokens;
      if (shares <= 0n) throw new TxFail('AMOUNT_TOO_SMALL');
      a.balance -= amt;
      v.tokens += amt; v.shares += shares; d.shares += shares;
      putAcct(state, tx.from, a); state.set('val', v.operator, v); state.set('del', dk, d);
      return {};
    },
  },

  undelegate: {
    cost: { compute: 70000, state: 300 },
    check: (b, p) => {
      if (!isValidAddress(b.validator, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid validator');
      if (!isPos(b.amount)) throw new TxInvalid('BAD_BODY', 'invalid amount');
    },
    access: (tx) => [`acct:${tx.from}`, `val:${tx.body.validator}`, `del:${delKey(tx.body.validator, tx.from)}`],
    run({ state, height, params }, tx) {
      const v = state.get('val', tx.body.validator);
      const dk = delKey(tx.body.validator, tx.from);
      const d = state.get('del', dk);
      if (!v || !d || d.shares === 0n) throw new TxFail('NOT_DELEGATED');
      const a = getAcct(state, tx.from);
      payRewards(v, d, a, tx.from);
      const amt = BigInt(tx.body.amount);
      const value = (d.shares * v.tokens) / v.shares;
      if (amt > value) throw new TxFail('EXCEEDS_STAKE');
      const all = amt === value;
      const shares = all ? d.shares : minB(d.shares, ceilDiv(amt * v.shares, v.tokens));
      const out = all ? value : (shares * v.tokens) / v.shares;
      if (out <= 0n) throw new TxFail('AMOUNT_TOO_SMALL');
      d.shares -= shares; v.shares -= shares; v.tokens -= out;
      const maturity = height + params.unbondingBlocks;
      state.set('unb', `${String(maturity).padStart(12, '0')}|${tx.from}|${tx.nonce}`,
        { delegator: tx.from, validator: v.operator, amount: out, created: height });
      if (d.shares === 0n) state.del('del', dk); else state.set('del', dk, d);
      state.set('val', v.operator, v); putAcct(state, tx.from, a);
      return {};
    },
  },

  claim: {
    cost: { compute: 40000, state: 100 },
    check: (b, p) => { if (!isValidAddress(b.validator, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid validator'); },
    access: (tx) => [`acct:${tx.from}`, `val:${tx.body.validator}`, `del:${delKey(tx.body.validator, tx.from)}`],
    run({ state }, tx) {
      const v = state.get('val', tx.body.validator);
      const dk = delKey(tx.body.validator, tx.from);
      const d = state.get('del', dk);
      if (!v || !d) throw new TxFail('NOT_DELEGATED');
      const a = getAcct(state, tx.from);
      payRewards(v, d, a, tx.from);
      putAcct(state, tx.from, a); state.set('val', v.operator, v); state.set('del', dk, d);
      return {};
    },
  },

  createValidator: {
    cost: { compute: 150000, state: 600 },
    check: (b, p) => {
      if (!isHex64(b.consPub)) throw new TxInvalid('BAD_BODY', 'invalid consensus key');
      if (!isInt(b.commissionBps, 0, p.maxCommissionBps)) throw new TxInvalid('BAD_BODY', 'commission out of range');
      if (typeof b.moniker !== 'string' || !/^[\x20-\x7e]{1,32}$/.test(b.moniker)) throw new TxInvalid('BAD_BODY', 'invalid moniker');
      if (!isPos(b.amount) || BigInt(b.amount) < p.minSelfStake) throw new TxInvalid('BAD_BODY', 'self-stake below minimum');
    },
    access: (tx) => [`acct:${tx.from}`, `val:${tx.from}`, `del:${delKey(tx.from, tx.from)}`, 'global:valkeys'],
    run({ state, height }, tx) {
      const amt = BigInt(tx.body.amount);
      if (state.has('val', tx.from)) throw new TxFail('VALIDATOR_EXISTS');
      for (const [, other] of state.entries('val')) if (other.consPub === tx.body.consPub) throw new TxFail('CONSENSUS_KEY_IN_USE');
      const a = getAcct(state, tx.from);
      if (spendable(a, height) < amt) throw new TxFail('INSUFFICIENT_BALANCE');
      a.balance -= amt;
      state.set('val', tx.from, {
        operator: tx.from, consPub: tx.body.consPub, moniker: tx.body.moniker, commissionBps: tx.body.commissionBps,
        tokens: amt, shares: amt, rewardIndex: 0n, commission: 0n, pendingTotal: 0n,
        jailed: false, jailedUntil: 0, tombstoned: false, missed: 0, created: height,
      });
      state.set('del', delKey(tx.from, tx.from), { shares: amt, index: 0n });
      putAcct(state, tx.from, a);
      return {};
    },
  },

  unjail: {
    cost: { compute: 40000, state: 100 },
    check: () => {},
    access: (tx) => [`acct:${tx.from}`, `val:${tx.from}`],
    run({ state, height, params }, tx) {
      const v = state.get('val', tx.from);
      if (!v) throw new TxFail('NO_SUCH_VALIDATOR');
      if (v.tombstoned) throw new TxFail('VALIDATOR_TOMBSTONED');
      if (!v.jailed) throw new TxFail('NOT_JAILED');
      if (height < v.jailedUntil) throw new TxFail('STILL_JAILED');
      if (v.tokens < params.minSelfStake) throw new TxFail('STAKE_BELOW_MINIMUM');
      v.jailed = false; v.missed = 0;
      state.set('val', tx.from, v);
      return {};
    },
  },

  // ----- node rewards (src/noderew.js, docs/node-rewards.md) -----
  registerNode: {
    cost: { compute: 60000, state: 300 },
    check: (b, p) => { if (!isValidAddress(b.payout, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid payout address'); },
    access: (tx) => [`acct:${tx.from}`, `node:${tx.from}`],
    run({ state, height, params }, tx) {
      if (state.has('node', tx.from)) throw new TxFail('NODE_EXISTS');
      const a = getAcct(state, tx.from);
      if (spendable(a, height) < params.node.bond) throw new TxFail('INSUFFICIENT_BOND');
      a.balance -= params.node.bond;
      putAcct(state, tx.from, a);
      state.set('node', tx.from, { bond: params.node.bond, payout: tx.body.payout, since: height, provenEpoch: -1 });
      return {};
    },
  },
  unregisterNode: {
    cost: { compute: 50000, state: 250 },
    check: () => {},
    access: (tx) => [`acct:${tx.from}`, `node:${tx.from}`],
    run({ state, height, params }, tx) {
      const n = state.get('node', tx.from);
      if (!n) throw new TxFail('NOT_A_NODE');
      state.del('node', tx.from);
      state.set('unb', `${String(height + params.unbondingBlocks).padStart(12, '0')}|${tx.from}|${tx.nonce}`,
        { delegator: tx.from, validator: null, amount: n.bond, created: height });
      return {};
    },
  },
  nodeProof: {
    cost: { compute: 60000, state: 150 },
    check: (b) => { if (!isInt(b.epoch, 1, 1e9) || !isHex64(b.digest)) throw new TxInvalid('BAD_BODY', 'epoch and a 64-hex digest are required'); },
    access: (tx) => [`acct:${tx.from}`, `node:${tx.from}`],
    run({ state, height, params, blockHashAt, blockAt }, tx) {
      const n = state.get('node', tx.from);
      if (!n) throw new TxFail('NOT_A_NODE');
      const ep = NR.epochOf(height, params);
      if (tx.body.epoch !== ep || ep < 1) throw new TxFail('WRONG_EPOCH');
      if (n.since > ep * params.node.epochBlocks) throw new TxFail('NODE_TOO_NEW'); // must be bonded before the epoch began
      if (n.provenEpoch === ep) throw new TxFail('ALREADY_PROVEN');
      const ch = NR.challengeHeight(ep, params, blockHashAt);
      const blk = ch && blockAt ? blockAt(ch) : null;
      if (!blk || NR.proofDigest(tx.from, blk) !== tx.body.digest) throw new TxFail('BAD_PROOF');
      n.provenEpoch = ep;
      state.set('node', tx.from, n);
      return {};
    },
  },

  // ----- custom top-level domains (docs/domains.md) -----
  registerTld: {
    cost: { compute: 100000, state: 500 },
    check: (b, p) => {
      if (!tldOk(b.tld)) throw new TxInvalid('BAD_BODY', 'invalid or reserved TLD (3-24 characters, a-z 0-9, starts with a letter; real-world TLDs are reserved)');
      checkPolicy(b, p);
    },
    access: (tx) => [`acct:${tx.from}`, `tld:${tx.body.tld}`],
    run({ state, height, params }, tx) {
      const b = tx.body;
      if (state.has('tld', b.tld)) throw new TxFail('TLD_TAKEN');
      const fee = params.tld.price;
      const a = getAcct(state, tx.from);
      if (spendable(a, height) < fee) throw new TxFail('INSUFFICIENT_BALANCE');
      a.balance -= fee;
      putAcct(state, tx.from, a);
      state.set('tld', b.tld, { owner: tx.from, open: b.open, price: BigInt(b.price), ownerShareBps: b.ownerShareBps, created: height });
      return { burned: fee };
    },
  },

  setTldPolicy: {
    cost: { compute: 50000, state: 200 },
    check: (b, p) => { if (!tldOk(b.tld, true)) throw new TxInvalid('BAD_BODY', 'invalid TLD'); checkPolicy(b, p); },
    access: (tx) => [`acct:${tx.from}`, `tld:${tx.body.tld}`],
    run({ state }, tx) {
      const t = state.get('tld', tx.body.tld);
      if (!t) throw new TxFail('TLD_NOT_FOUND');
      if (t.owner !== tx.from) throw new TxFail('NOT_OWNER');
      state.set('tld', tx.body.tld, { ...t, open: tx.body.open, price: BigInt(tx.body.price), ownerShareBps: tx.body.ownerShareBps });
      return {};
    },
  },

  transferTld: {
    cost: { compute: 40000, state: 100 },
    check: (b, p) => {
      if (!tldOk(b.tld, true)) throw new TxInvalid('BAD_BODY', 'invalid TLD');
      if (!isValidAddress(b.newOwner, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid new owner');
    },
    access: (tx) => [`acct:${tx.from}`, `tld:${tx.body.tld}`],
    run({ state }, tx) {
      const t = state.get('tld', tx.body.tld);
      if (!t) throw new TxFail('TLD_NOT_FOUND');
      if (t.owner !== tx.from) throw new TxFail('NOT_OWNER');
      state.set('tld', tx.body.tld, { ...t, owner: tx.body.newOwner });
      return {};
    },
  },

  // ----- domains: "label.tld"; a bare label means ".aur" -----
  registerDomain: {
    cost: { compute: 80000, state: 400 },
    check: (b, p) => {
      const n = nameValid(b.name);
      if (!n || !nameOk(n.label, p)) throw new TxInvalid('BAD_BODY', 'invalid or disallowed name (ASCII a-z 0-9 and single hyphens; no "--"; must not look like an address)');
      if (!isInt(b.years, 1, p.domain.maxYears)) throw new TxInvalid('BAD_BODY', 'invalid term');
    },
    // a custom TLD pays its owner, so it may touch any account: serialize it
    access: (tx) => { const n = parseName(tx.body.name); return n && n.tld !== 'aur' ? ['*', `acct:${tx.from}`] : [`acct:${tx.from}`, `dom:${domKey(n)}`]; },
    run({ state, height, params }, tx) {
      const n = parseName(tx.body.name), years = tx.body.years, key = domKey(n);
      const cur = state.get('dom', key);
      const live = cur && cur.expiresAt > height;
      if (live && cur.owner !== tx.from) throw new TxFail('NAME_TAKEN');
      let price, toOwner = 0n, tldOwner = null;
      if (n.tld === 'aur') price = domainPrice(params, n.label, years);
      else {
        const t = state.get('tld', n.tld);
        if (!t) throw new TxFail('TLD_NOT_FOUND');
        if (!t.open && tx.from !== t.owner) throw new TxFail('TLD_RESTRICTED');
        price = tx.from === t.owner ? 0n : t.price * BigInt(years); // the TLD owner registers for free
        toOwner = (price * BigInt(t.ownerShareBps)) / 10000n;
        tldOwner = t.owner;
      }
      const a = getAcct(state, tx.from);
      if (spendable(a, height) < price) throw new TxFail('INSUFFICIENT_BALANCE');
      a.balance -= price;
      putAcct(state, tx.from, a);
      if (toOwner > 0n) { const o = getAcct(state, tldOwner); o.balance += toOwner; putAcct(state, tldOwner, o); }
      const startFrom = live ? cur.expiresAt : height;
      state.set('dom', key, { owner: tx.from, target: live ? cur.target : tx.from, expiresAt: startFrom + years * params.blocksPerYear });
      return { burned: price - toOwner };
    },
  },

  setDomainTarget: {
    cost: { compute: 40000, state: 100 },
    check: (b, p) => {
      if (!nameValid(b.name)) throw new TxInvalid('BAD_BODY', 'invalid name');
      if (!isValidAddress(b.target, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid target');
    },
    access: (tx) => [`acct:${tx.from}`, `dom:${domKey(parseName(tx.body.name))}`],
    run({ state, height }, tx) {
      const key = domKey(parseName(tx.body.name));
      const d = state.get('dom', key);
      if (!d || d.expiresAt <= height) throw new TxFail('NAME_NOT_FOUND');
      if (d.owner !== tx.from) throw new TxFail('NOT_OWNER');
      d.target = tx.body.target;
      state.set('dom', key, d);
      return {};
    },
  },

  transferDomain: {
    cost: { compute: 40000, state: 100 },
    check: (b, p) => {
      if (!nameValid(b.name)) throw new TxInvalid('BAD_BODY', 'invalid name');
      if (!isValidAddress(b.newOwner, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid new owner');
    },
    access: (tx) => [`acct:${tx.from}`, `dom:${domKey(parseName(tx.body.name))}`],
    run({ state, height }, tx) {
      const key = domKey(parseName(tx.body.name));
      const d = state.get('dom', key);
      if (!d || d.expiresAt <= height) throw new TxFail('NAME_NOT_FOUND');
      if (d.owner !== tx.from) throw new TxFail('NOT_OWNER');
      // A sale must not leave the seller's address or records behind: the buyer starts from a clean name.
      d.owner = tx.body.newOwner; d.target = tx.body.newOwner; delete d.records;
      state.set('dom', key, d);
      return {};
    },
  },

  // ----- universal name resolution (ANR-1): multi-chain records and verified reverse names -----
  setRecord: {
    cost: { compute: 50000, state: 300 },
    check: (b, p) => {
      if (!nameValid(b.name)) throw new TxInvalid('BAD_BODY', 'invalid name');
      if (typeof b.key !== 'string' || !RECORD_KEY_RE.test(b.key)) throw new TxInvalid('BAD_BODY', 'record key must be addr:<namespace>:<reference>, text:<key> or content');
      if (b.value !== null && (typeof b.value !== 'string' || b.value.length < 1 || b.value.length > 256 || /[\u0000-\u001f\u007f]/.test(b.value))) throw new TxInvalid('BAD_BODY', 'record value must be 1-256 printable characters, or null to delete');
      void p;
    },
    access: (tx) => [`acct:${tx.from}`, `dom:${domKey(parseName(tx.body.name))}`],
    run({ state, height }, tx) {
      const key = domKey(parseName(tx.body.name));
      const d = state.get('dom', key);
      if (!d || d.expiresAt <= height) throw new TxFail('NAME_NOT_FOUND');
      if (d.owner !== tx.from) throw new TxFail('NOT_OWNER');
      const rec = d.records || {};
      if (tx.body.value === null) delete rec[tx.body.key];
      else {
        if (!(tx.body.key in rec) && Object.keys(rec).length >= MAX_RECORDS) throw new TxFail('TOO_MANY_RECORDS');
        rec[tx.body.key] = tx.body.value;
      }
      if (Object.keys(rec).length) d.records = rec; else delete d.records;
      state.set('dom', key, d);
      return {};
    },
  },

  setPrimary: {
    cost: { compute: 40000, state: 100 },
    check: (b) => { if (b.name !== null && !nameValid(b.name)) throw new TxInvalid('BAD_BODY', 'invalid name'); },
    access: (tx) => (tx.body.name === null ? [`acct:${tx.from}`, `rev:${tx.from}`] : [`acct:${tx.from}`, `rev:${tx.from}`, `dom:${domKey(parseName(tx.body.name))}`]),
    run({ state, height }, tx) {
      if (tx.body.name === null) { state.del('rev', tx.from); return {}; }
      const n = parseName(tx.body.name);
      const d = state.get('dom', domKey(n));
      if (!d || d.expiresAt <= height) throw new TxFail('NAME_NOT_FOUND');
      // forward verification at write time: you may only claim a reverse name that resolves back to you
      if (d.owner !== tx.from || d.target !== tx.from) throw new TxFail('NAME_DOES_NOT_RESOLVE_TO_YOU');
      state.set('rev', tx.from, { name: fullName(n) });
      return {};
    },
  },

  // ----- EVM (docs/evm.md): contract creation and calls -----
  evm: {
    // Resource cost depends on the gas limit: compute = gas, state = gas/1000 units reserved. Unused gas is refunded.
    cost: (tx) => ({ compute: tx.body.gasLimit, state: Math.ceil(tx.body.gasLimit / 1000) }),
    check: (b, p) => {
      if (b.to !== null && !(typeof b.to === 'string' && /^[0-9a-f]{40}$/.test(b.to))) throw new TxInvalid('BAD_BODY', 'to must be null (create) or 40 hex characters');
      if (!isDec(b.value) || BigInt(b.value) % WEI !== 0n) throw new TxInvalid('BAD_BODY', 'value must be wei, a multiple of 1e9');
      if (typeof b.data !== 'string' || b.data.length > 262144 || !/^([0-9a-f]{2})*$/.test(b.data)) throw new TxInvalid('BAD_BODY', 'data must be lowercase hex, at most 128 KB');
      if (!isInt(b.gasLimit, 21000, p.limits.compute)) throw new TxInvalid('BAD_BODY', 'gas limit out of range');
    },
    access: (tx) => ['*', `acct:${tx.from}`], // an EVM transaction may touch any account: it serializes the block
    run(ctx, tx) {
      const { state, height, params } = ctx;
      const b = tx.body;
      const a = getAcct(state, tx.from);
      const sparks = BigInt(b.value) / WEI;
      if (sparks > 0n) { enforceLimit(a, sparks, height, params); if (spendable(a, height) < sparks) throw new TxFail('INSUFFICIENT_BALANCE'); putAcct(state, tx.from, a); }
      const out = runEvm(ctx, tx);
      if (out.invalid) throw new TxFail('INTRINSIC_GAS_TOO_LOW');
      const gl = BigInt(b.gasLimit), unused = gl - BigInt(out.gasUsed);
      const extra = {
        success: out.success, gasUsed: out.gasUsed, output: Buffer.from(out.returnData).toString('hex'), contractAddress: out.createdAddress,
        logs: (out.logs || []).map((l) => ({ address: l.address, topics: l.topics, data: Buffer.from(l.data).toString('hex') })),
      };
      return {
        discard: !out.success, code: out.success ? 'OK' : 'EVM_REVERT', extra,
        baseRefund: (ctx.fee.baseCost * unused) / gl, tipRefund: (ctx.fee.tip * unused) / gl,
      };
    },
  },

  // ----- governance (docs/governance.md) -----
  submitProposal: {
    cost: { compute: 200000, state: 1000 },
    check: (b) => {
      if (typeof b.title !== 'string' || !/^[\x20-\x7e]{1,80}$/.test(b.title)) throw new TxInvalid('BAD_BODY', 'title must be 1-80 printable ASCII characters');
      if (typeof b.description !== 'string' || b.description.length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(b.description)) throw new TxInvalid('BAD_BODY', 'description must be at most 1000 characters');
      const err = gov.validateChanges(b.changes);
      if (err) throw new TxInvalid('BAD_BODY', err);
    },
    access: (tx) => [`acct:${tx.from}`, 'global:gov'],
    run({ state, height, params }, tx) {
      const g = params.governance;
      const a = getAcct(state, tx.from);
      if (spendable(a, height) < g.deposit) throw new TxFail('INSUFFICIENT_DEPOSIT');
      const id = (state.get('meta', 'propSeq') || 0) + 1;
      state.set('meta', 'propSeq', id);
      a.balance -= g.deposit;
      putAcct(state, tx.from, a);
      state.set('prop', gov.propKey(id), {
        id, proposer: tx.from, title: tx.body.title, description: tx.body.description, changes: tx.body.changes,
        submitted: height, votingEnd: height + g.votingBlocks, status: 'voting', deposit: g.deposit,
      });
      return {};
    },
  },

  vote: {
    cost: { compute: 50000, state: 150 },
    check: (b) => {
      if (!isInt(b.id, 1, 1e9) || !gov.OPTIONS.includes(b.option)) throw new TxInvalid('BAD_BODY', 'vote needs a proposal id and one of yes, no, abstain, veto');
    },
    // shares 'global:gov' with submitProposal so a vote never races the creation of its proposal
    access: (tx) => [`acct:${tx.from}`, 'global:gov'],
    run({ state, height }, tx) {
      const p = state.get('prop', gov.propKey(tx.body.id));
      if (!p) throw new TxFail('NO_SUCH_PROPOSAL');
      if (p.status !== 'voting' || height >= p.votingEnd) throw new TxFail('VOTING_CLOSED');
      state.set('vote', `${gov.propKey(tx.body.id)}|${tx.from}`, { option: tx.body.option }); // re-voting replaces the earlier vote
      return {};
    },
  },

  // ----- native account security -----
  setSecurity: {
    cost: { compute: 60000, state: 400 },
    check: (b, p, tx) => {
      const g = b.guardians;
      if (!Array.isArray(g) || g.length > p.security.maxGuardians || new Set(g).size !== g.length) throw new TxInvalid('BAD_BODY', 'invalid guardians');
      for (const x of g) if (!isValidAddress(x, p.addressPrefix) || x === tx.from) throw new TxInvalid('BAD_BODY', 'invalid guardian');
      if (!isInt(b.threshold, g.length ? 1 : 0, g.length)) throw new TxInvalid('BAD_BODY', 'invalid threshold');
      if (!isInt(b.delayBlocks, p.security.minDelayBlocks, 1e9)) throw new TxInvalid('BAD_BODY', 'delay below protocol minimum');
      if (b.dailyLimit !== null && !isPos(b.dailyLimit)) throw new TxInvalid('BAD_BODY', 'invalid daily limit');
    },
    access: (tx) => [`acct:${tx.from}`],
    run({ state, height }, tx) {
      const a = getAcct(state, tx.from);
      const b = tx.body;
      const cfg = { guardians: sortedUnique(b.guardians), threshold: b.threshold, delayBlocks: b.delayBlocks, dailyLimit: b.dailyLimit === null ? null : BigInt(b.dailyLimit) };
      if (!a.security) {
        a.security = { ...cfg, window: 0, spent: 0n, pending: null, recovery: null };
      } else {
        settleSecurity(a, height);
        const cur = a.security;
        const limitTighter = cfg.dailyLimit !== null && (cur.dailyLimit === null || cfg.dailyLimit <= cur.dailyLimit);
        const tighter = canon(cfg.guardians) === canon(cur.guardians) && cfg.threshold >= cur.threshold
          && cfg.delayBlocks >= cur.delayBlocks && limitTighter;
        if (tighter) Object.assign(cur, cfg);
        else cur.pending = { config: cfg, readyAt: height + cur.delayBlocks }; // loosening is timelocked
      }
      putAcct(state, tx.from, a);
      return {};
    },
  },

  securityCancel: {
    cost: { compute: 40000, state: 100 },
    check: (b, p) => { if (!isValidAddress(b.account, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid account'); },
    access: (tx) => [`acct:${tx.from}`, `acct:${tx.body.account}`],
    run({ state }, tx) {
      const a = getAcct(state, tx.body.account);
      if (!a.security) throw new TxFail('NO_SECURITY_CONFIG');
      if (tx.from !== tx.body.account && !a.security.guardians.includes(tx.from)) throw new TxFail('NOT_GUARDIAN');
      a.security.pending = null;
      putAcct(state, tx.body.account, a);
      return {};
    },
  },

  recoveryApprove: {
    cost: { compute: 50000, state: 200 },
    check: (b, p) => {
      if (!isValidAddress(b.account, p.addressPrefix)) throw new TxInvalid('BAD_BODY', 'invalid account');
      if (![undefined, 0, 2].includes(b.newScheme) || !pubOk(b.newScheme ?? 0, b.newPub)) throw new TxInvalid('BAD_BODY', 'invalid key');
    },
    access: (tx) => [`acct:${tx.from}`, `acct:${tx.body.account}`, `rec:${tx.body.account}`],
    run({ state, height }, tx) {
      const a = getAcct(state, tx.body.account);
      settleSecurity(a, height);
      const sec = a.security;
      if (!sec || !sec.guardians.includes(tx.from)) throw new TxFail('NOT_GUARDIAN');
      const newScheme = tx.body.newScheme ?? 0;
      if (!sec.recovery || sec.recovery.newPub !== tx.body.newPub || (sec.recovery.newScheme ?? 0) !== newScheme) sec.recovery = { newPub: tx.body.newPub, newScheme, approvals: [], readyAt: null };
      if (!sec.recovery.approvals.includes(tx.from)) sec.recovery.approvals.push(tx.from);
      if (sec.recovery.approvals.length >= sec.threshold && sec.recovery.readyAt === null) {
        sec.recovery.readyAt = height + sec.delayBlocks;
        state.set('rec', tx.body.account, { readyAt: sec.recovery.readyAt });
      }
      putAcct(state, tx.body.account, a);
      return {};
    },
  },

  recoveryCancel: {
    cost: { compute: 40000, state: 100 },
    check: () => {},
    access: (tx) => [`acct:${tx.from}`, `rec:${tx.from}`],
    run({ state }, tx) {
      const a = getAcct(state, tx.from);
      if (!a.security || !a.security.recovery) throw new TxFail('NO_PENDING_RECOVERY');
      a.security.recovery = null;
      state.del('rec', tx.from);
      putAcct(state, tx.from, a);
      return {};
    },
  },
};

/** Stateless validation: shape, address prefix, signature. Throws TxInvalid. */
const sigOk = new Set();
function checkTx(tx, params, chainId) {
  if (!tx || typeof tx !== 'object') throw new TxInvalid('BAD_TX', 'not an object');
  if (tx.v !== TX_VERSION) throw new TxInvalid('BAD_VERSION');
  if (tx.chainId !== chainId) throw new TxInvalid('WRONG_CHAIN', `tx is for ${tx.chainId}, node is ${chainId}`);
  const spec = TYPES[tx.type];
  if (!spec) throw new TxInvalid('UNKNOWN_TYPE');
  if (!isValidAddress(tx.from, params.addressPrefix)) throw new TxInvalid('BAD_FROM');
  if (![undefined, 0, 2, 4].includes(tx.scheme)) throw new TxInvalid('BAD_SCHEME');
  if (tx.scheme === 4 && tx.type !== 'evm') throw new TxInvalid('BAD_SCHEME', 'Ethereum-key transactions can only be EVM transactions');
  if (!pubOk(tx.scheme ?? 0, tx.pub)) throw new TxInvalid('BAD_PUB');
  if (!isInt(tx.nonce, 0, Number.MAX_SAFE_INTEGER)) throw new TxInvalid('BAD_NONCE');
  if (!isDec(tx.maxFee) || !isDec(tx.tip)) throw new TxInvalid('BAD_FEE');
  if (!tx.body || typeof tx.body !== 'object') throw new TxInvalid('BAD_BODY');
  spec.check(tx.body, params, tx);
  const id = txHash(tx);
  if (!sigOk.has(id)) {
    let good;
    if (tx.scheme === 4) { // the raw Ethereum transaction IS the signature: recompute the envelope from it and demand an exact match
      try { good = tx.sig && canon(envelopeFromRaw(tx.sig.raw, params, chainId)) === canon(tx); } catch (e) { if (e instanceof TxInvalid) throw e; good = false; }
    } else good = (tx.scheme ?? 0) === 2 ? verifyWebAuthn(tx.pub, signingBytes(tx), tx.sig) : verify(tx.pub, signingBytes(tx), tx.sig);
    if (!good) throw new TxInvalid('BAD_SIGNATURE');
    if (sigOk.size > 50000) sigOk.clear();
    sigOk.add(id);
  }
  return id;
}

/** Resource units a transaction reserves (static per type, or a function of the tx for EVM calls). */
const txCost = (tx) => { const c = TYPES[tx.type].cost; return typeof c === 'function' ? c(tx) : c; };
const costOfTx = (tx, baseFee) => { const c = txCost(tx); return BigInt(c.compute) * baseFee.compute + BigInt(c.state) * baseFee.state; };
/** Static-cost quote by type (EVM shows its minimum: a plain 21,000-gas call). */
const costOf = (type, baseFee) => {
  const c = typeof TYPES[type].cost === 'function' ? { compute: 21000, state: 21 } : TYPES[type].cost;
  return BigInt(c.compute) * baseFee.compute + BigInt(c.state) * baseFee.state;
};

/**
 * Execute one transaction against env.state. Pre-checks throw TxInvalid (the block containing the
 * tx would be invalid). Handler failures are recorded in the receipt: the fee is still charged.
 */
function applyTx(env, tx) {
  const { state, params, height, baseFee } = env;
  const spec = TYPES[tx.type];
  const a = getAcct(state, tx.from);
  if (!isAuthorized(a, tx, params.addressPrefix)) throw new TxInvalid('NOT_AUTHORIZED');
  if (tx.nonce !== a.nonce) throw new TxInvalid('BAD_NONCE', `expected nonce ${a.nonce}, got ${tx.nonce}`);
  const baseCost = costOfTx(tx, baseFee);
  const maxFee = BigInt(tx.maxFee);
  if (maxFee < baseCost) throw new TxInvalid('FEE_TOO_LOW', `maxFee ${maxFee} < required ${baseCost}`);
  const tip = minB(BigInt(tx.tip), maxFee - baseCost);
  if (spendable(a, height) < baseCost + tip) throw new TxInvalid('INSUFFICIENT_FEE_FUNDS');
  a.balance -= baseCost + tip;
  a.nonce += 1;
  putAcct(state, tx.from, a);

  const child = state.fork();
  let status = 1, code = 'OK', burned = 0n, baseRefund = 0n, tipRefund = 0n, extra;
  try {
    const res = spec.run({ state: child, params, height, baseFee, proposer: env.proposer, time: env.time, blockHashAt: env.blockHashAt, blockAt: env.blockAt, fee: { baseCost, tip } }, tx) || {};
    burned = res.burned || 0n;
    extra = res.extra;
    if (res.discard) { status = 0; code = res.code; } else child.commit();
    baseRefund = res.baseRefund || 0n; tipRefund = res.tipRefund || 0n;
  } catch (e) {
    if (e instanceof TxInvalid) throw e;
    status = 0; code = e instanceof TxFail ? e.code : 'INTERNAL_ERROR';
  }
  if (baseRefund + tipRefund > 0n) { // unused EVM gas goes back to the sender
    const s2 = getAcct(state, tx.from);
    s2.balance += baseRefund + tipRefund;
    putAcct(state, tx.from, s2);
  }
  return { status, code, baseCost: baseCost - baseRefund, tip: tip - tipRefund, burned, extra };
}

const accessSet = (tx) => TYPES[tx.type].access(tx);

const clearSigCache = () => sigOk.clear();

module.exports = {
  clearSigCache, isAuthorized, TX_VERSION, TYPES, signTx, signingBytes, txHash, checkTx, applyTx, costOf, costOfTx, txCost, accessSet,
  getAcct, putAcct, spendable, delKey, settleSecurity,
};

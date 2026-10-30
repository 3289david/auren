'use strict';
// Namespaced key/value state with copy-on-write forks and an incremental merkle root.
// Namespaces: acct, val, del, unb, dom, rec, meta.
const { canon, sha256, merkleRoot } = require('./util');

const TOMB = Symbol('tombstone');

class State {
  constructor(parent = null) {
    this.parent = parent;
    this.layers = new Map(); // ns -> Map(key -> value | TOMB)
    if (!parent) this.leaf = new Map(); // ns\0key -> {obj, hash}
  }

  fork() { return new State(this); }
  _base() { let s = this; while (s.parent) s = s.parent; return s; }
  _layer(ns) {
    let l = this.layers.get(ns);
    if (!l) { l = new Map(); this.layers.set(ns, l); }
    return l;
  }
  _raw(ns, key) {
    for (let s = this; s; s = s.parent) {
      const l = s.layers.get(ns);
      if (l && l.has(key)) return l.get(key);
    }
    return undefined;
  }

  get(ns, key) {
    const v = this._raw(ns, key);
    return v === undefined || v === TOMB ? undefined : structuredClone(v);
  }
  has(ns, key) {
    const v = this._raw(ns, key);
    return v !== undefined && v !== TOMB;
  }
  set(ns, key, val) { this._layer(ns).set(key, structuredClone(val)); }
  del(ns, key) {
    if (this.parent) this._layer(ns).set(key, TOMB);
    else this._layer(ns).delete(key);
  }

  _merged(ns) {
    const chain = [];
    for (let s = this; s; s = s.parent) chain.unshift(s);
    const m = new Map();
    for (const s of chain) {
      const l = s.layers.get(ns);
      if (!l) continue;
      for (const [k, v] of l) { if (v === TOMB) m.delete(k); else m.set(k, v); }
    }
    return m;
  }

  /** Sorted [key, value] pairs (values are cloned). */
  entries(ns) {
    const m = this._merged(ns);
    return [...m.keys()].sort().map((k) => [k, structuredClone(m.get(k))]);
  }

  /** Merge this fork's writes into its parent. */
  commit() {
    if (!this.parent) throw new Error('cannot commit base state');
    for (const [ns, l] of this.layers) {
      const pl = this.parent._layer(ns);
      for (const [k, v] of l) {
        if (!this.parent.parent && v === TOMB) pl.delete(k);
        else pl.set(k, v);
      }
    }
    this.layers.clear();
  }

  /** What this fork changed relative to its parent: [{ns, key, before, after}] */
  diff() {
    const out = [];
    for (const [ns, l] of this.layers) {
      for (const [k, v] of l) {
        out.push({ ns, key: k, before: this.parent ? this.parent.get(ns, k) : undefined, after: v === TOMB ? undefined : structuredClone(v) });
      }
    }
    return out;
  }

  /** All leaves in canonical order: [{ns, key, hash}]. Leaf hashes are cached by object identity. */
  _leafList() {
    const base = this._base();
    const names = new Set();
    for (let s = this; s; s = s.parent) for (const ns of s.layers.keys()) names.add(ns);
    const leaves = [];
    for (const ns of [...names].sort()) {
      const m = this._merged(ns);
      for (const k of [...m.keys()].sort()) {
        const v = m.get(k);
        const ck = ns + '\0' + k;
        const c = base.leaf.get(ck);
        let h;
        if (c && c.obj === v) h = c.hash;
        else { h = sha256(canon([ns, k, v])); base.leaf.set(ck, { obj: v, hash: h }); }
        leaves.push({ ns, key: k, hash: h });
      }
    }
    return leaves;
  }

  /** Merkle root over all (ns, key, value) leaves in sorted order. */
  root() { return merkleRoot(this._leafList().map((l) => l.hash)); }

  /**
   * Merkle inclusion proof for one entry: { index, steps: [{ hash, pos }] } where pos says on which side the
   * sibling sits. Verifiable against root() with verifyMerkleProof(); the verifier recomputes the leaf from the value.
   */
  prove(ns, key) {
    const list = this._leafList();
    let i = list.findIndex((l) => l.ns === ns && l.key === key);
    if (i < 0) return null;
    let level = list.map((l) => l.hash);
    const index = i, steps = [];
    while (level.length > 1) {
      if (i % 2 === 0) { if (i + 1 < level.length) steps.push({ hash: level[i + 1].toString('hex'), pos: 'R' }); }
      else steps.push({ hash: level[i - 1].toString('hex'), pos: 'L' });
      const next = [];
      for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? sha256(Buffer.concat([level[j], level[j + 1]])) : level[j]);
      level = next; i = Math.floor(i / 2);
    }
    return { index, steps };
  }
}

module.exports = { State };

'use strict';
// A full node / validator: block log, mempool, two-phase BFT (src/bft.js), HTTP gossip + sync, JSON-RPC + REST.
//
// Consensus is Tendermint-style: propose -> prevote -> precommit with locks and proof-of-lock. All
// consensus messages are signed; every vote we sign is persisted (fsync) before it is sent. Messages are
// pushed to peers (POST /p2p/msg) and repaired by pull (GET /p2p/round-state) when a round stalls.
// See docs/consensus.md for the guarantees and the remaining limitations.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { canon, sha256hex, TxInvalid, BlockInvalid } = require('./util');
const { Keypair } = require('./crypto');
const { Chain, jsonify } = require('./chain');
const { Mempool } = require('./mempool');
const { BlockStore } = require('./store');
const { quote } = require('./fees');
const { txHash, spendable } = require('./tx');
const C = require('./consensus');
const { BftEngine } = require('./bft');
const { ethMethods } = require('./evm/rpc');
const { hexOf, ChainBackend } = require('./evm/host');
const { nameValid, fullName } = require('./tld');

const VERSION = '0.6.3';
const MAX_BODY = 8 * 1024 * 1024;

class AurenNode extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.home        data directory
   * @param {object} o.genesis     genesis document
   * @param {object} o.config      { moniker, rpcHost, rpcPort, peers[], selfUrl, operator, quiet }
   * @param {Keypair|null} o.consensusKey  validator consensus key (null for a plain full node)
   */
  constructor({ home, genesis, config = {}, consensusKey = null }) {
    super();
    this.home = home;
    this.config = { moniker: 'node', rpcHost: '127.0.0.1', rpcPort: 9650, peers: [], selfUrl: null, operator: null, quiet: false, ...config };
    this.key = consensusKey;
    this.operator = this.config.operator;
    this.chain = new Chain(genesis);
    this.mempool = new Mempool(this.chain);
    if (this.config.earn) { const { Earner } = require('./earner'); this.earner = new Earner(this, this.config.payout || null); }
    this.store = new BlockStore(path.join(home, 'data', 'blocks.jsonl'));
    this.receipts = new Map();
    this.peers = new Map(); // url -> { height, fails }
    for (const p of this.config.peers) this._addPeer(p);
    this.seenTx = new Set();
    this.addrIndex = new Map();
    this.ethHashes = new Map(); // keccak(raw Ethereum tx) -> native tx hash
    this.pendingEvidence = new Map(); // validator -> evidence
    this.rate = new Map();
    this.syncing = false;
    this.running = false;
    this.lastCommitAt = Date.now();
    this.pvFile = path.join(home, 'data', 'priv_validator_state.json');
    this.pvSnap = null;
    try {
      const s = fs.existsSync(this.pvFile) ? JSON.parse(fs.readFileSync(this.pvFile, 'utf8')) : null;
      if (s && Array.isArray(s.signed)) this.pvSnap = s; // ignore state files from the old single-phase protocol
    } catch { this.pvSnap = null; }
    this.engine = this.key && this.operator ? this._makeEngine() : null;
  }

  log(msg) { if (!this.config.quiet) console.log(`${new Date().toISOString()} [${this.config.moniker}] ${msg}`); }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    let n = 0;
    for (const { block, commit } of this.store.load()) {
      const res = this.chain.applyBlock(block, commit);
      this._indexReceipts(block, res);
      n++;
    }
    if (n) this.log(`replayed ${n} blocks, height ${this.chain.height}`);
    this.mempool.prune();
    const handler = (req, res) => { this._handle(req, res).catch((e) => this._send(res, 500, { error: e.message })); };
    this.server = http.createServer(handler);
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.rpcPort, this.config.rpcHost, resolve);
    });
    // Optional HTTPS listener for the website, wallet and RPC. Browsers only enable wallet cryptography on secure pages.
    const tls = this.config.tls;
    if (tls && tls.cert && tls.key) {
      this.httpsServer = require('node:https').createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, handler);
      await new Promise((resolve, reject) => { this.httpsServer.once('error', reject); this.httpsServer.listen(tls.port || 443, this.config.rpcHost, resolve); });
      this.log(`HTTPS on port ${tls.port || 443}`);
    }
    this.port = this.server.address().port;
    if (!this.config.selfUrl) this.config.selfUrl = `http://${this.config.rpcHost}:${this.port}`;
    this.running = true;
    this.syncTimer = setInterval(() => this._syncOnce().catch(() => {}), 1000);
    this.repairTimer = setInterval(() => this._repair().catch(() => {}), 500);
    this._scheduleHeight(Math.max(0, this.config.startDelayMs ?? 300));
    this.log(`listening on ${this.config.selfUrl}, chain ${this.chain.chainId}${this.key ? ', validator ' + this.operator : ''}`);
    for (const p of this.peers.keys()) this._post(p, '/p2p/hello', { url: this.config.selfUrl }, 1500).catch(() => {});
    return this;
  }

  async stop() {
    this.running = false;
    clearInterval(this.syncTimer);
    clearInterval(this.repairTimer);
    clearTimeout(this.heightTimer);
    if (this.engine) this.engine.stop();
    await new Promise((r) => { this.server.close(r); this.server.closeAllConnections?.(); });
    if (this.httpsServer) await new Promise((r) => { this.httpsServer.close(r); this.httpsServer.closeAllConnections?.(); });
    this.store.close();
  }

  // ------------------------------------------------------------------ peers
  _addPeer(url) {
    if (!url || url === this.config.selfUrl || this.peers.has(url) || this.peers.size >= 100) return;
    if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(url)) return;
    this.peers.set(url, { height: 0, fails: 0 });
  }
  peerUrls() { return [...this.peers.keys()]; }

  async _post(url, p, body, timeout = 2500) {
    const r = await fetch(url + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    return r.json();
  }
  async _get(url, p, timeout = 2500) {
    const r = await fetch(url + p, { signal: AbortSignal.timeout(timeout) });
    return r.json();
  }
  _broadcast(p, body) { for (const url of this.peerUrls()) this._post(url, p, body, 3000).catch(() => {}); }

  // ------------------------------------------------------------------ chain events
  _indexReceipts(block, res) {
    for (const r of res.receipts) this.receipts.set(r.hash, { ...r, height: block.header.height });
    if (this.receipts.size > 200000) this.receipts.clear();
    // address -> transactions that involve it (sender or any address named in the body)
    const touch = (addr, hash, height) => {
      let l = this.addrIndex.get(addr);
      if (!l) { l = []; this.addrIndex.set(addr, l); }
      if (!l.length || l[l.length - 1].hash !== hash) l.push({ hash, height });
    };
    block.txs.forEach((tx) => {
      const h = txHash(tx);
      if (tx.scheme === 4) this.ethHashes.set('0x' + require('./evm/keccak').keccak256(Buffer.from(tx.sig.raw.replace(/^0x/, ''), 'hex')).toString('hex'), h);
      touch(tx.from, h, block.header.height);
      for (const k of ['to', 'validator', 'newOwner', 'target', 'account']) if (typeof tx.body[k] === 'string' && tx.body[k] !== tx.from) touch(tx.body[k], h, block.header.height);
    });
  }

  accountTxs(addr, limit = 25, before = Infinity) {
    const l = (this.addrIndex.get(addr) || []).filter((x) => x.height < before);
    return l.slice(-limit).reverse().map(({ hash, height }) => {
      const idx = this.chain.txIndex.get(hash);
      const tx = this.chain.getBlock(height).txs[idx.index];
      const r = this.receipts.get(hash);
      return { hash, height, time: this.chain.getBlock(height).header.time, type: tx.type, from: tx.from, body: tx.body, status: r ? r.status : null, code: r ? r.code : null, fee: r ? r.fee : null };
    });
  }

  _afterBlock(block, res) {
    this._indexReceipts(block, res);
    this.mempool.prune();
    this.lastCommitAt = Date.now();
    for (const [op, ev] of this.pendingEvidence) {
      const v = this.chain.state.get('val', op);
      if (!v || v.tombstoned || ev.height < this.chain.height - this.chain.params.unbondingBlocks) this.pendingEvidence.delete(op);
    }
    this.emit('block', block);
    if (this.earner) { try { this.earner.tick(); } catch (e) { this.log(`node rewards: ${e.message}`); } }
    this._scheduleHeight();
    this.log(`block ${block.header.height} ${block.hash.slice(0, 10)} txs=${block.header.txCount} proposer=${block.header.proposer.slice(0, 12)}… lanes=${res.lanes} baseFee=${this.chain.baseFee.compute}`);
  }

  _commitBlock(block, commit) {
    const res = this.chain.applyBlock(block, commit);
    this.store.append(block, commit);
    this._afterBlock(block, res);
    return res;
  }

  // ------------------------------------------------------------------ consensus (two-phase BFT engine, src/bft.js)
  _isActiveValidator() {
    return !!this.key && this.chain.activeSet.some((v) => v.operator === this.operator);
  }

  _persistPv(snap) {
    // durable BEFORE any vote leaves the process: an fsync'd write of locks and every vote we signed this height
    const tmp = this.pvFile + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(snap)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.pvFile);
    this.pvSnap = snap;
  }

  _makeEngine() {
    const chain = this.chain, cid = chain.chainId, p = chain.params;
    return new BftEngine({
      self: this.operator,
      valset: () => chain.activeSet,
      proposerFor: (h, r) => chain.proposerFor(r, h),
      validate: (b) => { chain.validateBlock(b, { now: Date.now() }); return true; },
      build: (h, r) => chain.buildBlock({
        operator: this.operator, signKey: this.key, round: r, time: Date.now(),
        candidates: this.mempool.candidates(), evidence: [...this.pendingEvidence.values()],
      }).block,
      signVote: (type, h, r, hash) => C.signVote(this.key, cid, this.operator, h, r, hash, type),
      signProposal: (pr) => C.signProposal(this.key, cid, pr),
      broadcast: (msg) => this._broadcast('/p2p/msg', msg),
      persist: (snap) => this._persistPv(snap),
      onCommit: (block, commit) => this._engineCommit(block, commit),
      onEvidence: (ev) => {
        if (!this.pendingEvidence.has(ev.validator)) { this.pendingEvidence.set(ev.validator, ev); this.log(`EQUIVOCATION observed from ${ev.validator} (${ev.type}, height ${ev.height}, round ${ev.round})`); }
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
      timeouts: { proposeMs: p.roundTimeoutMs, voteMs: Math.max(300, Math.floor(p.roundTimeoutMs / 2)), deltaMs: 500 },
      verify: { vote: (pub, v) => C.verifyVote(cid, pub, v), proposal: (pub, pr) => C.verifyProposal(cid, pub, pr) },
    });
  }

  _engineCommit(block, commit) {
    try {
      this._commitBlock(block, commit);
    } catch (e) {
      this.log(`commit failed: ${e.message}`);
      this._scheduleHeight();
      return;
    }
    this._broadcast('/p2p/commit', { block, commit });
  }

  /** (Re)start consensus for the next height, one block interval after the last commit. */
  _scheduleHeight(delay = this.chain.params.blockTimeMs) {
    clearTimeout(this.heightTimer);
    if (this.engine) this.engine.stop();
    if (!this.running || !this.engine) return;
    this.heightTimer = setTimeout(() => {
      if (!this.running || this.behind || !this._isActiveValidator()) {
        if (this.running) this._scheduleHeight(1000); // not active, or a peer is ahead and we are catching up: look again shortly
        return;
      }
      this.engine.startHeight(this.chain.height + 1, this.pvSnap);
    }, delay);
  }

  /** Pull-based repair: fetch the round state of peers when we have been stuck for a while. */
  async _repair() {
    const e = this.engine;
    if (!e || !e.isRunning || Date.now() - this.lastCommitAt < this.chain.params.blockTimeMs + 800) return;
    const h = e.height;
    await Promise.all(this.peerUrls().map(async (url) => {
      try {
        const rs = await this._get(url, `/p2p/round-state?height=${h}`, 1500);
        if (rs.height !== h || !this.running || !e.isRunning || e.height !== h) return;
        for (const m of [...(rs.proposals || []), ...(rs.prevotes || []), ...(rs.precommits || [])].slice(0, 2000)) e.receive(m);
      } catch { /* peer unreachable */ }
    }));
  }

  // ------------------------------------------------------------------ p2p handlers
  onMsg(msg) {
    if (this.engine) this.engine.receive(msg);
    return { ok: true };
  }

  onCommit({ block, commit }) {
    const h = block?.header?.height;
    if (h === this.chain.height + 1) {
      try { this._commitBlock(block, commit); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
    }
    if (h > this.chain.height + 1) this._syncOnce().catch(() => {});
    return { ok: false, reason: 'not next' };
  }

  async onTx(tx, { gossip = true } = {}) {
    const { hash, isNew } = this.mempool.add(tx);
    if (isNew && gossip && !this.seenTx.has(hash)) {
      this.seenTx.add(hash);
      if (this.seenTx.size > 100000) this.seenTx.clear();
      this._broadcast('/p2p/tx', { tx });
    }
    return { hash, isNew };
  }

  async _syncOnce() {
    if (this.syncing || !this.running) return;
    this.syncing = true;
    try {
      const infos = await Promise.all(this.peerUrls().map(async (url) => {
        try {
          const info = await this._get(url, '/p2p/info', 1500);
          if (info.chainId !== this.chain.chainId || info.genesisHash !== this.chain.genesisHash) { this.peers.delete(url); return null; }
          for (const p of info.peers || []) this._addPeer(p);
          this.peers.get(url).height = info.height;
          return { url, height: info.height };
        } catch { const p = this.peers.get(url); if (p && ++p.fails > 30) this.peers.delete(url); return null; }
      }));
      const best = infos.filter(Boolean).sort((a, b) => b.height - a.height)[0];
      this.behind = !!best && best.height > this.chain.height + 1; // one block ahead is normal jitter, not "behind"
      while (best && best.height > this.chain.height && this.running) {
        const from = this.chain.height + 1;
        const batch = await this._get(best.url, `/p2p/blocks?from=${from}&limit=50`, 5000);
        if (!batch.length) break;
        for (const { block, commit } of batch) {
          if (block.header.height !== this.chain.height + 1) continue;
          this._commitBlock(block, commit);
        }
        if (this.chain.height < from) break;
      }
      this.behind = !!best && best.height > this.chain.height + 1;
    } catch (e) {
      this.log(`sync error: ${e.message}`);
    } finally {
      this.syncing = false;
    }
  }

  // ------------------------------------------------------------------ queries
  concentration() {
    const set = this.chain.activeSet;
    return { activeValidators: set.length, halt33: C.nakamoto(set, 1n, 3n), control67: C.nakamoto(set, 2n, 3n) };
  }

  status() {
    const c = this.chain, tip = c.tip;
    return {
      chainId: c.chainId, network: c.genesis.network, moniker: this.config.moniker, version: VERSION,
      symbol: c.params.symbol, decimals: c.params.decimals, addressPrefix: c.params.addressPrefix,
      genesisHash: c.genesisHash, height: c.height, latestBlockHash: tip ? tip.hash : c.genesisHash,
      latestBlockTime: tip ? tip.header.time : c.genesis.genesisTime,
      catchingUp: this.syncing, peers: this.peers.size, mempool: this.mempool.size,
      baseFee: { compute: c.baseFee.compute.toString(), state: c.baseFee.state.toString() },
      transferFee: quote(c.baseFee).transfer.baseFee,
      supply: c.supply.toString(), burned: c.burned.toString(), bonded: c.bondedTokens().toString(),
      issuanceRatePpm: c.tipRateInfo().ratePpm, concentration: this.concentration(),
      validator: this.key ? { operator: this.operator, active: this._isActiveValidator() } : null,
      consensus: this.engine ? { height: this.engine.height, round: this.engine.round, step: this.engine.step, running: this.engine.isRunning } : null,
    };
  }

  account(addr) {
    const c = this.chain;
    if (/^0x[0-9a-f]{40}$/i.test(addr)) addr = new ChainBackend(c.state, c.params).acctKey(addr.slice(2).toLowerCase()); // an Ethereum-style address
    let evm = null;
    try {
      const hex = hexOf(addr, c.params.addressPrefix);
      const code = c.state.get('ecode', hex);
      evm = { address: '0x' + hex, isContract: !!code, codeSize: code ? code.length / 2 : 0, code: code ? '0x' + code : null };
    } catch { /* not a valid address for this network */ }
    return { ...c.getAccount(addr), pendingNonce: this.mempool.pendingNonce(addr), delegations: c.getDelegations(addr), unbonding: c.getUnbonding(addr), evm };
  }

  /** Newest transactions across blocks (whole blocks at a time). `before` is an exclusive block-height cursor. */
  recentTxs(limit = 25, before = Infinity) {
    const out = [];
    let h = Math.min(this.chain.height, before - 1);
    for (; h > 0 && out.length < limit; h--) {
      const b = this.chain.getBlock(h);
      b.txs.forEach((tx, i) => {
        const hash = txHash(tx), r = this.receipts.get(hash);
        out.push({ hash, height: h, index: i, time: b.header.time, type: tx.type, from: tx.from, body: tx.body, status: r ? r.status : null, code: r ? r.code : null, fee: r ? r.fee : null, gasUsed: r && r.evm ? r.evm.gasUsed : null });
      });
    }
    return { txs: out, next: h > 0 ? h + 1 : null };
  }

  /** Accounts ranked by balance, with totals (an Etherscan-style "top accounts" list). */
  richList(limit = 50) {
    const rows = this.chain.state.entries('acct').map(([addr, a]) => ({ addr, balance: a.balance, nonce: a.nonce }));
    rows.sort((x, y) => (x.balance > y.balance ? -1 : x.balance < y.balance ? 1 : 0));
    const supply = this.chain.supply;
    return { count: rows.length, supply: supply.toString(), accounts: rows.slice(0, limit).map((r, i) => ({ rank: i + 1, address: r.addr, balance: r.balance.toString(), nonce: r.nonce, sharePpm: Number((r.balance * 1000000n) / (supply || 1n)) })) };
  }

  getTx(hash) {
    const idx = this.chain.txIndex.get(hash);
    if (idx) {
      const block = this.chain.getBlock(idx.height);
      return { status: 'confirmed', height: idx.height, tx: block.txs[idx.index], receipt: this.receipts.get(hash) || null };
    }
    if (this.mempool.has(hash)) return { status: 'pending', tx: this.mempool.byHash.get(hash) };
    return null;
  }

  resolveDomain(name) {
    const n = nameValid(String(name).toLowerCase());
    const d = n && this.chain.getDomain(fullName(n));
    return d ? { name: fullName(n), namespace: this.chain.chainId, reverse: this.chain.reverse(d.target) === fullName(n), ...d } : null;
  }

  get rpcMethods() {
    const c = this.chain;
    return {
      aur_status: () => this.status(),
      aur_getParams: () => jsonify({ ...c.params, issuanceRatePpm: c.tipRateInfo().ratePpm }),
      aur_getBlock: ([h]) => {
        const height = h === 'latest' || h === undefined ? c.height : Number(h);
        const block = c.getBlock(height);
        return block ? { ...block, commit: c.commits.get(height) } : null;
      },
      aur_getTx: ([hash]) => this.getTx(hash),
      aur_getAccount: ([addr]) => this.account(addr),
      aur_getValidators: () => ({ validators: c.getValidators(), concentration: this.concentration() }),
      aur_feeQuote: () => ({ baseFee: { compute: c.baseFee.compute.toString(), state: c.baseFee.state.toString() }, quote: quote(c.baseFee) }),
      aur_sendTx: async ([tx]) => this.onTx(tx),
      aur_simulate: ([tx]) => c.simulate(tx),
      aur_resolveDomain: ([name]) => this.resolveDomain(name),
      // verifiable resolution: record + validator set + commit certificate, all with Merkle proofs (docs/name-resolution.md)
      aur_resolve: ([name]) => c.resolveWithProof(String(name).toLowerCase()),
      aur_getTlds: () => c.listTlds(),
      aur_getNodes: (p) => c.getNodeInfo(p && p[0]),
      aur_getTld: ([t]) => c.getTld(String(t).toLowerCase().replace(/^\./, '')),
      aur_reverse: ([addr]) => c.reverse(addr),
      aur_getGenesis: () => c.genesis,
      aur_getPeers: () => this.peerUrls(),
      ...ethMethods(this), // eth_*, net_*, web3_*: Ethereum-compatible JSON-RPC (docs/evm.md)
      aur_getProposals: () => ({ proposals: c.getProposals(), governance: jsonify(c.params.governance), govParams: Object.keys(require('./gov').GOV_PARAMS) }),
      aur_getAccountTxs: ([addr, limit]) => this.accountTxs(addr, Math.min(Number(limit || 25), 100)),
    };
  }

  metrics() {
    const s = this.status();
    const lines = [
      ['auren_block_height', s.height], ['auren_peers', s.peers], ['auren_mempool_size', s.mempool],
      ['auren_base_fee_compute', s.baseFee.compute], ['auren_base_fee_state', s.baseFee.state],
      ['auren_supply_sparks', s.supply], ['auren_burned_sparks', s.burned], ['auren_bonded_sparks', s.bonded],
      ['auren_active_validators', s.concentration.activeValidators], ['auren_nakamoto_halt33', s.concentration.halt33],
      ['auren_nakamoto_control67', s.concentration.control67], ['auren_catching_up', s.catchingUp ? 1 : 0],
    ];
    return lines.map(([k, v]) => `# TYPE ${k} gauge\n${k} ${v}`).join('\n') + '\n';
  }

  // ------------------------------------------------------------------ http
  _send(res, code, body, type = 'application/json') {
    res.writeHead(code, {
      'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store',
    });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  _limited(req) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let b = this.rate.get(ip);
    if (!b || now > b.reset) { b = { n: 0, reset: now + 10000 }; this.rate.set(ip, b); }
    if (this.rate.size > 10000) this.rate.clear();
    return ++b.n > (this.config.rateLimit || 600);
  }

  async _body(req) {
    let size = 0;
    const chunks = [];
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX_BODY) throw new Error('body too large');
      chunks.push(ch);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  async _handle(req, res) {
    if (req.method === 'OPTIONS') return this._send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const isP2p = p.startsWith('/p2p/');
    if (!isP2p && this._limited(req)) return this._send(res, 429, { error: 'rate limited' });

    try {
      if (req.method === 'GET') {
        if (p === '/status' || p === '/health') return this._send(res, 200, this.status());
        if (p === '/metrics') return this._send(res, 200, this.metrics(), 'text/plain; version=0.0.4');
        if (p === '/validators') return this._send(res, 200, this.rpcMethods.aur_getValidators());
        if (p === '/fees') return this._send(res, 200, this.rpcMethods.aur_feeQuote());
        if (p === '/params') return this._send(res, 200, this.rpcMethods.aur_getParams());
        if (p === '/txs') return this._send(res, 200, this.recentTxs(Math.min(Number(url.searchParams.get('limit') || 25), 100), Number(url.searchParams.get('before') || Infinity)));
        if (p === '/richlist') return this._send(res, 200, this.richList(Math.min(Number(url.searchParams.get('limit') || 50), 200)));
        if (p === '/nodes') return this._send(res, 200, this.chain.getNodeInfo());
        if (p === '/tlds') return this._send(res, 200, this.chain.listTlds());
        const tm = /^\/tld\/\.?([a-z0-9]+)$/.exec(p);
        if (tm) { const t = tm[1] === 'aur' ? this.chain.listTlds()[0] : this.chain.getTld(tm[1]); return t ? this._send(res, 200, t) : this._send(res, 404, { error: 'no such TLD' }); }
        if (p === '/proposals') return this._send(res, 200, this.rpcMethods.aur_getProposals());
        if (p === '/genesis') return this._send(res, 200, this.chain.genesis);
        if (p === '/networks.json' && this.config.webRoot) {
          try { return this._send(res, 200, JSON.parse(fs.readFileSync(path.join(this.config.webRoot, '..', 'networks', 'networks.json'), 'utf8'))); } catch { return this._send(res, 404, { error: 'not found' }); }
        }
        let rm;
        if ((rm = /^\/resolve\/([\w.-]+)$/.exec(p))) { const r = this.rpcMethods.aur_resolve([rm[1]]); return r ? this._send(res, 200, r) : this._send(res, 404, { error: 'name not registered' }); }
        if ((rm = /^\/reverse\/([a-z0-9]+)$/.exec(p))) return this._send(res, 200, { address: rm[1], name: this.chain.reverse(rm[1]) });
        let m;
        if ((m = /^\/block\/(latest|\d+)$/.exec(p))) {
          const b = this.rpcMethods.aur_getBlock([m[1]]);
          return b ? this._send(res, 200, b) : this._send(res, 404, { error: 'not found' });
        }
        if ((m = /^\/blocks$/.exec(p))) {
          const n = Math.min(Number(url.searchParams.get('limit') || 20), 100);
          const out = [];
          const top = Math.min(this.chain.height, Number(url.searchParams.get('before') || Infinity) - 1);
          for (let h = top; h > 0 && out.length < n; h--) out.push(this.chain.getBlock(h).header && { ...this.chain.getBlock(h).header, hash: this.chain.getBlock(h).hash });
          return this._send(res, 200, out);
        }
        if ((m = /^\/account\/([a-z0-9]+)\/txs$/.exec(p))) {
          return this._send(res, 200, this.accountTxs(m[1], Math.min(Number(url.searchParams.get('limit') || 25), 100), Number(url.searchParams.get('before') || Infinity)));
        }
        if ((m = /^\/account\/((?:0x)?[a-z0-9]+)$/i.exec(p))) return this._send(res, 200, this.account(m[1]));
        if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(p))) {
          const t = this.getTx(m[1]);
          return t ? this._send(res, 200, t) : this._send(res, 404, { error: 'not found' });
        }
        if ((m = /^\/domain\/([\w.-]+)$/.exec(p))) {
          const d = this.resolveDomain(m[1]);
          return d ? this._send(res, 200, d) : this._send(res, 404, { error: 'not found' });
        }
        if (p === '/p2p/round-state') {
          const e = this.engine;
          return this._send(res, 200, e && e.isRunning && e.height === Number(url.searchParams.get('height')) ? e.roundState() : { height: -1 });
        }
        if (p === '/p2p/info') return this._send(res, 200, { chainId: this.chain.chainId, genesisHash: this.chain.genesisHash, height: this.chain.height, peers: this.peerUrls().slice(0, 30) });
        if (p === '/p2p/blocks') {
          const from = Number(url.searchParams.get('from') || 1), limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
          const out = [];
          for (let h = from; h < from + limit && h <= this.chain.height; h++) out.push({ block: this.chain.getBlock(h), commit: this.chain.commits.get(h) });
          return this._send(res, 200, out);
        }
        if (this.config.webRoot && this._serveStatic(res, p)) return;
        return this._send(res, 404, { error: 'not found' });
      }

      if (req.method === 'POST') {
        const body = await this._body(req);
        if (p === '/rpc' || p === '/') return this._send(res, 200, await this._jsonRpc(body));
        if (p === '/tx') return this._send(res, 200, await this.onTx(body.tx || body));
        if (p === '/p2p/msg') return this._send(res, 200, this.onMsg(body));
        if (p === '/p2p/commit') return this._send(res, 200, this.onCommit(body));
        if (p === '/p2p/tx') { try { return this._send(res, 200, await this.onTx(body.tx)); } catch { return this._send(res, 200, { ok: false }); } }
        if (p === '/p2p/hello') { this._addPeer(body.url); return this._send(res, 200, { ok: true }); }
        return this._send(res, 404, { error: 'not found' });
      }
      return this._send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      const code = e instanceof TxInvalid || e instanceof BlockInvalid || e instanceof SyntaxError ? 400 : 500;
      return this._send(res, code, { error: e.message, code: e.code });
    }
  }

  /** Serve the bundled website (wallet, explorer) from the node itself: one process, one origin. */
  _serveStatic(res, p) {
    const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
    const root = path.resolve(this.config.webRoot);
    let rel = decodeURIComponent(p);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    let data;
    try { data = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  }

  async _jsonRpc(req) {
    const one = async (r) => {
      const fn = this.rpcMethods[r.method];
      if (!fn) return { jsonrpc: '2.0', id: r.id ?? null, error: { code: -32601, message: 'method not found' } };
      try { return { jsonrpc: '2.0', id: r.id ?? null, result: await fn(r.params || []) }; } catch (e) {
        return { jsonrpc: '2.0', id: r.id ?? null, error: { code: typeof e.code === 'number' ? e.code : e instanceof TxInvalid ? -32010 : -32000, message: e.message, data: e.data ?? e.code } };
      }
    };
    return Array.isArray(req) ? Promise.all(req.slice(0, 50).map(one)) : one(req);
  }
}

module.exports = { AurenNode, VERSION };

'use strict';
// AUREN explorer: every number comes from a node's API. Node-provided strings are always escaped.
(() => {
  const { esc, formatAur, Rpc } = Aur;
  const $ = (id) => document.getElementById(id);
  const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const short = (s, n = 10) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s || '');
  const age = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const link = (q, text, cls = 'mono') => `<a href="?${q}" data-route="${esc(q)}" class="${cls}" title="${esc(text)}">${esc(short(text))}</a>`;
  const A = (addr) => link('address=' + addr, addr);
  const AMOUNT_KEYS = new Set(['amount', 'dailyLimit']);

  let rpc, status, params, route = null, timer = null;

  // ---------------------------------------------------------------- shared
  function kv(rows) { return `<div class="table-wrap"><table><tbody>${rows.map(([k, v]) => `<tr><th style="width:190px">${esc(k)}</th><td style="overflow-wrap:anywhere">${v}</td></tr>`).join('')}</tbody></table></div>`; }
  function fmtBody(body) {
    return Object.entries(body).map(([k, v]) => {
      if (AMOUNT_KEYS.has(k) && v !== null) return `${esc(k)}: <b>${formatAur(v)} AUR</b>`;
      if (k === 'value' && /^\d+$/.test(String(v))) return `value: <b>${formatAur(BigInt(v) / 1000000000n)} AUR</b>`; // EVM value is in wei (1 AUR = 1e18 wei)
      if (k === 'data' && typeof v === 'string') return `data: <span class="mono">${v ? '0x' + esc(v.slice(0, 18)) + (v.length > 18 ? '…' : '') : '(none)'}</span> <small class="muted">${v.length / 2} bytes</small>`;
      if (k === 'to' && typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) return `to: <span class="mono">0x${esc(v)}</span>`;
      if (k === 'to' && v === null) return 'to: <b>contract creation</b>';
      if (typeof v === 'string' && /^[a-z]+1[02-9ac-hj-np-z]{30,}$/.test(v)) return `${esc(k)}: ${A(v)}`;
      return `${esc(k)}: <span class="mono">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`;
    }).join('<br>');
  }
  const statusTag = (s, code) => (s === 1 ? '<span class="tag live">success</span>' : s === 0 ? `<span class="tag no">failed: ${esc(code)}</span>` : '<span class="tag soon">pending</span>');
  const back = '<p><a href="explorer.html" data-route="">← Back to overview</a></p>';

  function txTable(rows) {
    return `<div class="table-wrap"><table><thead><tr><th>Tx</th><th>Block</th><th>Age</th><th>Type</th><th>From</th><th>Details</th><th>Result</th></tr></thead><tbody>${rows.map((t) =>
      `<tr><td>${link('tx=' + t.hash, t.hash)}</td><td>${link('block=' + t.height, String(t.height))}</td><td>${age(t.time)}</td><td>${esc(t.type)}</td><td>${A(t.from)}</td><td>${fmtBody(t.body)}</td><td>${statusTag(t.status, t.code)}</td></tr>`).join('') || '<tr><td colspan="7" class="msg">No transactions</td></tr>'}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- views
  async function viewBlock(h) {
    const b = await rpc.get(`/block/${h}`);
    const hd = b.header;
    const txs = await Promise.all(b.txs.slice(0, 100).map(async (tx) => { const hash = await Aur.txHash(tx); const t = await rpc.call('aur_getTx', [hash]); return { hash, height: hd.height, time: hd.time, type: tx.type, from: tx.from, body: tx.body, status: t && t.receipt ? t.receipt.status : null, code: t && t.receipt ? t.receipt.code : null }; }));
    const lim = params.limits;
    const pct = (u, l) => ((Number(u) / Number(l)) * 100).toFixed(1) + '%';
    const signers = (b.commit ? b.commit.votes : []).map((v) => A(v.validator)).join(' ');
    return `${back}<h2>Block ${fmt(hd.height)}</h2>` + kv([
      ['Hash', `<span class="mono">${esc(b.hash)}</span>`],
      ['Parent', hd.height > 1 ? link('block=' + (hd.height - 1), hd.prevHash) : 'genesis'],
      ['Time', `${new Date(hd.time).toISOString()} (${age(hd.time)})`],
      ['Created by', A(hd.proposer) + ` · round ${hd.round}`],
      ['Transactions', fmt(hd.txCount)],
      ['Fee level', `compute ${esc(hd.baseFee.compute)} · state ${esc(hd.baseFee.state)} sparks/unit`],
      ['Resource use', `compute ${fmt(hd.used.compute)} (${pct(hd.used.compute, lim.compute)}) · state ${fmt(hd.used.state)} (${pct(hd.used.state, lim.state)})`],
      ['State root', `<span class="mono">${esc(hd.stateRoot)}</span>`],
      ['Finality certificate', `${(b.commit ? b.commit.votes.length : 0)} signatures: ${signers || 'n/a'}`],
      ['Evidence included', fmt((b.evidence || []).length)],
    ]) + `<h3>Transactions</h3>` + txTable(txs.map((t) => t));
  }

  async function viewTx(hash) {
    const t = await rpc.get(`/tx/${hash}`);
    const tx = t.tx, r = t.receipt;
    return `${back}<h2>Transaction</h2>` + kv([
      ['Hash', `<span class="mono">${esc(hash)}</span>`],
      ['Status', t.status === 'pending' ? '<span class="tag soon">waiting to be confirmed</span>' : `${statusTag(r && r.status, r && r.code)} in block ${link('block=' + t.height, String(t.height))}`],
      ['Type', esc(tx.type)],
      ['From', A(tx.from)],
      ['Details', fmtBody(tx.body)],
      ['Fee paid', r ? `${formatAur(r.fee)} AUR (burned ${formatAur(r.burned)} AUR, rest is the tip)` : '—'],
      ['Max fee / tip', `${formatAur(tx.maxFee)} / ${formatAur(tx.tip)} AUR`],
      ...(r && r.evm ? [
        ['EVM execution', `${r.evm.success ? '<span class="tag live">success</span>' : '<span class="tag no">reverted</span>'} · gas used ${fmt(r.evm.gasUsed)} of ${fmt(tx.body.gasLimit)}`],
        ...(r.evm.contractAddress ? [['Contract created', `<span class="mono">0x${esc(r.evm.contractAddress)}</span>`]] : []),
        ...(r.evm.output ? [['Return data', `<span class="mono">0x${esc(r.evm.output)}</span>`]] : []),
        ...(r.evm.logs.length ? [['Logs', r.evm.logs.map((l, i) => `#${i} <span class="mono">0x${esc(l.address)}</span><br><span class="muted mono" style="font-size:.78rem">topics: ${l.topics.map((x) => '0x' + esc(x)).join(' ')}<br>data: 0x${esc(l.data)}</span>`).join('<hr style="border:0;border-top:1px solid var(--line)">')]] : []),
      ] : []),
      ...(tx.scheme === 4 ? [['Signed by', 'an Ethereum wallet (secp256k1); the raw transaction is the signature']] : []),
      ['Payment number', String(tx.nonce)], ['Chain', esc(tx.chainId)],
      ['Signing key', `<span class="mono">${esc(tx.pub)}</span>`],
      ['Signature', `<span class="mono">${esc(tx.sig)}</span>`],
    ]);
  }

  async function viewAddress(addr) {
    const [a, txs, vs, rev] = await Promise.all([rpc.get(`/account/${addr}`), rpc.get(`/account/${addr}/txs?limit=25`), rpc.get('/validators'), rpc.get(`/reverse/${addr}`).catch(() => ({ name: null }))]);
    const val = vs.validators.find((v) => v.operator === addr);
    let html = `${back}<h2>Account</h2>` + kv([
      ['Address', `<span class="mono">${esc(addr)}</span>`],
      ...(a.evm ? [['EVM address', `<span class="mono">${esc(a.evm.address)}</span>`]] : []),
      ...(a.evm && a.evm.isContract ? [['Type', `<span class="tag live">Smart contract</span> · ${fmt(a.evm.codeSize)} bytes of code`]] : []),
      ...(rev.name ? [['Primary name', `${link('name=' + rev.name, rev.name, '')} <span class="tag live">forward-verified</span>`]] : []),
      ['Balance', `<b>${formatAur(a.balance)} AUR</b>`], ['Spendable', `${formatAur(a.spendable)} AUR`], ['Payments sent', String(a.nonce)],
      ...(a.authPub ? [['Authorized key (after recovery)', `<span class="mono">${esc(a.authPub)}</span>`]] : []),
      ...(a.security ? [['Protection', `${a.security.guardians.length} guardians, threshold ${a.security.threshold}, delay ${fmt(a.security.delayBlocks)} blocks, daily limit ${a.security.dailyLimit === null ? 'none' : formatAur(a.security.dailyLimit) + ' AUR'}`]] : []),
    ]);
    if (val) html += `<h3>Validator</h3>` + kv([
      ['Name', esc(val.moniker)], ['Status', val.tombstoned ? '<span class="tag no">banned</span>' : val.jailed ? '<span class="tag soon">paused</span>' : val.active ? '<span class="tag live">active</span>' : '<span class="tag soon">inactive</span>'],
      ['Staked', `${formatAur(val.tokens)} AUR`], ['Commission', `${(val.commissionBps / 100).toFixed(2)}%`], ['Missed blocks (window)', String(val.missed)], ['Consensus key', `<span class="mono">${esc(val.consPub)}</span>`],
    ]);
    if (a.delegations.length) html += `<h3>Delegations</h3><div class="table-wrap"><table><thead><tr><th>Validator</th><th>Staked</th><th>Unclaimed rewards</th></tr></thead><tbody>${a.delegations.map((d) => `<tr><td>${A(d.validator)}</td><td>${formatAur(d.tokens)} AUR</td><td>${formatAur(d.pendingRewards)} AUR</td></tr>`).join('')}</tbody></table></div>`;
    if (a.unbonding.length) html += `<h3>Unbonding</h3><div class="table-wrap"><table><tbody>${a.unbonding.map((u) => `<tr><td>${A(u.validator)}</td><td>${formatAur(u.amount)} AUR</td><td>available at block ${fmt(u.matureAtHeight)}</td></tr>`).join('')}</tbody></table></div>`;
    if (a.evm && a.evm.isContract) html += `<h3>Contract code</h3><pre style="white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto">${esc(a.evm.code)}</pre>`;
    return html + `<h3>Transactions</h3>` + txTable(txs.map((t) => ({ ...t })));
  }

  let light = null;
  async function getLight() {
    if (!light || light.chainId !== status.chainId) {
      let pinned = null;
      for (const u of ['/networks.json', rpc.url + '/networks.json']) { try { const n = Object.values(await (await fetch(u, { cache: 'no-store' })).json()).find((x) => x.chainId === status.chainId); if (n) { pinned = n.genesisHash || null; break; } } catch { /* next */ } }
      light = new ANR.LightClient({ rpc, label: status.chainId, pinnedGenesisHash: pinned, storage: localStorage });
      await light.init();
    }
    return light;
  }

  const pager = (older, newer) => `<p style="display:flex;justify-content:space-between;margin:14px 0">${newer ? `<a href="?${newer}" data-route="${newer}">← Newer</a>` : '<span></span>'}${older ? `<a href="?${older}" data-route="${older}">Older →</a>` : '<span></span>'}</p>`;

  async function viewBlocks(arg) {
    const before = arg && arg !== '1' ? Number(arg) : null;
    const list = await rpc.get(`/blocks?limit=25${before ? `&before=${before}` : ''}`);
    const rows = list.map((b) => `<tr><td>${link('block=' + b.height, '#' + fmt(b.height), '')}</td><td>${age(b.time)}<br><small class="muted">${new Date(b.time).toISOString().replace('T', ' ').slice(0, 19)}</small></td><td>${b.txCount}</td><td>${A(b.proposer)}</td><td>${fmt(b.used.compute)} <small class="muted">(${((Number(b.used.compute) / params.limits.compute) * 100).toFixed(1)}%)</small></td><td class="mono">${esc(b.baseFee.compute)}</td></tr>`).join('');
    const last = list.length ? list[list.length - 1].height : 0;
    return `${back}<h2>Blocks</h2><div class="table-wrap"><table><thead><tr><th>Block</th><th>Time</th><th>Txs</th><th>Created by</th><th>Space used</th><th>Fee</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="msg">No blocks</td></tr>'}</tbody></table></div>${pager(last > 1 ? 'blocks=' + last : null, before ? 'blocks=1' : null)}`;
  }

  async function viewTxs(arg) {
    const before = arg && arg !== '1' ? Number(arg) : null;
    const r = await rpc.get(`/txs?limit=25${before ? `&before=${before}` : ''}`);
    return `${back}<h2>Transactions</h2>${txTable(r.txs)}${pager(r.next ? 'txs=' + r.next : null, before ? 'txs=1' : null)}`;
  }

  async function viewValidators() {
    const vs = await rpc.get('/validators');
    const total = vs.validators.reduce((s, v) => s + BigInt(v.power), 0n) || 1n;
    const c = vs.concentration;
    const rows = vs.validators.map((v, i) => {
      const share = Number((BigInt(v.power) * 10000n) / total) / 100;
      const st = v.tombstoned ? '<span class="tag no">banned</span>' : v.jailed ? '<span class="tag soon">paused</span>' : v.active ? '<span class="tag live">active</span>' : '<span class="tag soon">inactive</span>';
      return `<tr><td>${i + 1}</td><td>${link('address=' + v.operator, v.moniker, '')}<br><span class="mono muted" style="font-size:.78rem">${esc(short(v.operator, 12))}</span></td><td><div class="bar"><i style="width:${Math.min(100, share)}%"></i></div><small>${share.toFixed(2)}%</small></td><td>${formatAur(v.tokens, 0)} AUR</td><td>${(v.commissionBps / 100).toFixed(1)}%</td><td>${v.missed}</td><td>${st}</td></tr>`;
    }).join('');
    return `${back}<h2>Validators</h2><div class="stats"><div class="stat"><small>Active validators</small><b>${c.activeValidators}</b></div><div class="stat"><small>Nakamoto coefficient (⅓)</small><b>${c.halt33}</b><em>fewest that can halt finality</em></div><div class="stat"><small>Nakamoto coefficient (⅔)</small><b>${c.control67}</b><em>fewest that can finalize alone</em></div><div class="stat"><small>Staked</small><b>${formatAur(status.bonded, 0)} AUR</b></div></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Validator</th><th>Voting power</th><th>Bonded</th><th>Commission</th><th>Missed (window)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function viewRich() {
    const r = await rpc.get('/richlist?limit=100');
    const rows = r.accounts.map((a) => `<tr><td>${a.rank}</td><td>${A(a.address)}</td><td><b>${formatAur(a.balance, 4)}</b> AUR</td><td>${(a.sharePpm / 10000).toFixed(3)}%</td><td>${a.nonce}</td></tr>`).join('');
    return `${back}<h2>Top accounts</h2><p class="note">${fmt(r.count)} accounts · total supply ${formatAur(r.supply, 0)} AUR (staked funds are counted in validators, not here).</p><div class="table-wrap"><table><thead><tr><th>Rank</th><th>Address</th><th>Balance</th><th>Of supply</th><th>Txs sent</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function viewTlds() {
    const list = await rpc.get('/tlds');
    const rows = list.map((t) => `<tr><td><b>.${esc(t.tld)}</b></td><td>${t.builtIn ? 'built in' : A(t.owner)}</td><td>${t.open ? 'open' : 'restricted'}</td><td>${t.price === null ? 'by length' : formatAur(t.price) + ' AUR / yr'}</td><td>${t.builtIn ? '' : (t.ownerShareBps / 100) + '%'}</td><td>${fmt(t.domains)}</td></tr>`).join('');
    return `${back}<h2>Name TLDs</h2><p class="note">Anyone can create a TLD from the wallet and set its rules. Names look like <code>alice.tld</code>.</p><div class="table-wrap"><table><thead><tr><th>TLD</th><th>Owner</th><th>Registration</th><th>Price</th><th>Owner share</th><th>Names</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function viewNodes() {
    const n = await rpc.get('/nodes');
    const rows = n.nodes.map((x) => `<tr><td>${A(x.address)}</td><td>${A(x.payout)}</td><td>${formatAur(x.bond, 0)} AUR</td><td>${x.proven ? '<span class="tag live">proved</span>' : '<span class="tag soon">not yet</span>'}</td><td>${x.lastProvenEpoch < 0 ? 'never' : x.lastProvenEpoch}</td></tr>`).join('') || '<tr><td colspan="5" class="msg">No nodes registered yet. Run <code>auren join &lt;network&gt; --earn</code></td></tr>';
    return `${back}<h2>Node rewards</h2><p class="note">Nodes that store the chain and prove it each epoch share the pool. Epoch ${n.epoch} ends at block ${fmt(n.epochEndsAtHeight)}. ${n.challengeHeight ? 'Challenged block this epoch: ' + link('block=' + n.challengeHeight, '#' + fmt(n.challengeHeight), '') + '.' : ''}</p>` + kv([['Pool', formatAur(n.pool, 4) + ' AUR'], ['Bond to join', formatAur(n.bond, 0) + ' AUR'], ['Epoch length', fmt(n.epochBlocks) + ' blocks'], ['Share of issuance', (n.poolBps / 100) + '%']]) + `<div class="table-wrap"><table><thead><tr><th>Node</th><th>Pays to</th><th>Bond</th><th>This epoch</th><th>Last proven epoch</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function viewDraw() {
    const d = await rpc.get('/draw');
    const last = d.lastDraw;
    const rows = d.ticketHolders.map((t) => `<tr><td>${A(t.address)}</td><td>${t.tier === 'free' ? 'free (no deposit)' : 'full'}</td><td>${A(t.payout)}</td><td>${t.provenEpoch}</td><td>${last && last.winners.includes(t.address) ? '<span class="tag live">won the last draw</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="msg">No ticket holders yet. Any node can join for free and gets a ticket after it proves it stores the chain.</td></tr>';
    return `${back}<h2>Random draw</h2><p class="note">Every block, ${d.committeeSize} ticket holders are drawn at random and paid. Hardware, balance and stake do not change anyone's chance. The draw uses a random beacon that nobody can know before the previous block is final, so you can check it yourself.</p>` + kv([['Pool', formatAur(d.pool, 6) + ' AUR'], ['Share of issuance', (d.poolBps / 100) + '%'], ['Committee size', String(d.committeeSize)], ['Ticket holders', String(d.ticketHolders.length)], ['Random beacon', '<span class="mono">' + esc(d.beacon.slice(0, 24)) + '…</span>'], ['Last draw', last ? 'block ' + link('block=' + last.height, String(last.height)) + ', ' + last.winners.length + ' winners, ' + formatAur(last.each, 6) + ' AUR each' : 'none yet']]) + `<div class="table-wrap"><table><thead><tr><th>Ticket holder</th><th>Tier</th><th>Pays to</th><th>Proved in epoch</th><th>Last draw</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function viewProposals() {
    const r = await rpc.get('/proposals');
    const g = r.governance;
    const pct = (a, b) => (BigInt(b) > 0n ? Number((BigInt(a) * 1000n) / BigInt(b)) / 10 : 0);
    const rows = r.proposals.map((p) => {
      const t = p.tally, voted = t ? BigInt(t.yes) + BigInt(t.no) + BigInt(t.abstain) + BigInt(t.veto) : 0n;
      const tag = { voting: 'soon', passed: 'live', executed: 'live', rejected: 'no', failed: 'no' }[p.status] || 'soon';
      const when = p.status === 'voting' ? `voting ends at block ${fmt(p.votingEnd)}` : p.status === 'passed' ? `takes effect at block ${fmt(p.executeAt)}` : p.status === 'executed' ? `executed at block ${fmt(p.executedAt)}` : esc(p.reason || '');
      return `<tr><td>#${p.id}</td><td><b>${esc(p.title)}</b><br><span class="muted">${esc(p.description)}</span><br>${Object.entries(p.changes).map(([k, v]) => `<code>${esc(k)}</code> → <b>${esc(v)}</b>`).join(', ')}</td><td><span class="tag ${tag}">${esc(p.status)}</span><br><small>${when}</small></td><td>${t ? `yes ${pct(t.yes, voted)}% · no ${pct(t.no, voted)}% · abstain ${pct(t.abstain, voted)}% · veto ${pct(t.veto, voted)}%<br><small>turnout ${pct(voted, t.bonded)}% (quorum ${g.quorumBps / 100}%)</small>` : ''}</td></tr>`;
    }).join('');
    return `${back}<h2>Governance</h2><p class="note">Quorum ${g.quorumBps / 100}% of bonded stake · yes &gt; ${g.thresholdBps / 100}% · veto &lt; ${g.vetoBps / 100}% · voting ${fmt(g.votingBlocks)} blocks · timelock ${fmt(g.timelockBlocks)} blocks · deposit ${formatAur(g.deposit)} AUR. Vote from the wallet's Govern tab.</p><div class="table-wrap"><table><thead><tr><th>ID</th><th>Proposal</th><th>Status</th><th>Tally</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="msg">No proposals yet.</td></tr>'}</tbody></table></div>`;
  }

  async function viewName(name) {
    const d = await rpc.get(`/domain/${encodeURIComponent(name)}`);
    let proof = '<span class="tag soon">checking…</span>';
    try {
      const r = await (await getLight()).resolve(name);
      proof = r.verified
        ? `<span class="tag live">verified by light client</span> at block ${link('block=' + r.height, String(r.height))}${light.isPinned ? '' : ' <span class="tag soon">genesis not pinned</span>'}`
        : `<span class="tag no">NOT verified: ${esc(r.reason || 'unknown')}</span>`;
    } catch (e) { proof = `<span class="tag no">verification failed: ${esc(e.message)}</span>`; }
    const recs = Object.entries(d.records || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td style="overflow-wrap:anywhere">${esc(v)}</td></tr>`).join('');
    return `${back}<h2>${esc(d.name)}</h2>` + kv([
      ['Namespace', `<code>${esc(d.namespace)}</code> (the full identifier is <span class="mono">${esc(d.name)}@${esc(d.namespace)}</span>)`],
      ['Owner', A(d.owner)], ['Resolves to', A(d.target)], ['Primary name of target', d.reverse ? '<span class="tag live">yes, forward-verified</span>' : 'no'],
      ['Expires at block', fmt(d.expiresAt)], ['Proof', proof],
    ]) + (recs ? `<h3>Records</h3><div class="table-wrap"><table><tbody>${recs}</tbody></table></div>` : '');
  }

  // ---------------------------------------------------------------- home
  function stats(st) {
    const c = st.concentration;
    const cells = [
      ['Height', fmt(st.height), st.chainId],
      ['Transfer fee', formatAur(st.transferFee, 6) + ' AUR', 'per payment'],
      ['Validators', c.activeValidators, 'run the network'],
      ['Supply', formatAur(st.supply, 0) + ' AUR', `issuance ${(Number(st.issuanceRatePpm) / 10000).toFixed(2)}%/yr`],
      ['Burned', formatAur(st.burned, 4) + ' AUR', 'fees and penalties, gone for good'],
      ['Staked', formatAur(st.bonded, 0) + ' AUR', `${((Number(st.bonded) / Number(st.supply)) * 100).toFixed(1)}% of supply`],
      ['Waiting payments', st.mempool, `${st.peers} connected nodes`],
    ];
    $('stats').innerHTML = cells.map(([k, v, s]) => `<div class="stat"><small>${esc(k)}</small><b>${esc(v)}</b><em>${esc(s)}</em></div>`).join('');
  }

  function feeChart(blocks) {
    const bs = blocks.slice().reverse();
    if (bs.length < 2) { $('feechart').innerHTML = ''; return; }
    const W = 560, H = 170, pad = 40;
    const fees = bs.map((b) => Number(b.baseFee.compute));
    const maxFee = Math.max(...fees) * 1.15 || 1;
    const x = (i) => pad + (i / (bs.length - 1)) * (W - pad - 10);
    const yF = (v) => H - 22 - (v / maxFee) * (H - 40);
    const yU = (u) => H - 22 - u * (H - 40);
    const bw = Math.max(1, (W - pad - 10) / bs.length - 1);
    const bars = bs.map((b, i) => `<rect x="${x(i) - bw / 2}" y="${yU(Number(b.used.compute) / params.limits.compute)}" width="${bw}" height="${H - 22 - yU(Number(b.used.compute) / params.limits.compute)}" fill="#6aa8ff" opacity=".35"/>`).join('');
    const line = bs.map((b, i) => `${x(i).toFixed(1)},${yF(fees[i]).toFixed(1)}`).join(' ');
    $('feechart').innerHTML = `<line class="axis" x1="${pad}" x2="${W - 10}" y1="${yU(0.5)}" y2="${yU(0.5)}" stroke-dasharray="4 4"/><text class="tick" x="4" y="${yU(0.5) + 4}">50%</text>${bars}
      <polyline fill="none" stroke="#e8b84a" stroke-width="2.5" points="${line}"/><text class="tick" x="4" y="14">fee ${fmt(Math.max(...fees))}</text><text class="tick" x="${pad}" y="${H - 4}">gold: fee level · blue: how full blocks are · dashed: half full</text>`;
  }

  async function home() {
    status = await rpc.call('aur_status');
    stats(status);
    $('conn').className = 'tag live'; $('conn').textContent = `${status.network} · connected`;
    $('faucetpanel').hidden = status.network === 'mainnet';
    const [blocks, vs, tip] = await Promise.all([rpc.get('/blocks?limit=60'), rpc.get('/validators'), Promise.resolve()]);
    void tip;
    $('blocks').innerHTML = blocks.slice(0, 12).map((b) => `<tr><td>${link('block=' + b.height, '#' + fmt(b.height), '')}</td><td>${age(b.time)}</td><td>${b.txCount}</td><td>${A(b.proposer)}</td><td class="mono">${esc(b.baseFee.compute)}</td></tr>`).join('');
    feeChart(blocks);
    try {
      const rt = await rpc.get('/txs?limit=8');
      $('txs').innerHTML = rt.txs.slice(0, 10).map((t) => `<tr><td>${link('tx=' + t.hash, t.hash)}</td><td>${link('block=' + t.height, String(t.height), '')}</td><td>${esc(t.type)}</td><td>${A(t.from)}</td><td>${statusTag(t.status, t.code)}</td></tr>`).join('') || '<tr><td colspan="5" class="msg">No transactions yet</td></tr>';
    } catch { /* older node without /txs */ }
    const total = vs.validators.reduce((s, v) => s + BigInt(v.power), 0n) || 1n;
    $('vals').innerHTML = vs.validators.map((v) => {
      const share = Number((BigInt(v.power) * 10000n) / total) / 100;
      const st = v.tombstoned ? '<span class="tag no">banned</span>' : v.jailed ? '<span class="tag soon">paused</span>' : v.active ? '' : '<span class="tag soon">inactive</span>';
      return `<tr><td>${link('address=' + v.operator, v.moniker, '')} ${st}<br><span class="mono muted" style="font-size:.78rem">${esc(short(v.operator, 12))}</span></td><td><div class="bar"><i style="width:${Math.min(100, share)}%"></i></div><small>${share.toFixed(1)}% · ${formatAur(v.tokens, 0)} AUR</small></td><td>${(v.commissionBps / 100).toFixed(1)}%</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="msg">No validators</td></tr>';
  }

  // ---------------------------------------------------------------- routing
  function parseRoute() {
    const q = new URLSearchParams(location.search);
    for (const k of ['block', 'tx', 'address', 'name', 'proposals', 'blocks', 'txs', 'validators', 'rich', 'tlds', 'nodes', 'draw']) if (q.get(k)) return { k, v: q.get(k) };
    return null;
  }

  async function render() {
    $('conn').className = 'tag live'; // set properly below on failure
    try {
      if (!params) params = await rpc.call('aur_getParams');
      route = parseRoute();
      $('home').hidden = !!route;
      if (!route) { $('view').innerHTML = ''; await home(); return; }
      status = await rpc.call('aur_status'); stats(status);
      const html = await ({ block: viewBlock, tx: viewTx, address: viewAddress, name: viewName, proposals: viewProposals, blocks: viewBlocks, txs: viewTxs, validators: viewValidators, rich: viewRich, tlds: viewTlds, nodes: viewNodes, draw: viewDraw })[route.k](route.v);
      $('view').innerHTML = html;
      $('conn').textContent = `${status.network} · connected`;
    } catch (e) {
      if (route) { $('view').innerHTML = `${back}<div class="msg err">Not found: ${esc(e.message)}</div>`; return; }
      $('conn').className = 'tag no'; $('conn').textContent = 'disconnected';
      $('stats').innerHTML = `<div class="msg err">Can't connect to the network. Check your internet connection, then pick a network above.</div>`;
    }
    if (status) { $('conn').className = 'tag live'; $('conn').textContent = `${status.network} · connected`; }
  }

  function go(q) { history.pushState({}, '', q ? '?' + q : location.pathname); render(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-route]');
    if (a) { e.preventDefault(); go(a.dataset.route); }
  });
  window.addEventListener('popstate', render);

  async function search(q) {
    q = q.trim(); if (!q) return;
    if (/^\d+$/.test(q)) return go('block=' + q);
    if (/^[0-9a-f]{64}$/i.test(q)) return go('tx=' + q.toLowerCase());
    if (/^0x[0-9a-f]{64}$/i.test(q)) { // an Ethereum transaction hash: map it to the native hash through the receipt
      try {
        const rc = await rpc.call('eth_getTransactionReceipt', [q.toLowerCase()]);
        if (rc) { const b = await rpc.get(`/block/${parseInt(rc.blockNumber, 16)}`); return go('tx=' + await Aur.txHash(b.txs[parseInt(rc.transactionIndex, 16)])); }
      } catch { /* fall through to the hint */ }
    }
    if (/^0x[0-9a-f]{40}$/i.test(q)) { try { const acc = await rpc.get('/account/' + q.toLowerCase()); return go('address=' + acc.address); } catch { /* fall through */ } }
    if (/^proposals?$/i.test(q) || /^gov(ernance)?$/i.test(q)) return go('proposals=1');
    if (/\.aur$/i.test(q)) return go('name=' + encodeURIComponent(q.toLowerCase()));
    if (status && q.toLowerCase().startsWith(status.addressPrefix + '1')) return go('address=' + q.toLowerCase());
    $('view').innerHTML = `${back}<div class="msg err">Enter a block number, a payment ID, an address (${esc(status ? status.addressPrefix : 'aur')}1…) or a name such as alice.aur.</div>`;
    $('home').hidden = true;
  }
  $('search').addEventListener('submit', (e) => { e.preventDefault(); search($('q').value); });
  Aur.initNetPicker($('net'), $('rpc'), $('rpcform'));
  $('rpcform').addEventListener('submit', (e) => {
    e.preventDefault();
    rpc = new Rpc($('rpc').value.trim().replace(/\/$/, ''));
    try { localStorage.setItem('auren.rpc', rpc.url); } catch { /* storage unavailable */ }
    params = null; render();
  });
  $('faucetform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const m = $('fmsg'); m.className = 'msg'; m.textContent = 'Requesting…';
    try {
      const u = new URL(rpc.url);
      const r = await fetch(`${Aur.NETWORKS[status.network].faucet}/drip`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: $('faddr').value.trim() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      m.innerHTML = `Sent ${esc(j.amount)} · ${link('tx=' + j.hash, j.hash)}`;
    } catch (err) { m.className = 'msg err'; m.textContent = err.message; }
  });

  let saved = null; try { saved = localStorage.getItem('auren.rpc'); } catch { /* ignore */ }
  Aur.detectRpc(saved).then((u) => { $('rpc').value = u; if ($('net').syncPicker) $('net').syncPicker(); rpc = new Rpc(u); render(); timer = setInterval(() => { if (!document.hidden && (!route || route.k !== 'tx')) render(); }, 2000); });
  void timer;
})();

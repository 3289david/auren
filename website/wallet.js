'use strict';
// AUREN web wallet. Keys never leave this browser. Every action: build tx -> dry-run on the node
// (aur_simulate) -> show exact effects -> you confirm -> sign locally -> submit -> wait for inclusion.
(() => {
  const { esc, parseAur, formatAur, Rpc } = Aur;
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const short = (s, n = 12) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s || '');
  const fmt = (n) => Number(n).toLocaleString('en-US');

  let rpc = null, status = null, params = null;
  let wallets = store.get('auren.wallets') || []; // [{ name, pub, keystore }]
  let key = null, address = null, account = null, tab = 'send', idle = null, note = null;

  // ------------------------------------------------------------ plumbing
  const touch = () => { clearTimeout(idle); if (key) idle = setTimeout(() => { key = null; address = null; note = { cls: 'ok', html: 'Wallet locked after 10 minutes of inactivity.' }; render(); }, 600000); };
  document.addEventListener('click', touch); document.addEventListener('keydown', touch);

  function notify(html, cls = 'ok') { note = { cls, html }; const n = $('note'); if (n) { n.className = 'toast ' + cls; n.innerHTML = html; n.hidden = false; } }

  async function connect(url) {
    rpc = new Rpc(url);
    try {
      status = await rpc.call('aur_status');
      params = await rpc.call('aur_getParams');
      $('conn').className = 'tag live'; $('conn').textContent = `${status.network} · ${status.chainId}`;
      store.set('auren.rpc', url);
    } catch (e) {
      status = null;
      $('conn').className = 'tag no'; $('conn').textContent = 'disconnected';
    }
    if (key) address = await Aur.pubToAddress(key.pub, status.addressPrefix, key.scheme || 0);
    render();
  }

  async function refreshAccount() {
    if (!key || !status) return;
    try {
      status = await rpc.call('aur_status');
      account = await rpc.call('aur_getAccount', [address]);
      const pending = account.delegations.reduce((s, d) => s + BigInt(d.pendingRewards), 0n);
      const staked = account.delegations.reduce((s, d) => s + BigInt(d.tokens), 0n);
      const unb = account.unbonding.reduce((s, d) => s + BigInt(d.amount), 0n);
      const el = $('balances');
      if (el) {
        const bits = [];
        if (staked > 0n) bits.push('Staked ' + formatAur(staked, 4));
        if (pending > 0n) bits.push('Rewards to claim ' + formatAur(pending, 4));
        if (unb > 0n) bits.push('Coming back ' + formatAur(unb, 4));
        const locked = BigInt(account.balance) - BigInt(account.spendable);
        if (locked > 0n) bits.push('Locked ' + formatAur(locked, 4));
        el.innerHTML = '<div class="hero-label">Your balance</div><div class="hero-amt">' + formatAur(account.spendable, 4) + ' <span>AUR</span></div><div class="hero-sub">' + (bits.length ? esc(bits.join('  ·  ')) : 'Nothing staked yet') + '</div>';
      }
      const h = $('height'); if (h) h.textContent = `Sending costs about ${formatAur(status.transferFee, 6)} AUR`;
    } catch { /* node unreachable: keep last values */ }
  }
  setInterval(refreshAccount, 2500);

  // ---- universal name resolution (docs/name-resolution.md) ----
  let light = null, lastResolution = null;
  async function pinnedHash() {
    for (const u of ['/networks.json', rpc.url + '/networks.json']) {
      try { const nets = await (await fetch(u, { cache: 'no-store' })).json(); const n = Object.values(nets).find((x) => x.chainId === status.chainId); if (n) return n.genesisHash || null; } catch { /* try next */ }
    }
    return null;
  }
  async function getLight() {
    if (!light || light.chainId !== status.chainId) {
      light = new ANR.LightClient({ rpc, label: status.chainId, pinnedGenesisHash: await pinnedHash(), storage: localStorage });
      await light.init();
    }
    return light;
  }
  const lookupsAllowed = () => !!store.get('auren.lookups');
  async function universal() {
    return new ANR.UniversalResolver({
      auren: [await getLight()], addressPrefix: status.addressPrefix, chainId: status.chainId,
      ensRpc: lookupsAllowed() ? store.get('auren.ensrpc') || null : null,
      fetchFn: lookupsAllowed() ? (...a) => fetch(...a) : async () => { throw new Error('third-party lookups are disabled (Names tab > Resolver settings)'); },
    });
  }
  const badge = { 'light-client': '<span class="tag live">verified by light client</span>', dnssec: '<span class="tag live">DNSSEC</span>', 'node-claim': '<span class="tag soon">unverified: node\'s word</span>', 'rpc-claim': '<span class="tag soon">unverified: provider\'s word</span>', 'dns-unsigned': '<span class="tag soon">unverified: unsigned DNS</span>' };

  /**
   * Resolve an address or a name to an address we may pay. Raw addresses pass. Names go through the universal
   * resolver: ambiguous or missing names are refused, unverified ones need your explicit confirmation.
   */
  async function resolve(input) {
    const v = input.trim().toLowerCase();
    lastResolution = null;
    if (Aur.isValidAddress(v, status.addressPrefix)) return v;
    if (!v.includes('.')) throw new Error(`Not a valid ${status.addressPrefix}1… address or a name like alice.aur`);
    const r = await (await universal()).resolve(v);
    lastResolution = r;
    const lines = r.candidates.map((c) => `${c.name} [${c.namespace}] → ${c.address}  (${c.verified})`).join('\n');
    if (r.status === 'notfound') throw new Error(`${v} did not resolve. ${r.notes.join('; ')}`);
    if (r.status === 'ambiguous') throw new Error(`${v} is AMBIGUOUS: different namespaces give different addresses:\n${lines}\nQualify it, e.g. ${v}@${status.chainId}`);
    if (!r.address) throw new Error(`${v} has no address that can receive ${status.symbol} on ${status.chainId}.\n${lines}`);
    if (r.status === 'unverified' && !confirm(`"${v}" could NOT be cryptographically verified:\n${lines}\n\nSending to an unverified name can lose funds if the answer is wrong. Continue?`)) throw new Error('Cancelled: name not verified');
    return r.address;
  }
  const resolutionRows = () => {
    const r = lastResolution; if (!r || !r.candidates.length) return '';
    const c = r.candidates.find((x) => x.address === r.address) || r.candidates[0];
    return `<tr><th>Recipient name</th><td>${esc(c.name)} <span class="muted">in namespace</span> <code>${esc(c.namespace)}</code><br>${badge[c.verified] || ''}${c.height ? ` <span class="muted">proven at block ${fmt(c.height)}</span>` : ''}</td></tr>`;
  };

  /** The core flow: build -> dry-run -> review -> sign+send -> wait. Returns the receipt or null. */
  let busy = false;
  async function transact(type, body, title, tip) {
    if (busy) { notify('Another action is waiting for confirmation. Finish or cancel it first.', 'err'); return null; }
    busy = true;
    try {
      const tx = await Aur.buildTx(rpc, key, type, body, { status, tip: tip ?? 1000n });
      const sim = await rpc.call('aur_simulate', [tx]);
      const mine = sim.effects.find((e) => e.ns === 'acct' && e.key === address);
      const delta = mine ? BigInt(mine.after.balance) - BigInt(mine.before.balance) : 0n;
      $('rvtitle').textContent = title;
      $('rvbody').innerHTML = `<table><tbody>
        <tr><th>Network</th><td>${esc(status.chainId)}</td></tr>
        <tr><th>Action</th><td>${esc(type)}</td></tr>${resolutionRows()}
        <tr><th>Fee</th><td>${formatAur(sim.fee)} AUR</td></tr>
        <tr><th>Your balance change</th><td>${delta >= 0n ? '+' : ''}${formatAur(delta)} AUR</td></tr>
        <tr><th>Check</th><td>${sim.ok ? '<span class="tag live">should go through</span>' : `<span class="tag no">will fail: ${esc(sim.code)}</span> (the fee is still charged)`}</td></tr></tbody></table>
        <p class="note">Computed by the node against current state. The final result can differ only if state changes before inclusion.</p>`;
      const dlg = $('review');
      const choice = await new Promise((resolveP) => {
        const done = () => { dlg.removeEventListener('close', done); resolveP(dlg.returnValue); };
        dlg.addEventListener('close', done);
        dlg.returnValue = 'cancel';
        dlg.showModal();
      });
      if (choice !== 'ok') return null;
      const { hash } = await rpc.call('aur_sendTx', [tx]);
      notify(`Submitted <span class="mono">${esc(short(hash, 8))}</span>, waiting for a block…`);
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        const t = await rpc.call('aur_getTx', [hash]);
        if (t && t.status === 'confirmed') {
          const ok = t.receipt && t.receipt.status === 1;
          notify(`${ok ? 'Confirmed' : 'Failed (' + esc(t.receipt.code) + ')'} in block ${fmt(t.height)} · <a href="explorer.html?tx=${hash}">${esc(short(hash, 8))}</a>`, ok ? 'ok' : 'err');
          await refreshAccount();
          return t.receipt;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      notify('Still pending after 60 s. Check the explorer.', 'err');
    } catch (e) { notify(esc(e.message), 'err'); } finally { busy = false; }
    return null;
  }

  // ------------------------------------------------------------ onboarding (one step per page)
  const wiz = (inner) => { $('app').innerHTML = '<div class="wiz"><div id="note" class="toast" hidden></div>' + inner + '</div>'; };

  function viewOnboard() {
    const canDevice = Aur.webauthnAvailable();
    wiz('<h2>' + (wallets.length ? 'Add a wallet' : 'Welcome to AUREN') + '</h2>' +
      '<p class="sub">' + (wallets.length ? 'Pick how you want to add it.' : 'Your wallet holds your AUR. It stays on this device, locked with your password.') + '</p>' +
      '<button class="choice" id="c-new"><b>Create a new wallet</b><span>New here? Start with this.</span></button>' +
      '<button class="choice" id="c-old"><b>I already have a wallet</b><span>Add it with your recovery key.</span></button>' +
      '<button class="choice" id="c-dev" ' + (canDevice ? '' : 'disabled') + '><b>Use my phone or security key</b><span>' + (canDevice ? 'Fingerprint, face, Windows Hello or a key.' : 'Not available in this browser.') + '</span></button>' +
      (wallets.length ? '<button class="linkback" id="back">← Back to unlock</button>' : ''));
    $('c-new').onclick = stepKey; $('c-old').onclick = stepImport; $('c-dev').onclick = stepDevice;
    if ($('back')) $('back').onclick = () => viewUnlock();
  }

  function stepKey() {
    const seed = Aur.randomSeedHex();
    wiz('<button class="linkback" type="button" id="back">← Back</button>' +
      '<div class="stepno">Step 1 of 2</div><h2>Save your recovery key</h2>' +
      '<p class="sub">If you forget your password or lose this device, this key is the only way back to your coins. Write it down and keep it private. You will not see it again.</p>' +
      '<pre class="seed" id="seedbox">' + seed + '</pre>' +
      '<button class="btn" type="button" id="copykey">Copy</button>' +
      '<label class="check"><input type="checkbox" id="saved"> I saved my recovery key somewhere safe</label>' +
      '<button class="btn primary big" id="next" disabled>Continue</button>');
    $('back').onclick = viewOnboard;
    $('copykey').onclick = async () => { try { await navigator.clipboard.writeText(seed); $('copykey').textContent = 'Copied'; } catch { /* select by hand */ } };
    $('saved').onchange = () => { $('next').disabled = !$('saved').checked; };
    $('next').onclick = () => stepPassword(seed);
  }

  function stepPassword(seed) {
    wiz('<button class="linkback" type="button" id="back">← Back</button>' +
      '<div class="stepno">Step 2 of 2</div><h2>Lock your wallet</h2>' +
      '<p class="sub">Choose a password. You will type it to open your wallet on this device.</p>' +
      '<form class="form" id="create">' +
      '<label for="cname">Wallet name</label><input type="text" id="cname" value="My wallet" maxlength="40" required>' +
      '<label for="cpw">Password (at least 10 characters)</label><input type="password" id="cpw" minlength="10" required autocomplete="new-password" autofocus>' +
      '<label for="cpw2">Type it again</label><input type="password" id="cpw2" minlength="10" required autocomplete="new-password">' +
      '<button class="btn primary big" type="submit">Create my wallet</button></form>');
    $('back').onclick = () => stepKey();
    $('create').onsubmit = async (e) => {
      e.preventDefault();
      if ($('cpw').value !== $('cpw2').value) return notify('The passwords do not match.', 'err');
      try { await addWallet($('cname').value.trim(), seed, $('cpw').value); } catch (err) { notify(esc(err.message), 'err'); }
    };
  }

  function stepImport() {
    wiz('<button class="linkback" type="button" id="back">← Back</button>' +
      '<h2>Add your wallet</h2><p class="sub">Paste the recovery key you saved when you made it.</p>' +
      '<form class="form" id="import">' +
      '<label for="iseed">Recovery key</label><input type="password" id="iseed" autocomplete="off" required autofocus>' +
      '<label for="iname">Wallet name</label><input type="text" id="iname" value="My wallet" maxlength="40" required>' +
      '<label for="ipw">New password for this device (at least 10 characters)</label><input type="password" id="ipw" minlength="10" required autocomplete="new-password">' +
      '<button class="btn primary big" type="submit">Add wallet</button></form>');
    $('back').onclick = viewOnboard;
    $('import').onsubmit = async (e) => {
      e.preventDefault();
      try { await addWallet($('iname').value.trim(), $('iseed').value.trim().toLowerCase(), $('ipw').value); } catch (err) { notify(esc(err.message), 'err'); }
    };
  }

  function stepDevice() {
    wiz('<button class="linkback" type="button" id="back">← Back</button>' +
      '<h2>Use your phone or security key</h2>' +
      '<p class="sub">The key stays inside your device and every payment needs your touch or face. If you lose the device you lose this wallet, so add trusted helpers in the Security tab afterwards.</p>' +
      '<form class="form" id="passkey">' +
      '<label for="pname">Wallet name</label><input type="text" id="pname" value="My device wallet" maxlength="40" required>' +
      '<button class="btn primary big" type="submit">Continue</button></form>');
    $('back').onclick = viewOnboard;
    $('passkey').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const name = $('pname').value.trim();
        const k = await Aur.createPasskey(name);
        if (wallets.some((w) => w.pub === k.pub)) throw new Error('This key is already stored in this browser');
        wallets.push({ name, kind: 'webauthn', pub: k.pub, credId: k.credId, rpId: k.rpId, scheme: 2 });
        store.set('auren.wallets', wallets);
        key = k; address = await Aur.pubToAddress(k.pub, status.addressPrefix, 2);
        note = { cls: 'ok', html: 'Device wallet created. Add trusted helpers in the Security tab so you can recover it if you lose the device.' };
        tab = 'send'; touch(); render();
      } catch (err) { notify(esc(err.message), 'err'); }
    };
  }

  async function addWallet(name, seed, password) {
    const k = await Aur.keyFromSeed(seed);
    if (wallets.some((w) => w.pub === k.pub)) throw new Error('This wallet is already stored in this browser');
    wallets.push({ name, pub: k.pub, keystore: await Aur.encryptSeed(seed, password) });
    store.set('auren.wallets', wallets);
    key = k; address = await Aur.pubToAddress(k.pub, status.addressPrefix, 0);
    note = { cls: 'ok', html: 'Wallet created and unlocked.' };
    tab = 'send'; touch(); render();
  }

  function viewUnlock() {
    const picker = wallets.length > 1
      ? '<label for="uw">Wallet</label><select id="uw">' + wallets.map((w, i) => '<option value="' + i + '">' + esc(w.name) + '</option>').join('') + '</select>'
      : '<input type="hidden" id="uw" value="0"><div class="walletname">' + esc(wallets[0].name) + '</div>';
    wiz('<h2>Welcome back</h2><p class="sub">Enter your password to open your wallet.</p>' +
      '<form class="form" id="unlock">' + picker +
      '<label for="upw" id="upwl">Password</label><input type="password" id="upw" autocomplete="current-password" autofocus>' +
      '<button class="btn primary big" type="submit">Open wallet</button></form>' +
      '<button class="linkback" type="button" id="addnew">Add another wallet</button>');
    const syncPw = () => { const w = wallets[Number($('uw').value)]; const dev = !!(w && w.kind === 'webauthn'); $('upw').hidden = dev; $('upwl').hidden = dev; };
    if ($('uw').tagName === 'SELECT') $('uw').onchange = syncPw;
    syncPw();
    $('unlock').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const w = wallets[Number($('uw').value)];
        if (w.kind === 'webauthn') key = { kind: 'webauthn', scheme: 2, credId: w.credId, rpId: w.rpId, pub: w.pub }; // the device confirms each transaction
        else key = await Aur.keyFromSeed(await Aur.decryptSeed(w.keystore, $('upw').value));
        address = await Aur.pubToAddress(key.pub, status.addressPrefix, key.scheme || 0);
        note = null; tab = 'send'; touch(); render();
      } catch (err) { notify('That password did not work.', 'err'); }
    };
    $('addnew').onclick = () => viewOnboard();
  }

  // ------------------------------------------------------------ dashboard
  const TABS = [['send', 'Send'], ['receive', 'Receive'], ['stake', 'Stake'], ['activity', 'Activity'], ['names', 'Names'], ['govern', 'Vote'], ['security', 'Security'], ['backup', 'Backup']];

  function viewDashboard() {
    const w = wallets.find((x) => x.pub === key.pub);
    const act = (id, icon, label) => '<button class="act ' + (tab === id ? 'on' : '') + '" data-tab="' + id + '"><i>' + icon + '</i>' + label + '</button>';
    $('app').innerHTML = '<div class="dash">' +
      '<div class="dash-top"><span class="walletname">' + esc(w ? w.name : 'Wallet') + '</span><button class="linkback" id="lock">Lock</button></div>' +
      '<div id="note" class="toast ' + (note ? note.cls : '') + '" ' + (note ? '' : 'hidden') + '>' + (note ? note.html : '') + '</div>' +
      '<div class="hero" id="balances"><div class="hero-label">Your balance</div><div class="hero-amt">… <span>AUR</span></div></div>' +
      '<div class="actions">' + act('send', '↑', 'Send') + act('receive', '↓', 'Receive') + act('stake', '%', 'Stake') + act('activity', '≡', 'Activity') + '</div>' +
      '<div class="tabs" role="tablist">' + TABS.slice(4).map(([id, label]) => '<button role="tab" class="tabbtn ' + (id === tab ? 'on' : '') + '" data-tab="' + id + '">' + label + '</button>').join('') + '</div>' +
      '<div id="tabbody" class="card"></div><small class="muted" id="height"></small></div>';
    $('lock').onclick = () => { key = null; address = null; note = null; render(); };
    document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; viewDashboard(); }));
    refreshAccount().then(renderTab);
  }

  function tabReceive(body) {
    body.innerHTML = '<h3 style="margin-top:0">Receive AUR</h3><p class="note">Share this address to get paid. It is safe to share.</p>' +
      '<div class="addrbox"><code id="myaddr">' + esc(address) + '</code></div>' +
      '<div class="rowbtns"><button class="btn primary" id="copyaddr">Copy address</button>' + (status.network !== 'mainnet' ? '<button class="btn" id="faucet">Get AUR from the faucet</button>' : '') + '</div>';
    $('copyaddr').onclick = async () => { try { await navigator.clipboard.writeText(address); notify('Address copied.'); } catch { notify('Select and copy the address by hand.', 'err'); } };
    if ($('faucet')) $('faucet').onclick = requestFaucet;
  }

  async function requestFaucet() {
    const u = new URL(rpc.url);
    const url = store.get('auren.faucet') || `${u.protocol}//${u.hostname}:9690`;
    try {
      const r = await fetch(url + '/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      notify(`Faucet sent ${esc(j.amount)} · <a href="explorer.html?tx=${j.hash}">${esc(short(j.hash, 8))}</a>`);
    } catch (e) { notify(`Faucet unavailable at ${esc(url)}: ${esc(e.message)}`, 'err'); }
  }

  function renderTab() {
    const body = $('tabbody');
    if (!body) return;
    ({ send: tabSend, receive: tabReceive, stake: tabStake, names: tabNames, govern: tabGovern, security: tabSecurity, activity: tabActivity, backup: tabBackup })[tab](body);
  }

  const tipInput = '<label for="tip">Extra tip (AUR, optional): pay a little more to go first when the network is busy</label><input type="text" id="tip" value="0.000001" inputmode="decimal">';
  const readTip = () => { try { return parseAur($('tip').value || '0'); } catch { throw new Error('Invalid tip'); } };

  function tabSend(body) {
    body.innerHTML = `<form class="form" id="sendf"><h3 style="margin-top:0">Send AUR</h3>
      <label for="to">Send to (address or name like alice.aur)</label><input type="text" id="to" autocomplete="off" placeholder="${esc(status.addressPrefix)}1… or alice.aur" required>
      <label for="amt">Amount (AUR)</label><input type="text" id="amt" inputmode="decimal" placeholder="0.0" required>
      ${tipInput}<button class="btn primary" type="submit">Review</button></form>`;
    $('sendf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const to = await resolve($('to').value);
        const amount = parseAur($('amt').value);
        if (amount <= 0n) throw new Error('Amount must be greater than zero');
        const r = await transact('transfer', { to, amount: amount.toString() }, `Send ${formatAur(amount)} AUR to ${short(to, 10)}`, readTip());
        if (r && r.status === 1) $('sendf').reset();
      } catch (err) { notify(esc(err.message), 'err'); }
    };
  }

  async function tabStake(body) {
    body.innerHTML = '<p class="msg">Loading validators…</p>';
    const vs = await rpc.call('aur_getValidators');
    account = await rpc.call('aur_getAccount', [address]);
    const total = vs.validators.reduce((s, v) => s + BigInt(v.power), 0n) || 1n;
    const rows = vs.validators.map((v, i) => {
      const share = Number((BigInt(v.power) * 10000n) / total) / 100;
      const st = v.tombstoned ? 'tombstoned' : v.jailed ? 'jailed' : v.active ? 'active' : 'inactive';
      return `<tr><td><input type="radio" name="val" value="${esc(v.operator)}" aria-label="select ${esc(v.moniker)}" ${i === 0 ? 'checked' : ''}></td><td>${esc(v.moniker)}<br><span class="mono muted trunc" title="${esc(v.operator)}">${esc(v.operator)}</span></td><td>${share.toFixed(1)}%</td><td>${(v.commissionBps / 100).toFixed(1)}%</td><td>${esc(st)}</td></tr>`;
    }).join('');
    const mine = account.delegations.map((d) => `<tr><td class="mono trunc" title="${esc(d.validator)}">${esc(short(d.validator, 10))}</td><td>${formatAur(d.tokens, 6)}</td><td>${formatAur(d.pendingRewards, 6)}</td>
      <td><button class="btn small" data-claim="${esc(d.validator)}">Claim</button> <button class="btn small" data-unstake="${esc(d.validator)}" data-max="${esc(d.tokens)}">Undelegate</button></td></tr>`).join('');
    const unb = account.unbonding.map((u) => `<tr><td class="mono trunc">${esc(short(u.validator, 10))}</td><td>${formatAur(u.amount, 6)}</td><td>block ${fmt(u.matureAtHeight)} (${fmt(Math.max(0, u.matureAtHeight - status.height))} blocks left)</td></tr>`).join('');
    body.innerHTML = `<h3 style="margin-top:0">Stake</h3>
      <p class="note">Staking secures the network and earns issuance. Unstaking takes ${fmt(params.unbondingBlocks)} blocks (≈ ${(params.unbondingBlocks * params.blockTimeMs / 86400000).toFixed(2)} days); during that time funds earn nothing and cannot be moved.</p>
      <div class="table-wrap"><table><thead><tr><th></th><th>Validator</th><th>Share of network</th><th>Fee cut</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="msg">No validators</td></tr>'}</tbody></table></div>
      <form class="form" id="stakef"><label for="samt">Amount to stake (AUR)</label><input type="text" id="samt" inputmode="decimal" required>${tipInput}<button class="btn primary" type="submit">Review delegation</button></form>
      <h3>Your stake</h3><div class="table-wrap"><table><thead><tr><th>Validator</th><th>Staked (AUR)</th><th>Rewards (AUR)</th><th></th></tr></thead><tbody>${mine || '<tr><td colspan="4" class="msg">Nothing staked yet</td></tr>'}</tbody></table></div>
      ${unb ? `<h3>Coming back to you</h3><div class="table-wrap"><table><thead><tr><th>Validator</th><th>Amount</th><th>Available at block</th></tr></thead><tbody>${unb}</tbody></table></div>` : ''}`;
    $('stakef').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const sel = document.querySelector('input[name=val]:checked');
        if (!sel) throw new Error('Select a validator');
        const amount = parseAur($('samt').value);
        const r = await transact('delegate', { validator: sel.value, amount: amount.toString() }, `Delegate ${formatAur(amount)} AUR`, readTip());
        if (r) tabStake(body);
      } catch (err) { notify(esc(err.message), 'err'); }
    };
    body.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = async () => { if (await transact('claim', { validator: b.dataset.claim }, 'Claim staking rewards')) tabStake(body); }));
    body.querySelectorAll('[data-unstake]').forEach((b) => (b.onclick = async () => {
      const v = prompt(`Amount to undelegate in AUR (max ${formatAur(b.dataset.max, 6)})`, formatAur(b.dataset.max, 9).replace(/,/g, ''));
      if (!v) return;
      try { if (await transact('undelegate', { validator: b.dataset.unstake, amount: parseAur(v).toString() }, `Undelegate ${v} AUR`)) tabStake(body); } catch (err) { notify(esc(err.message), 'err'); }
    }));
  }

  function priceFor(name, years) {
    const d = params.domain;
    const per = name.length === 3 ? d.price3 : name.length === 4 ? d.price4 : d.price5;
    return BigInt(per) * BigInt(years);
  }

  function tabNames(body) {
    body.innerHTML = `<h3 style="margin-top:0">Names</h3>
      <p class="note">Give your address an easy name like <code>alice.aur</code>, or a name under any TLD someone created, like <code>alice.mytld</code>. A bare name means <code>.aur</code>.</p>
      <form class="form" id="namef"><label for="nm">Name (3–63 characters: a–z, 0–9, hyphen), e.g. alice or alice.mytld</label><input type="text" id="nm" autocomplete="off" required>
      <label for="yr">Years</label><input type="text" id="yr" value="1" inputmode="numeric">
      <p id="nmstat" class="muted"></p><button class="btn primary" type="submit">Review registration</button></form>
      <h3>Name endings</h3>
      <div class="table-wrap"><table><thead><tr><th>TLD</th><th>Owner</th><th>Registration</th><th>Price</th><th>Names</th></tr></thead><tbody id="tldlist"><tr><td colspan="5" class="msg">Loading…</td></tr></tbody></table></div>
      <h3>Create your own name ending</h3>
      <p class="note">Own a whole ending, like <code>.david</code>, and let others register names under it. Creating one costs <b>${formatAur(params.tld.price)} AUR</b> (burned). You choose whether anyone can register under it, the yearly price, and what share of each registration you keep (up to ${params.tld.maxOwnerShareBps / 100}%); the rest is burned. Well-known endings like .com or .eth are not allowed.</p>
      <form class="form" id="tldf"><label for="tn">Ending (3–24 letters or digits, starting with a letter)</label><input type="text" id="tn" autocomplete="off" required placeholder="david">
      <label for="tp">Price per year for each name (AUR, 0 = free)</label><input type="text" id="tp" value="1" inputmode="decimal">
      <label for="ts">Your share of each registration (%)</label><input type="text" id="ts" value="80" inputmode="decimal">
      <label class="check"><input type="checkbox" id="to" checked> Open: anyone can register names (uncheck to keep it for yourself)</label>
      <button class="btn" type="submit">Review</button></form>
      <h3>Manage a name you own</h3>
      <form class="form" id="mgmt"><label for="mn">Name</label><input type="text" id="mn" autocomplete="off" required>
      <label for="mt">New target address, or new owner address</label><input type="text" id="mt" autocomplete="off" required>
      <button class="btn" type="submit" value="target">Set target</button> <button class="btn" type="button" id="xfer">Transfer ownership</button></form>
      <p class="note" style="margin-top:6px">Transferring a name resets its target and records to the new owner, so a sale never leaves your address behind.</p>
      <h3>Records (one name, many chains)</h3>
      <p class="note">Publish addresses for other chains and profile data under your name. Keys: <code>addr:eip155:1</code> (Ethereum), <code>addr:bip122:000000000019d6689c085ae165831e93</code> (Bitcoin), <code>text:url</code>, <code>content</code>. Leave the value empty to delete a record.</p>
      <form class="form" id="recf2"><label for="rn">Name</label><input type="text" id="rn" autocomplete="off" required>
      <label for="rk">Key</label><input type="text" id="rk" autocomplete="off" placeholder="addr:eip155:1" required>
      <label for="rv">Value (blank deletes)</label><input type="text" id="rv" autocomplete="off"><button class="btn" type="submit">Review record</button></form>
      <h3>Primary name</h3>
      <p class="note">Lets apps show <code>alice.aur</code> instead of your address. The chain only accepts a name that already points back to you, and apps must re-check that, so nobody can claim to be someone else.</p>
      <p id="primarynow" class="muted"></p>
      <form class="form" id="primf"><label for="pn">Name that points to your address</label><input type="text" id="pn" autocomplete="off"><button class="btn" type="submit">Set primary name</button> <button class="btn" type="button" id="clrprim">Clear</button></form>
      <h3>Resolver settings</h3>
      <p class="note">AUREN names are always checked on your device. Looking up <code>.eth</code> or website names asks an outside service and tells it who you are paying. This is off until you allow it.</p>
      <form class="form" id="resf"><label class="check"><input type="checkbox" id="allowl" ${lookupsAllowed() ? 'checked' : ''}> Allow third-party lookups for .eth and DNS names</label>
      <label for="ensr">Ethereum lookup address (optional)</label><input type="text" id="ensr" value="${esc(store.get('auren.ensrpc') || '')}" placeholder="https://ethereum-rpc.publicnode.com">
      <button class="btn" type="submit">Save</button></form>
      <p class="note">If two networks give the same name to different people, the wallet refuses to pay until you pick one, so you never pay the wrong person.</p>`;
    /** Price and rules for "label" (.aur) or "label.tld" (a user-created TLD). */
    const quoteName = async (n, y) => {
      const [label, tld] = n.includes('.') ? n.split('.') : [n, 'aur'];
      if (tld === 'aur') return { price: priceFor(label, y), note: 'burned' };
      const t = await rpc.call('aur_getTld', [tld]).catch(() => null);
      if (!t) return { error: `.${tld} does not exist yet. You can create it below.` };
      if (!t.open && t.owner !== address) return { error: `.${tld} is restricted: only its owner can register names.` };
      const price = t.owner === address ? 0n : BigInt(t.price) * BigInt(y);
      return { price, note: price > 0n ? `${t.ownerShareBps / 100}% goes to the .${tld} owner, the rest is burned` : 'free for the TLD owner' };
    };
    const upd = async () => {
      const n = $('nm').value.trim().toLowerCase(), y = Number($('yr').value) || 1;
      if (n.length < 3) { $('nmstat').textContent = ''; return; }
      const d = await rpc.call('aur_resolveDomain', [n]).catch(() => null);
      const q = await quoteName(n, y);
      $('nmstat').textContent = q.error ? q.error : `${d ? `Taken (owner ${short(d.owner, 8)})` : 'Available'} · ${formatAur(q.price)} AUR for ${y} year(s) (${q.note})`;
    };
    $('nm').oninput = upd; $('yr').oninput = upd;
    $('namef').onsubmit = async (e) => {
      e.preventDefault();
      const n = $('nm').value.trim().toLowerCase(), y = Number($('yr').value);
      const q = await quoteName(n, y);
      if (q.error) return notify(esc(q.error), 'err');
      if (await transact('registerDomain', { name: n, years: y }, `Register ${n.includes('.') ? n : n + '.aur'} (${formatAur(q.price)} AUR)`)) upd();
    };
    // ---- user-created TLDs ----
    $('tldf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const tld = $('tn').value.trim().toLowerCase().replace(/^\./, '');
        const share = Math.round(Number($('ts').value) * 100);
        if (await transact('registerTld', { tld, open: $('to').checked, price: parseAur($('tp').value || '0').toString(), ownerShareBps: share }, `Create the .${tld} TLD (${formatAur(params.tld.price)} AUR, burned)`)) tabNames(body);
      } catch (err) { notify(esc(err.message), 'err'); }
    };
    rpc.call('aur_getTlds').then((list) => {
      $('tldlist').innerHTML = list.map((t) => `<tr><td><b>.${esc(t.tld)}</b></td><td>${t.builtIn ? 'built in' : esc(short(t.owner, 8))}</td><td>${t.open ? 'open' : 'restricted'}</td><td>${t.price === null ? 'by length' : formatAur(t.price) + ' AUR/yr'}</td><td>${t.domains}</td></tr>`).join('');
    }).catch(() => {});
    $('mgmt').onsubmit = async (e) => {
      e.preventDefault();
      try { await transact('setDomainTarget', { name: $('mn').value.trim().toLowerCase().replace(/\.aur$/, ''), target: await resolve($('mt').value) }, 'Set name target'); } catch (err) { notify(esc(err.message), 'err'); }
    };
    $('recf2').onsubmit = async (e) => {
      e.preventDefault();
      const v = $('rv').value.trim();
      await transact('setRecord', { name: $('rn').value.trim().toLowerCase().replace(/\.aur$/, ''), key: $('rk').value.trim(), value: v === '' ? null : v }, v === '' ? 'Delete name record' : 'Set name record');
    };
    $('primf').onsubmit = async (e) => {
      e.preventDefault();
      if (await transact('setPrimary', { name: $('pn').value.trim().toLowerCase().replace(/\.aur$/, '') }, 'Set primary name')) showPrimary();
    };
    $('clrprim').onclick = async () => { if (await transact('setPrimary', { name: null }, 'Clear primary name')) showPrimary(); };
    $('resf').onsubmit = (e) => {
      e.preventDefault();
      store.set('auren.lookups', $('allowl').checked); store.set('auren.ensrpc', $('ensr').value.trim());
      notify('Resolver settings saved.');
    };
    async function showPrimary() {
      try { const r = await rpc.get(`/reverse/${address}`); $('primarynow').textContent = r.name ? `Current primary name: ${r.name}` : 'No primary name set.'; } catch { /* ignore */ }
    }
    showPrimary();
    $('xfer').onclick = async () => {
      try { await transact('transferDomain', { name: $('mn').value.trim().toLowerCase().replace(/\.aur$/, ''), newOwner: await resolve($('mt').value) }, 'Transfer name ownership'); } catch (err) { notify(esc(err.message), 'err'); }
    };
  }

  async function tabGovern(body) {
    body.innerHTML = '<p class="msg">Loading proposals…</p>';
    const r = await rpc.call('aur_getProposals');
    account = await rpc.call('aur_getAccount', [address]);
    const g = r.governance;
    const myStake = account.delegations.reduce((s, d) => s + BigInt(d.tokens), 0n);
    const pct = (a, b) => (BigInt(b) > 0n ? Number((BigInt(a) * 1000n) / BigInt(b)) / 10 : 0);
    const cards = r.proposals.map((p) => {
      const t = p.tally;
      const voted = t ? BigInt(t.yes) + BigInt(t.no) + BigInt(t.abstain) + BigInt(t.veto) : 0n;
      const changes = Object.entries(p.changes).map(([k, v]) => `<code>${esc(k)}</code> → <b>${esc(v)}</b>`).join('<br>');
      const left = p.status === 'voting' ? `${fmt(Math.max(0, p.votingEnd - status.height))} blocks of voting left` : p.status === 'passed' ? `timelock: takes effect at block ${fmt(p.executeAt)} (${fmt(Math.max(0, p.executeAt - status.height))} blocks)` : p.reason ? esc(p.reason) : '';
      const bars = t ? `<div class="bar" title="yes / no / abstain / veto"><i style="width:${pct(t.yes, voted)}%"></i></div><small class="muted">yes ${pct(t.yes, voted)}% · no ${pct(t.no, voted)}% · abstain ${pct(t.abstain, voted)}% · veto ${pct(t.veto, voted)}% · turnout ${pct(voted, t.bonded)}% of bonded stake (quorum ${g.quorumBps / 100}%)</small>` : '';
      const tag = { voting: 'soon', passed: 'live', executed: 'live', rejected: 'no', failed: 'no' }[p.status] || 'soon';
      return `<div class="card" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><b>#${p.id} ${esc(p.title)}</b><span class="tag ${tag}">${esc(p.status)}</span></div>
        <p class="note" style="margin:6px 0">${esc(p.description)}</p><p style="margin:6px 0">${changes}</p>${bars}<p class="muted" style="margin:6px 0">${left}</p>
        ${p.status === 'voting' ? `<div>${['yes', 'no', 'abstain', 'veto'].map((o) => `<button class="btn small" data-vote="${p.id}" data-opt="${o}">${o === 'veto' ? 'No with veto' : o[0].toUpperCase() + o.slice(1)}</button>`).join(' ')}</div>` : ''}</div>`;
    }).join('');
    body.innerHTML = `<h3 style="margin-top:0">Governance</h3>
      <p class="note">Proposals change protocol parameters. Your vote weighs your <b>bonded stake</b> (${formatAur(myStake, 4)} AUR). A proposal needs ${g.quorumBps / 100}% of all bonded stake to vote, more than ${g.thresholdBps / 100}% yes among yes/no/veto, and under ${g.vetoBps / 100}% veto. Voting lasts ${fmt(g.votingBlocks)} blocks, then a passed proposal waits ${fmt(g.timelockBlocks)} blocks before it takes effect. The deposit (${formatAur(g.deposit)} AUR) is returned unless the proposal fails quorum or is vetoed.</p>
      ${cards || '<p class="msg">No proposals yet.</p>'}
      <h3>Submit a proposal</h3>
      <form class="form" id="propf"><label for="pt">Title</label><input type="text" id="pt" maxlength="80" required>
      <label for="pd">Description (why, and the effect)</label><input type="text" id="pd" maxlength="1000">
      <label for="pp">Parameter</label><select id="pp">${r.govParams.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
      <label for="pv">New value</label><input type="text" id="pv" required>
      <button class="btn primary" type="submit">Review proposal</button></form>`;
    body.querySelectorAll('[data-vote]').forEach((b) => (b.onclick = async () => { if (await transact('vote', { id: Number(b.dataset.vote), option: b.dataset.opt }, `Vote "${b.dataset.opt}" on proposal #${b.dataset.vote}`)) tabGovern(body); }));
    $('propf').onsubmit = async (e) => {
      e.preventDefault();
      const raw = $('pv').value.trim();
      const value = /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && !/^(minBaseFee|domain)\./.test($('pp').value) ? Number(raw) : raw;
      if (await transact('submitProposal', { title: $('pt').value.trim(), description: $('pd').value.trim(), changes: { [$('pp').value]: value } }, `Submit proposal (deposit ${formatAur(g.deposit)} AUR)`)) tabGovern(body);
    };
  }

  function tabSecurity(body) {
    const sec = account && account.security;
    const min = params.security.minDelayBlocks;
    const cur = sec ? `<div class="table-wrap"><table><tbody>
      <tr><th>Trusted helpers</th><td>${sec.guardians.map((g) => `<div class="mono trunc" title="${esc(g)}">${esc(g)}</div>`).join('') || 'none'}</td></tr>
      <tr><th>Helpers needed to recover</th><td>${sec.threshold}</td></tr><tr><th>Waiting time for changes</th><td>${fmt(sec.delayBlocks)} blocks</td></tr>
      <tr><th>Daily limit</th><td>${sec.dailyLimit === null ? 'none' : formatAur(sec.dailyLimit) + ' AUR'}</td></tr>
      <tr><th>Change waiting</th><td>${sec.pending ? `ready at block ${fmt(sec.pending.readyAt)}` : 'none'}</td></tr>
      <tr><th>Recovery in progress</th><td>${sec.recovery ? `${sec.recovery.approvals.length}/${sec.threshold} approvals${sec.recovery.readyAt ? `, executes at block ${fmt(sec.recovery.readyAt)}` : ''}` : 'none'}</td></tr></tbody></table></div>` : '<p class="msg">No protections configured on this account.</p>';
    body.innerHTML = `<h3 style="margin-top:0">Account protection</h3>
      <p class="note">Enforced by every validator, regardless of which app signs. Tightening applies immediately; loosening is queued behind your delay, and any guardian can veto it. Recovery handles <b>lost</b> keys; against a thief holding your key, the daily limit and guardian veto cap the damage.</p>
      ${cur}
      <form class="form" id="secf"><label for="gl">Trusted helper addresses (separate with commas, up to ${params.security.maxGuardians})</label><input type="text" id="gl" value="${esc(sec ? sec.guardians.join(', ') : '')}">
      <label for="gt">How many helpers must agree to recover</label><input type="text" id="gt" value="${sec ? sec.threshold : 1}" inputmode="numeric">
      <label for="gd">Waiting time before weaker settings apply, in blocks (at least ${fmt(min)})</label><input type="text" id="gd" value="${sec ? sec.delayBlocks : min}" inputmode="numeric">
      <label for="gx">Daily send limit in AUR (blank = none)</label><input type="text" id="gx" value="${sec && sec.dailyLimit !== null ? formatAur(sec.dailyLimit).replace(/,/g, '') : ''}" inputmode="decimal">
      <button class="btn primary" type="submit">Review</button>
      ${sec && sec.pending ? '<button class="btn" type="button" id="cpend">Cancel the waiting change</button>' : ''}
      ${sec && sec.recovery ? '<button class="btn" type="button" id="crec">Cancel the recovery</button>' : ''}</form>
      <h3>Help someone recover</h3><p class="note">If you are a trusted helper for someone, approve moving their account to their new key.</p>
      <form class="form" id="recf"><label for="ra">Their account address</label><input type="text" id="ra" autocomplete="off" required>
      <label for="rp">New key for the account being recovered</label><input type="text" id="rp" autocomplete="off" required pattern="[0-9a-f]{64}|04[0-9a-f]{128}"><button class="btn" type="submit">Review approval</button></form>`;
    $('secf').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const guardians = $('gl').value.split(',').map((s) => s.trim()).filter(Boolean);
        const bodyTx = { guardians: await Promise.all(guardians.map(resolve)), threshold: Number($('gt').value), delayBlocks: Number($('gd').value), dailyLimit: $('gx').value.trim() ? parseAur($('gx').value).toString() : null };
        if (await transact('setSecurity', bodyTx, 'Update account protection')) tabSecurity(body);
      } catch (err) { notify(esc(err.message), 'err'); }
    };
    if ($('cpend')) $('cpend').onclick = () => transact('securityCancel', { account: address }, 'Cancel queued security change');
    if ($('crec')) $('crec').onclick = () => transact('recoveryCancel', {}, 'Cancel the recovery');
    $('recf').onsubmit = async (e) => { e.preventDefault(); try { const np = $('rp').value.trim(); await transact('recoveryApprove', { account: await resolve($('ra').value), newPub: np, ...(np.length === 130 ? { newScheme: 2 } : {}) }, 'Approve account recovery'); } catch (err) { notify(esc(err.message), 'err'); } };
  }

  const typeLabel = { transfer: 'Transfer', delegate: 'Delegate', undelegate: 'Undelegate', claim: 'Claim rewards', createValidator: 'Create validator', registerDomain: 'Register name', setSecurity: 'Security update' };
  async function tabActivity(body) {
    body.innerHTML = '<p class="msg">Loading…</p>';
    let rows = [];
    try { rows = await rpc.get(`/account/${address}/txs?limit=30`); } catch (e) { body.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; return; }
    body.innerHTML = `<h3 style="margin-top:0">Activity</h3><div class="table-wrap"><table><thead><tr><th>Block</th><th>Type</th><th>Details</th><th>Result</th><th>Fee</th></tr></thead><tbody>${rows.map((t) => {
      const out = t.from === address;
      const detail = t.type === 'transfer' ? `${out ? 'to' : 'from'} <span class="mono">${esc(short(out ? t.body.to : t.from, 8))}</span> · ${out ? '−' : '+'}${formatAur(t.body.amount, 6)} AUR` : Object.entries(t.body).map(([k, v]) => `${esc(k)}: <span class="mono">${esc(/^(amount|dailyLimit)$/.test(k) && v !== null ? formatAur(v, 6) + ' AUR' : short(String(v), 10))}</span>`).join(' · ');
      return `<tr><td><a href="explorer.html?tx=${t.hash}">${fmt(t.height)}</a></td><td>${esc(typeLabel[t.type] || t.type)}</td><td>${detail}</td><td>${t.status === 1 ? '<span class="tag live">ok</span>' : `<span class="tag no">${esc(t.code)}</span>`}</td><td>${out && t.fee ? formatAur(t.fee, 6) : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="msg">No transactions yet</td></tr>'}</tbody></table></div>`;
  }

  function tabBackup(body) {
    const w = wallets.find((x) => x.pub === key.pub);
    if (w.kind === 'webauthn') {
      body.innerHTML = `<h3 style="margin-top:0">Hardware key</h3>
        <p>Your device key (public part):</p><p><code class="trunc" style="max-width:100%">${esc(key.pub)}</code></p>
        <p class="note">There is no recovery key to save: the key lives only inside your device. If you lose the device, only the trusted helpers you set in the Security tab can recover your coins. This wallet works only at <b>${esc(w.rpId)}</b>.</p>
        <form class="form" id="delf"><label for="dt">Remove this wallet from this browser (type DELETE; funds stay on-chain, only the local record is removed)</label><input type="text" id="dt" autocomplete="off"><button class="btn" type="submit" style="border-color:var(--bad);color:var(--bad)">Remove wallet</button></form>`;
      $('delf').onsubmit = (e) => { e.preventDefault(); if ($('dt').value !== 'DELETE') return notify('Type DELETE exactly to confirm.', 'err'); wallets = wallets.filter((x) => x.pub !== key.pub); store.set('auren.wallets', wallets); key = null; address = null; note = null; render(); };
      return;
    }
    body.innerHTML = `<h3 style="margin-top:0">Backup &amp; keys</h3>
      <p>Public key: <code class="trunc" style="max-width:100%">${esc(key.pub)}</code></p>
      <form class="form" id="revf"><label for="rpw">Password</label><input type="password" id="rpw" required autocomplete="current-password"><button class="btn" type="submit">Show recovery key</button></form>
      <pre class="seed" id="seedout" hidden></pre>
      <p><button class="btn" id="exp">Download encrypted keystore (JSON)</button></p>
      <h3>Remove wallet from this browser</h3><p class="note">Without your saved recovery key, this removes access to your coins for good.</p>
      <form class="form" id="delf"><label for="dt">Type DELETE to confirm</label><input type="text" id="dt" autocomplete="off"><button class="btn" type="submit" style="border-color:var(--bad);color:var(--bad)">Delete wallet</button></form>`;
    $('revf').onsubmit = async (e) => {
      e.preventDefault();
      try { const s = await Aur.decryptSeed(w.keystore, $('rpw').value); $('seedout').textContent = s; $('seedout').hidden = false; } catch (err) { notify(esc(err.message), 'err'); }
    };
    $('exp').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify({ name: w.name, pub: w.pub, ...w.keystore }, null, 2)], { type: 'application/json' }));
      a.download = `auren-${w.name.replace(/\W+/g, '_')}.json`; a.click();
    };
    $('delf').onsubmit = (e) => {
      e.preventDefault();
      if ($('dt').value !== 'DELETE') return notify('Type DELETE exactly to confirm.', 'err');
      wallets = wallets.filter((x) => x.pub !== key.pub); store.set('auren.wallets', wallets); key = null; address = null; note = null; render();
    };
  }

  // ------------------------------------------------------------ entry
  function render() {
    if (!status) { $('app').innerHTML = `<div class="card"><p class="msg err">Can't connect to the network. Check your internet connection, then pick a network above and press Connect.</p></div>`; return; }
    if (key) return viewDashboard();
    return wallets.length ? viewUnlock() : viewOnboard();
  }

  $('rvcancel').onclick = () => $('review').close('cancel');
  Aur.initNetPicker($('net'), $('rpc'), $('rpcform'));
  $('rpcform').addEventListener('submit', (e) => { e.preventDefault(); key = null; connect($('rpc').value.trim().replace(/\/$/, '')); });
  Aur.detectRpc(store.get('auren.rpc')).then((u) => { $('rpc').value = u; connect(u); if ($('net').syncPicker) $('net').syncPicker(); });
})();

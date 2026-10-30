'use strict';
// Multi-node integration test: 4 validators + a late-joining full node, talking over real HTTP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AurenNode } = require('../src/node');
const { makeTestChain, mkTx } = require('../src/devkit');
const { AUR } = require('../src/util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error(`timed out waiting for ${what}`);
}
const rpc = async (url, method, params = []) => {
  const r = await fetch(url + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.data });
  return j.result;
};

test('4-validator network: blocks, tx gossip, fault tolerance, restart, late sync', { timeout: 120000 }, async () => {
  const params = { blockTimeMs: 200, roundTimeoutMs: 1500, unbondingBlocks: 5 };
  const { validators, accts, genesis, chain: tmpl } = makeTestChain({ n: 4, params });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-net-'));
  const base = 21000 + Math.floor(Math.random() * 3000);
  const urls = validators.map((_, i) => `http://127.0.0.1:${base + i}`);
  const mk = (i) => new AurenNode({
    home: path.join(root, `n${i}`), genesis,
    config: { moniker: `n${i}`, rpcPort: base + i, selfUrl: urls[i], ...(i === 0 ? { webRoot: path.join(__dirname, '..', 'website') } : {}), peers: urls.filter((_, j) => j !== i), operator: validators[i].address, quiet: true },
    consensusKey: validators[i].cons,
  });
  const nodes = validators.map((_, i) => mk(i));
  try {
    for (const n of nodes) await n.start();
    const heights = () => nodes.filter((n) => n.running).map((n) => n.chain.height);

    // 1. blocks are produced and every node agrees
    await waitFor(() => Math.min(...heights()) >= 4, 20000, 'height 4');
    const h = Math.min(...heights());
    const hashes = new Set(nodes.map((n) => n.chain.getBlock(h).hash));
    assert.equal(hashes.size, 1, 'all nodes have the same block at the common height');

    // 2. a transaction submitted to one node reaches a block everywhere
    const tx = mkTx(tmpl, accts.alice, 'transfer', { to: accts.bob.address, amount: (25n * AUR).toString() });
    const sent = await rpc(urls[3], 'aur_sendTx', [tx]);
    await waitFor(async () => (await rpc(urls[0], 'aur_getTx', [sent.hash]))?.status === 'confirmed', 15000, 'tx confirmation');
    const bob = await rpc(urls[1], 'aur_getAccount', [accts.bob.address]);
    assert.equal(BigInt(bob.balance), 1000000n * AUR + 25n * AUR);
    const sim = await rpc(urls[0], 'aur_simulate', [mkTx(tmpl, accts.alice, 'transfer', { to: accts.bob.address, amount: '1' }, { nonce: 1 })]);
    assert.equal(sim.ok, true);

    // 2b. the address index and node-hosted website work
    const hist = await (await fetch(`${urls[0]}/account/${accts.alice.address}/txs`)).json();
    assert.equal(hist[0].hash, sent.hash);
    assert.equal(hist[0].type, 'transfer');
    assert.equal(hist[0].status, 1);
    const bobHist = await (await fetch(`${urls[0]}/account/${accts.bob.address}/txs`)).json();
    assert.equal(bobHist[0].hash, sent.hash, 'recipient history includes incoming transfer');
    assert.match(await (await fetch(`${urls[0]}/wallet.html`)).text(), /AUREN Wallet/);
    assert.equal((await fetch(`${urls[0]}/%2e%2e%2fpackage.json`)).status, 404, 'no path traversal');

    // 2c. a name registered through a live node is resolvable and verified by a light client over HTTP
    const reg = await rpc(urls[1], 'aur_sendTx', [mkTx(tmpl, accts.alice, 'registerDomain', { name: 'netalice', years: 1 }, { nonce: 1 })]);
    await waitFor(async () => (await rpc(urls[0], 'aur_getTx', [reg.hash]))?.status === 'confirmed', 15000, 'name registration');
    const ANR = require('../website/anr.js'), Aur = require('../website/aurlib.js'), { canon, sha256hex } = require('../src/util');
    const lc = new ANR.LightClient({ rpc: new Aur.Rpc(urls[2]), pinnedGenesisHash: sha256hex(canon(genesis)) });
    const res = await lc.resolve('netalice.aur');
    assert.equal(res.found, true);
    assert.equal(res.verified, true, res.reason);
    assert.equal(res.resp.target, accts.alice.address);
    assert.equal((await (await fetch(`${urls[0]}/reverse/${accts.alice.address}`)).json()).name, null, 'no primary name was set');

    // 2d. scanner endpoints: recent transactions, rich list, lookup by Ethereum-style address
    const recent = await (await fetch(`${urls[0]}/txs?limit=5`)).json();
    assert.ok(recent.txs.length >= 2, 'recent transactions listed');
    assert.ok(recent.txs.every((t, i, a) => i === 0 || t.height <= a[i - 1].height), 'newest first');
    assert.ok(recent.txs.some((t) => t.hash === sent.hash && t.status === 1));
    const rich = await (await fetch(`${urls[0]}/richlist?limit=3`)).json();
    assert.equal(rich.accounts.length, 3);
    assert.ok(BigInt(rich.accounts[0].balance) >= BigInt(rich.accounts[1].balance) && rich.accounts[0].rank === 1);
    const hexAcct = await (await fetch(`${urls[0]}/account/0x${require('../src/evm/host').hexOf(accts.alice.address, 'daur')}`)).json();
    assert.equal(hexAcct.address, accts.alice.address);
    assert.equal(hexAcct.evm.isContract, false);

    // 3. one validator down (3/4 = 75% > 2/3): the chain keeps finalizing
    await nodes[3].stop();
    const h3 = nodes[0].chain.height;
    await waitFor(() => nodes[0].chain.height >= h3 + 3, 25000, '3 more blocks with one node down');

    // 4. two validators down (50% < 2/3): finality halts rather than risk safety
    await nodes[2].stop();
    await sleep(500);
    const hh = nodes[0].chain.height;
    await sleep(3500);
    assert.ok(nodes[0].chain.height <= hh + 1, 'no progress without a 2/3 quorum');

    // 5. restarting a validator restores liveness (state is replayed from its own block log)
    nodes[2] = mk(2);
    await nodes[2].start();
    await waitFor(() => nodes[0].chain.height >= hh + 3, 30000, 'recovery after restart');
    assert.equal(nodes[2].chain.height >= hh, true);

    // 6. a brand-new full node syncs from peers and reaches the identical state
    const full = new AurenNode({ home: path.join(root, 'full'), genesis, config: { moniker: 'full', rpcPort: base + 9, selfUrl: `http://127.0.0.1:${base + 9}`, peers: [urls[0]], quiet: true } });
    await full.start();
    await waitFor(() => full.chain.height >= nodes[0].chain.height - 1, 25000, 'full node sync');
    const common = Math.min(full.chain.height, nodes[0].chain.height);
    assert.equal(full.chain.getBlock(common).header.stateRoot, nodes[0].chain.getBlock(common).header.stateRoot);
    assert.equal(full.chain.getBlock(common).hash, nodes[0].chain.getBlock(common).hash);
    await full.stop();

    // 7. safety: nobody ever committed two different blocks at one height
    const final = Math.min(nodes[0].chain.height, nodes[1].chain.height, nodes[2].chain.height);
    for (let x = 1; x <= final; x++) {
      assert.equal(nodes[0].chain.getBlock(x).hash, nodes[1].chain.getBlock(x).hash);
      assert.equal(nodes[0].chain.getBlock(x).hash, nodes[2].chain.getBlock(x).hash);
    }
  } finally {
    for (const n of nodes) if (n.running) await n.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

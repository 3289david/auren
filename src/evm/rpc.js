'use strict';
// Ethereum-compatible JSON-RPC (eth_*, net_*, web3_*) served next to the native aur_* methods.
// Implemented: what wallets and developer tools need to connect, deploy, call, and read receipts/logs.
// Not implemented: pending-transaction filters, subscriptions (eth_subscribe), debug_*/trace_*, access lists.
const { ChainBackend, dryRun, hexOf, gasPriceWei, WEI, ZERO } = require('./host');
const { envelopeFromRaw, parseRaw } = require('./ethtx');
const { keccak256 } = require('./keccak');
const { txHash } = require('../tx');

const hx = (n) => '0x' + BigInt(n).toString(16);
const pad32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const err = (code, message, data) => Object.assign(new Error(message), { code, data });
const addr = (a) => { const s = String(a || '').toLowerCase().replace(/^0x/, ''); if (!/^[0-9a-f]{40}$/.test(s)) throw err(-32602, 'invalid address'); return s; };

function ethMethods(node) {
  const chain = () => node.chain;
  const backend = () => new ChainBackend(chain().state, chain().params);
  const envNow = () => { const c = chain(); return { state: c.state, params: c.params, height: c.height + 1, baseFee: c.baseFee, time: Date.now(), proposer: c.activeSet[0].operator, blockHashAt: (n) => c.getBlock(n)?.hash, blockAt: (n) => c.getBlock(n) }; };
  const gasPriceSparks = () => { const f = chain().baseFee; return f.compute + (f.state + 999n) / 1000n + (f.state + 20999n) / 21000n; };
  const blockNo = (tag) => (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized' ? chain().height : tag === 'earliest' ? 0 : Number(BigInt(tag)));

  const nativeOf = (ethHash) => node.ethHashes.get(String(ethHash).toLowerCase()) || String(ethHash).toLowerCase().replace(/^0x/, '');
  const ethHashOf = (tx, h) => (tx.scheme === 4 ? '0x' + keccak256(Buffer.from(tx.sig.raw.replace(/^0x/, ''), 'hex')).toString('hex') : '0x' + h);
  const fromHex = (tx) => hexOf(tx.from, chain().params.addressPrefix);

  function receiptObj(r) {
    const c = chain(), block = c.getBlock(r.height), tx = block.txs[r.index];
    const evm = r.evm, logs = (evm ? evm.logs : []).map((l, i) => ({
      address: '0x' + l.address, topics: l.topics.map((t) => '0x' + t), data: '0x' + l.data, blockNumber: hx(r.height), blockHash: '0x' + block.hash,
      transactionHash: ethHashOf(tx, r.hash), transactionIndex: hx(r.index), logIndex: hx(i), removed: false,
    }));
    return {
      transactionHash: ethHashOf(tx, r.hash), transactionIndex: hx(r.index), blockHash: '0x' + block.hash, blockNumber: hx(r.height),
      from: '0x' + fromHex(tx), to: tx.type === 'evm' && tx.body.to ? '0x' + tx.body.to : null,
      cumulativeGasUsed: hx(evm ? evm.gasUsed : 21000), gasUsed: hx(evm ? evm.gasUsed : 21000),
      contractAddress: evm && evm.contractAddress ? '0x' + evm.contractAddress : null, logs, logsBloom: '0x' + '00'.repeat(256),
      status: r.status === 1 ? '0x1' : '0x0', effectiveGasPrice: hx(gasPriceWei(parseFeeOf(block))), type: '0x2',
    };
  }
  const parseFeeOf = (block) => ({ compute: BigInt(block.header.baseFee.compute), state: BigInt(block.header.baseFee.state) });

  function txObj(h, index, block) {
    const tx = block.txs[index], native = txHash(tx), ev = tx.type === 'evm';
    return {
      hash: ethHashOf(tx, native), nonce: hx(tx.nonce), blockHash: '0x' + block.hash, blockNumber: hx(block.header.height), transactionIndex: hx(index),
      from: '0x' + fromHex(tx), to: ev && tx.body.to ? '0x' + tx.body.to : null, value: hx(ev ? BigInt(tx.body.value) : tx.body.amount ? BigInt(tx.body.amount) * WEI : 0n),
      gas: hx(ev ? tx.body.gasLimit : 21000), gasPrice: hx(gasPriceWei(parseFeeOf(block))), input: '0x' + (ev ? tx.body.data : ''), type: '0x2', chainId: hx(chain().params.evmChainId), v: '0x0', r: '0x0', s: '0x0',
    };
  }

  function blockObj(height, full) {
    const c = chain(), b = c.getBlock(height);
    if (!b) return null;
    return {
      number: hx(height), hash: '0x' + b.hash, parentHash: '0x' + b.header.prevHash, nonce: '0x0000000000000000', sha3Uncles: '0x' + '00'.repeat(32), logsBloom: '0x' + '00'.repeat(256),
      transactionsRoot: '0x' + b.header.txRoot, stateRoot: '0x' + b.header.stateRoot, receiptsRoot: '0x' + b.header.receiptsRoot, miner: '0x' + hexOf(b.header.proposer, c.params.addressPrefix),
      difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: hx(c.params.limits.compute), gasUsed: hx(b.header.used.compute), timestamp: hx(Math.floor(b.header.time / 1000)),
      baseFeePerGas: hx(gasPriceWei(parseFeeOf(b))), mixHash: '0x' + '00'.repeat(32), uncles: [],
      transactions: b.txs.map((tx, i) => (full ? txObj(height, i, b) : ethHashOf(tx, txHash(tx)))),
    };
  }

  function callArgs(o) {
    const c = chain();
    const gas = o.gas ? Math.min(Number(BigInt(o.gas)), c.params.limits.compute) : c.params.limits.compute;
    return { from: o.from ? addr(o.from) : ZERO, to: o.to ? addr(o.to) : null, data: String(o.data || o.input || '').replace(/^0x/, ''), value: o.value ? BigInt(o.value) : 0n, gas };
  }

  return {
    web3_clientVersion: () => 'AUREN/0.5.0/evm-shanghai',
    net_version: () => String(chain().params.evmChainId),
    net_listening: () => true,
    net_peerCount: () => hx(node.peers.size),
    eth_chainId: () => hx(chain().params.evmChainId),
    eth_blockNumber: () => hx(chain().height),
    eth_syncing: () => false,
    eth_accounts: () => [],
    eth_mining: () => false,
    eth_protocolVersion: () => '0x41',
    eth_gasPrice: () => hx(gasPriceSparks() * WEI),
    eth_maxPriorityFeePerGas: () => hx(WEI),
    eth_getBalance: ([a]) => hx((backend().account(addr(a)) || { balance: 0n }).balance),
    eth_getTransactionCount: ([a, tag]) => {
      const be = backend(), key = be.acctKey(addr(a)), acct = chain().state.get('acct', key);
      return hx(tag === 'pending' ? node.mempool.pendingNonce(key) : acct ? acct.nonce : 0);
    },
    eth_getCode: ([a]) => { const acct = backend().account(addr(a)); return '0x' + (acct ? acct.code.toString('hex') : ''); },
    eth_getStorageAt: ([a, slot]) => pad32(backend().storage(addr(a), BigInt(slot))),
    eth_call: ([o]) => {
      const r = dryRun(envNow(), callArgs(o));
      if (r.invalid) throw err(-32000, 'intrinsic gas too low');
      if (!r.success) throw err(3, 'execution reverted', '0x' + Buffer.from(r.returnData).toString('hex'));
      return '0x' + Buffer.from(r.returnData).toString('hex');
    },
    eth_estimateGas: ([o]) => {
      const a = callArgs(o), r = dryRun(envNow(), a);
      if (r.invalid) throw err(-32000, 'intrinsic gas too low');
      if (!r.success) throw err(3, 'execution reverted', '0x' + Buffer.from(r.returnData).toString('hex'));
      return hx(Math.min(chain().params.limits.compute, Math.max(21000, r.gasUsed + Math.ceil(r.gasUsed / 5))));
    },
    eth_feeHistory: ([count, newest]) => {
      const n = Math.min(Number(BigInt(count)), 64), top = blockNo(newest), fees = [], ratio = [];
      const from = Math.max(1, top - n + 1);
      for (let h = from; h <= top; h++) { const b = chain().getBlock(h); fees.push(hx(gasPriceWei(parseFeeOf(b)))); ratio.push(Number(b.header.used.compute) / chain().params.limits.compute); }
      fees.push(hx(gasPriceWei(chain().baseFee)));
      return { oldestBlock: hx(from), baseFeePerGas: fees, gasUsedRatio: ratio, reward: ratio.map(() => [hx(WEI)]) };
    },
    eth_sendRawTransaction: async ([raw]) => {
      let env;
      try { env = envelopeFromRaw(raw, chain().params, chain().chainId); } catch (e) { throw err(-32000, e.message); }
      const { hash } = await node.onTx(env);
      const eth = parseRaw(raw).hash;
      node.ethHashes.set(eth, hash);
      return eth;
    },
    eth_getTransactionReceipt: ([h]) => { const r = node.receipts.get(nativeOf(h)); return r ? receiptObj(r) : null; },
    eth_getTransactionByHash: ([h]) => {
      const native = nativeOf(h), idx = chain().txIndex.get(native);
      if (idx) return txObj(idx.height, idx.index, chain().getBlock(idx.height));
      return null;
    },
    eth_getBlockByNumber: ([tag, full]) => blockObj(blockNo(tag), !!full),
    eth_getBlockByHash: ([hash, full]) => { const x = String(hash).replace(/^0x/, ''); for (let h = chain().height; h > 0 && h > chain().height - 2000; h--) if (chain().getBlock(h).hash === x) return blockObj(h, !!full); return null; },
    eth_getLogs: ([f]) => {
      const from = blockNo(f.fromBlock ?? 'latest'), to = blockNo(f.toBlock ?? 'latest');
      if (to - from > 2000) throw err(-32005, 'block range too large (max 2000)');
      const addrs = f.address ? [].concat(f.address).map(addr) : null;
      const out = [];
      for (let h = Math.max(1, from); h <= Math.min(to, chain().height); h++) {
        const b = chain().getBlock(h);
        b.txs.forEach((tx, i) => {
          const r = node.receipts.get(txHash(tx));
          if (!r || !r.evm || r.status !== 1) return;
          r.evm.logs.forEach((l, li) => {
            if (addrs && !addrs.includes(l.address)) return;
            if (f.topics && f.topics.some((t, k) => t && (Array.isArray(t) ? !t.some((x) => x.replace(/^0x/, '') === l.topics[k]) : t.replace(/^0x/, '') !== l.topics[k]))) return;
            out.push({ address: '0x' + l.address, topics: l.topics.map((t) => '0x' + t), data: '0x' + l.data, blockNumber: hx(h), blockHash: '0x' + b.hash, transactionHash: ethHashOf(tx, r.hash), transactionIndex: hx(i), logIndex: hx(li), removed: false });
          });
        });
      }
      return out;
    },
  };
}

module.exports = { ethMethods };

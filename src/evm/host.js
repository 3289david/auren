'use strict';
// Glue between the chain state and the EVM.
//   EVM address (20 bytes)  <->  chain account: an account's EVM address is the 20-byte hash inside its bech32 address.
//   'eaddr'  hex40 -> bech32 key     (registered when an account first sends an EVM tx, or a contract is created)
//   'ecode'  hex40 -> code hex       'estor'  `${hex40}:${slot64}` -> value hex (non-zero only)
//   Contract accounts use address scheme 3; 1 spark (the chain's unit) = 1e9 wei so contracts see 18-decimal values.
const { bech32Encode, convertBits, decodeAddress } = require('../address');
const { EvmState, EMPTY } = require('./state');
const { VM, runTransaction } = require('./vm');

const WEI = 1000000000n;
const ZERO = '0'.repeat(40);
const keyFromHex = (hex40, scheme, hrp) => bech32Encode(hrp, convertBits([scheme, ...Buffer.from(hex40, 'hex')], 8, 5, true));
const hexOf = (addr, hrp) => decodeAddress(addr, hrp).hash;
const slotKey = (addr, slot) => `${addr}:${slot.toString(16).padStart(64, '0')}`;

class ChainBackend {
  constructor(state, params) { this.state = state; this.hrp = params.addressPrefix; }
  /** Which chain account owns an EVM address: registered mapping first, then whichever address scheme already has an account. */
  acctKey(hex) {
    const m = this.state.get('eaddr', hex);
    if (m) return m;
    for (const scheme of [4, 0, 2, 3]) { const k = keyFromHex(hex, scheme, this.hrp); if (this.state.has('acct', k)) return k; }
    return keyFromHex(hex, 0, this.hrp);
  }
  account(hex) {
    const a = this.state.get('acct', this.acctKey(hex));
    const code = this.state.get('ecode', hex);
    if (!a && !code) return null;
    return { balance: (a ? a.balance : 0n) * WEI, nonce: a ? a.nonce : 0, code: code ? Buffer.from(code, 'hex') : EMPTY };
  }
  storage(hex, slot) { const v = this.state.get('estor', slotKey(hex, slot)); return v ? BigInt('0x' + v) : 0n; }
}

/** Write an EVM execution's changes back into chain state. */
function flush(state, evm, backend, senderHex) {
  for (const ch of evm.changes()) {
    let key = backend.acctKey(ch.addr);
    if (evm.created.has(ch.addr)) { key = keyFromHex(ch.addr, 3, backend.hrp); state.set('eaddr', ch.addr, key); }
    const clearStorage = () => { for (const [k] of state.entries('estor')) if (k.startsWith(ch.addr + ':')) state.del('estor', k); };
    if (ch.destroyed) { clearStorage(); state.del('ecode', ch.addr); state.del('acct', key); state.del('eaddr', ch.addr); continue; }
    if (ch.cleared) clearStorage();
    if (ch.balance % WEI !== 0n) throw new Error('EVM balance not a multiple of the native unit');
    const existing = state.get('acct', key);
    if (existing || ch.balance > 0n || ch.nonce > 0 || ch.code.length) {
      const a = existing || { balance: 0n, nonce: 0 };
      a.balance = ch.balance / WEI;
      if (ch.addr !== senderHex) a.nonce = ch.nonce; // the sender's nonce is owned by the native transaction layer
      state.set('acct', key, a);
    }
    if (ch.code.length) state.set('ecode', ch.addr, Buffer.from(ch.code).toString('hex')); else if (state.has('ecode', ch.addr)) state.del('ecode', ch.addr);
    for (const [slot, v] of ch.storage) { const k = slotKey(ch.addr, slot); if (v === 0n) state.del('estor', k); else state.set('estor', k, v.toString(16)); }
  }
}

/** Gas price in wei that matches what a gas unit really costs here (compute price + the state reservation per gas). */
const gasPriceWei = (baseFee) => (baseFee.compute * 1000n + baseFee.state) * 1000000n;

function blockCtx(env, params) {
  return {
    coinbase: env.proposer ? hexOf(env.proposer, params.addressPrefix) : ZERO,
    timestamp: Math.floor((env.time || 0) / 1000), number: env.height, prevrandao: 0n, gasLimit: params.limits.compute,
    chainId: params.evmChainId, baseFee: gasPriceWei(env.baseFee), valueUnit: WEI,
    blockhash: (n) => { const h = Number(n); if (!env.blockHashAt || h >= env.height || h < env.height - 256) return 0n; const x = env.blockHashAt(h); return x ? BigInt('0x' + x) : 0n; },
  };
}

/** Execute one EVM transaction on `state` (writes back on success). Returns the outcome and the sender's EVM address. */
function runEvm(env, tx, { commit = true } = {}) {
  const { state, params } = env;
  const backend = new ChainBackend(state, params);
  const senderHex = hexOf(tx.from, params.addressPrefix);
  const evm = new EvmState(backend);
  const vm = new VM(evm, { ...blockCtx(env, params), origin: senderHex, gasPrice: gasPriceWei(env.baseFee) });
  const b = tx.body;
  state.set('eaddr', senderHex, tx.from);
  const out = runTransaction(vm, { from: senderHex, to: b.to, value: BigInt(b.value), data: Buffer.from(b.data, 'hex'), gasLimit: b.gasLimit, nonce: tx.nonce, accessList: [] });
  if (out.success && commit) flush(state, evm, backend, senderHex);
  return { ...out, senderHex };
}

/** Read-only call for eth_call / eth_estimateGas: never writes. */
function dryRun(env, { from, to, data, value = 0n, gas }) {
  const fork = env.state.fork();
  const e = { ...env, state: fork };
  const backend = new ChainBackend(fork, env.params);
  const evm = new EvmState(backend);
  const fromHex = from || ZERO;
  const vm = new VM(evm, { ...blockCtx(e, env.params), origin: fromHex, gasPrice: gasPriceWei(env.baseFee) });
  const fromBal = backend.account(fromHex)?.balance ?? 0n;
  if (value > fromBal) return { success: false, gasUsed: 0, returnData: EMPTY, error: 'insufficient funds for value' };
  return runTransaction(vm, { from: fromHex, to: to || null, value, data: Buffer.from(data || '', 'hex'), gasLimit: gas, nonce: backend.account(fromHex)?.nonce ?? 0, accessList: [] });
}

module.exports = { WEI, ZERO, ChainBackend, runEvm, dryRun, hexOf, keyFromHex, gasPriceWei, slotKey };

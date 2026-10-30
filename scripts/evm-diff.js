// Differential tester: this repo's EVM vs the reference @ethereumjs/evm (Shanghai).
// Not a project dependency. Run in a scratch folder:  npm i --no-save @ethereumjs/evm@3 @ethereumjs/common@4 @ethereumjs/util@9 @ethereumjs/statemanager@2
//   N=5000 SEED=1 node scripts/evm-diff.js        (GOLDEN=file.json also writes a fixture for test/evm.test.js)
﻿// Differential tester: my EVM (src/evm) vs the reference @ethereumjs/evm on Shanghai rules.
const R = require('path').join(__dirname, '..', 'src', 'evm') + '/';
const { VM, EvmState } = require(R + 'vm.js');
const { EVM } = require('@ethereumjs/evm');
const { Common, Hardfork, Chain } = require('@ethereumjs/common');
const Mainnet = Chain.Mainnet;
const { Address, hexToBytes, bytesToHex, setLengthLeft, bigIntToBytes, bytesToBigInt } = require('@ethereumjs/util');
const { DefaultStateManager } = require('@ethereumjs/statemanager');

// ---------- assembler ----------
const OPS = { STOP: 0, ADD: 1, MUL: 2, SUB: 3, DIV: 4, SDIV: 5, MOD: 6, SMOD: 7, ADDMOD: 8, MULMOD: 9, EXP: 10, SIGNEXTEND: 11, LT: 16, GT: 17, SLT: 18, SGT: 19, EQ: 20, ISZERO: 21, AND: 22, OR: 23, XOR: 24, NOT: 25, BYTE: 26, SHL: 27, SHR: 28, SAR: 29, SHA3: 32, ADDRESS: 48, BALANCE: 49, ORIGIN: 50, CALLER: 51, CALLVALUE: 52, CALLDATALOAD: 53, CALLDATASIZE: 54, CALLDATACOPY: 55, CODESIZE: 56, CODECOPY: 57, GASPRICE: 58, EXTCODESIZE: 59, EXTCODECOPY: 60, RETURNDATASIZE: 61, RETURNDATACOPY: 62, EXTCODEHASH: 63, COINBASE: 65, TIMESTAMP: 66, NUMBER: 67, GASLIMIT: 69, CHAINID: 70, SELFBALANCE: 71, BASEFEE: 72, POP: 80, MLOAD: 81, MSTORE: 82, MSTORE8: 83, SLOAD: 84, SSTORE: 85, JUMP: 86, JUMPI: 87, PC: 88, MSIZE: 89, GAS: 90, JUMPDEST: 91, PUSH0: 95, LOG0: 160, LOG1: 161, LOG2: 162, LOG3: 163, LOG4: 164, CREATE: 240, CALL: 241, CALLCODE: 242, RETURN: 243, DELEGATECALL: 244, CREATE2: 245, STATICCALL: 250, REVERT: 253, INVALID: 254, SELFDESTRUCT: 255 };
const POPS = { ADD: 2, MUL: 2, SUB: 2, DIV: 2, SDIV: 2, MOD: 2, SMOD: 2, ADDMOD: 3, MULMOD: 3, EXP: 2, SIGNEXTEND: 2, LT: 2, GT: 2, SLT: 2, SGT: 2, EQ: 2, ISZERO: 1, AND: 2, OR: 2, XOR: 2, NOT: 1, BYTE: 2, SHL: 2, SHR: 2, SAR: 2, SHA3: 2, ADDRESS: 0, BALANCE: 1, ORIGIN: 0, CALLER: 0, CALLVALUE: 0, CALLDATALOAD: 1, CALLDATASIZE: 0, CALLDATACOPY: 3, CODESIZE: 0, CODECOPY: 3, GASPRICE: 0, EXTCODESIZE: 1, EXTCODECOPY: 4, RETURNDATASIZE: 0, RETURNDATACOPY: 3, EXTCODEHASH: 1, SELFBALANCE: 0, POP: 1, MLOAD: 1, MSTORE: 2, MSTORE8: 2, SLOAD: 1, SSTORE: 2, PC: 0, MSIZE: 0, GAS: 0, LOG0: 2, LOG1: 3, LOG2: 4, LOG3: 5, LOG4: 6, CREATE: 3, CALL: 7, CALLCODE: 7, DELEGATECALL: 6, CREATE2: 4, STATICCALL: 6, RETURN: 2, REVERT: 2, SELFDESTRUCT: 1, TIMESTAMP: 0, NUMBER: 0, GASLIMIT: 0, CHAINID: 0, BASEFEE: 0, COINBASE: 0 };
const PUSHES = { ADDRESS: 1, BALANCE: 1, ORIGIN: 1, CALLER: 1, CALLVALUE: 1, CALLDATALOAD: 1, CALLDATASIZE: 1, CODESIZE: 1, GASPRICE: 1, EXTCODESIZE: 1, RETURNDATASIZE: 1, EXTCODEHASH: 1, SELFBALANCE: 1, MLOAD: 1, SLOAD: 1, PC: 1, MSIZE: 1, GAS: 1, CREATE: 1, CREATE2: 1, CALL: 1, CALLCODE: 1, DELEGATECALL: 1, STATICCALL: 1, TIMESTAMP: 1, NUMBER: 1, GASLIMIT: 1, CHAINID: 1, BASEFEE: 1, COINBASE: 1, SHA3: 1 };
function asm(items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'string') { if (!(it in OPS)) throw new Error('op ' + it); out.push(OPS[it]); }
    else if (typeof it === 'bigint' || typeof it === 'number') {
      let v = BigInt(it); let n = 1; for (let t = v >> 8n; t > 0n; t >>= 8n) n++;
      out.push(0x5f + n); for (let i = n - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
    } else if (it.raw) out.push(...it.raw);
  }
  return Buffer.from(out);
}
const P = (n) => BigInt(n);

// ---------- world ----------
const A = (n) => n.toString(16).padStart(40, '0');
const MAIN = A(0x1001), CALLER = A(0xc1), COINBASE = A(0xc0), ORIGIN = CALLER;
const HELP = {
  [A(0xa1)]: asm(['CALLDATASIZE', 0, 0, 'CALLDATACOPY', 'CALLDATASIZE', 0, 'RETURN']),
  [A(0xa2)]: asm([0xdead, 0, 'MSTORE', 32, 0, 'REVERT']),
  [A(0xa3)]: asm([0x77, 1, 'SSTORE', 0x88, 2, 'SSTORE', 'STOP']),
  [A(0xa4)]: asm(['CALLER', 'SELFDESTRUCT']),
  [A(0xa5)]: asm([0xbeef, 0, 'MSTORE', 7, 32, 0, 'LOG1', 'STOP']),
  [A(0xa6)]: asm([{ raw: [0x60, 0x0a, 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, 0x0a, 0x60, 0x00, 0xf3] }, 'STOP']), // tiny
  [A(0xa7)]: asm(['JUMPDEST', 0, 'JUMP']),
  [A(0xa8)]: Buffer.alloc(0),
  [A(0xa9)]: asm([0, 'SLOAD', 1, 'ADD', 0, 'SSTORE', 0, 'SLOAD', 0, 'MSTORE', 32, 0, 'RETURN']),
  [A(0xaa)]: asm([5, 0, 'SSTORE', 0, 0, 'SSTORE', 6, 0, 'SSTORE', 'STOP']), // storage churn + refunds
};
const INIT = {
  [MAIN]: { balance: 10n ** 18n, nonce: 1, code: null, storage: { 0: 5n, 1: 0n, 2: 9n } },
  [CALLER]: { balance: 10n ** 18n, nonce: 0, code: Buffer.alloc(0), storage: {} },
  [A(0xa8)]: { balance: 0n, nonce: 0, code: Buffer.alloc(0), storage: {} },
  [A(0xa9)]: { balance: 0n, nonce: 1, code: HELP[A(0xa9)], storage: { 0: 41n } },
  [A(0xaa)]: { balance: 0n, nonce: 1, code: HELP[A(0xaa)], storage: { 0: 3n, 1: 0n } },
};
for (const [a, c] of Object.entries(HELP)) if (!INIT[a]) INIT[a] = { balance: a === A(0xa4) ? 1000n : 0n, nonce: 1, code: c, storage: {} };
const SLOTS = [0n, 1n, 2n, 3n, 5n, 6n];
const BLOCK = { coinbase: COINBASE, timestamp: 1700000000, number: 12345, prevrandao: 0n, gasLimit: 30000000, chainId: 1, baseFee: 7n };

function mineRun(code, { data = Buffer.alloc(0), value = 0n, gas = 1000000, to = MAIN, mainCode = code, isStatic = false }) {
  const init = JSON.parse(JSON.stringify(INIT, (k, v) => (typeof v === 'bigint' ? 'b' + v : v)));
  const backend = {
    account: (a) => { const i = INIT[a]; if (!i) return null; return { balance: i.balance, nonce: i.nonce, code: a === MAIN ? mainCode : Buffer.from(i.code) }; },
    storage: (a, s) => (INIT[a] && INIT[a].storage[Number(s)]) || 0n,
  };
  void init;
  const st = new EvmState(backend);
  const vm = new VM(st, { ...BLOCK, origin: ORIGIN, gasPrice: 3n, blockhash: () => 0n });
  st.warmAddress(CALLER); st.warmAddress(to); st.warmAddress(COINBASE);
  for (let i = 1; i <= 9; i++) st.warmAddress(A(i));
  const r = vm._call({ kind: 'CALL', caller: CALLER, address: to, codeAddr: to, value, apparentValue: value, data, gas, depth: 0, static: isStatic });
  const view = { success: r.success, gasLeft: r.gasLeft, ret: Buffer.from(r.returnData).toString('hex'), logs: st.logs.map((l) => ({ a: l.address, t: l.topics, d: Buffer.from(l.data).toString('hex') })), refund: st.refund };
  const accts = {};
  for (const a of [MAIN, CALLER, COINBASE, A(0xa1), A(0xa2), A(0xa3), A(0xa4), A(0xa5), A(0xa6), A(0xa8), A(0xa9), A(0xaa)]) {
    accts[a] = { bal: st.getBalance(a), nonce: st.getNonce(a), stor: SLOTS.map((s) => st.getStorage(a, s)) };
    if (st.destroyed.has(a)) accts[a].destroyed = true;
  }
  return { view, accts, destroyed: [...st.destroyed] };
}

let refEvm, common;
const golden = [];
async function refRun(code, { data = Buffer.alloc(0), value = 0n, gas = 1000000, to = MAIN, isStatic = false }) {
  const sm = new DefaultStateManager();
  const evm = await EVM.create({ common, stateManager: sm });
  const addr = (h) => new Address(hexToBytes('0x' + h));
  for (const [a, i] of Object.entries(INIT)) {
    const ad = addr(a);
    await sm.putAccount(ad, undefined);
    const acc = (await sm.getAccount(ad)) || (await (async () => { const { Account } = require('@ethereumjs/util'); return new Account(); })());
    acc.balance = i.balance; acc.nonce = BigInt(i.nonce);
    await sm.putAccount(ad, acc);
    const c = a === MAIN ? code : i.code;
    if (c && c.length) await sm.putContractCode(ad, c);
    for (const [s, v] of Object.entries(i.storage)) await sm.putContractStorage(ad, setLengthLeft(bigIntToBytes(BigInt(s)), 32), bigIntToBytes(v));
  }
  for (const h of [CALLER, MAIN, COINBASE, ...Array.from({ length: 9 }, (_, i) => A(i + 1))]) evm.journal.addAlwaysWarmAddress(h, true);
  const block = { header: { number: BigInt(BLOCK.number), timestamp: BigInt(BLOCK.timestamp), coinbase: addr(COINBASE), difficulty: 0n, mixHash: new Uint8Array(32), gasLimit: BigInt(BLOCK.gasLimit), baseFeePerGas: BLOCK.baseFee } };
  const res = await evm.runCall({ caller: addr(CALLER), origin: addr(ORIGIN), to: addr(to), data, value, gasLimit: BigInt(gas), gasPrice: 3n, block, isStatic });
  const er = res.execResult;
  const logs = (er.logs || []).map((l) => ({ a: bytesToHex(l[0]).slice(2), t: l[1].map((t) => bytesToHex(t).slice(2)), d: bytesToHex(l[2]).slice(2) }));
  const view = { success: !er.exceptionError || false, gasLeft: Number(BigInt(gas) - er.executionGasUsed), ret: bytesToHex(er.returnValue).slice(2), logs, refund: Number(er.gasRefund ?? 0n) };
  if (er.exceptionError && er.exceptionError.error === 'revert') view.success = false;
  const accts = {};
  for (const a of [MAIN, CALLER, COINBASE, A(0xa1), A(0xa2), A(0xa3), A(0xa4), A(0xa5), A(0xa6), A(0xa8), A(0xa9), A(0xaa)]) {
    const ad = addr(a); const ac = await sm.getAccount(ad);
    const stor = [];
    for (const s of SLOTS) { if (!ac) { stor.push(0n); continue; } const v = await sm.getContractStorage(ad, setLengthLeft(bigIntToBytes(s), 32)); stor.push(v.length ? bytesToBigInt(v) : 0n); }
    accts[a] = { bal: ac ? ac.balance : 0n, nonce: ac ? Number(ac.nonce) : 0, stor };
  }
  return { view, accts, selfdestructed: [...(er.selfdestruct || new Set())].map((x) => x) };
}

function compare(a, b, ctx) {
  const diffs = [];
  for (const k of ['success', 'gasLeft', 'ret', 'refund']) if (a.view[k] !== b.view[k]) diffs.push(`${k}: mine=${a.view[k]} ref=${b.view[k]}`);
  if (JSON.stringify(a.view.logs) !== JSON.stringify(b.view.logs)) diffs.push(`logs: mine=${JSON.stringify(a.view.logs)} ref=${JSON.stringify(b.view.logs)}`);
  for (const addr of Object.keys(a.accts)) {
    const x = a.accts[addr], y = b.accts[addr];
    const destroyed = x.destroyed;
    if (x.bal !== y.bal) diffs.push(`balance[${addr.slice(-2)}]: mine=${x.bal} ref=${y.bal}`);
    if (!destroyed && addr !== CALLER && x.nonce !== y.nonce) diffs.push(`nonce[${addr.slice(-2)}]: mine=${x.nonce} ref=${y.nonce}`);
    if (!destroyed && JSON.stringify(x.stor.map(String)) !== JSON.stringify(y.stor.map(String))) diffs.push(`storage[${addr.slice(-2)}]: mine=${x.stor} ref=${y.stor}`);
  }
  return diffs;
}

// ---------- generators ----------
let seed = Number(process.env.SEED || 1);
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const INTERESTING = () => pick([0n, 1n, 2n, 3n, 31n, 32n, 33n, 64n, 255n, 256n, (1n << 255n), (1n << 256n) - 1n, (1n << 255n) - 1n, 0xdeadbeefn, P(rnd() * 100 | 0), P(rnd() * 1e9 | 0)]);
const ADDRS = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0x1001, 0xc1, 0xc0, 1, 2, 3, 4, 5, 9, 0x77777].map(P);
const MEMV = () => pick([0n, 0n, 32n, 64n, 96n, 128n, 1000n, 33n]);
const SIZEV = () => pick([0n, 1n, 32n, 33n, 64n, 100n]);

function genProgram(len) {
  const items = []; let depth = 0;
  const pushv = (v) => { items.push(v); depth++; };
  const names = Object.keys(POPS).filter((n) => !['SELFDESTRUCT'].includes(n) || rnd() < 0.15);
  for (let i = 0; i < len; i++) {
    const r = rnd();
    if (r < 0.25) { pushv(INTERESTING()); continue; }
    const name = pick(names);
    const need = POPS[name];
    let args;
    // choose args by op class
    const slot = () => pick([0n, 1n, 2n, 3n, 5n, 6n]);
    switch (name) {
      case 'SLOAD': args = [slot()]; break;
      case 'SSTORE': args = [pick([0n, 1n, 2n, 5n, 7n, 0xffn]), slot()]; break; // value, slot (slot on top)
      case 'MLOAD': case 'MSTORE': case 'MSTORE8': args = need === 1 ? [MEMV()] : [INTERESTING(), MEMV()]; break;
      case 'SHA3': args = [SIZEV(), MEMV()]; break;
      case 'CALLDATACOPY': case 'CODECOPY': case 'RETURNDATACOPY': args = [SIZEV(), pick([0n, 1n, 5n, 40n]), MEMV()]; break;
      case 'EXTCODECOPY': args = [SIZEV(), pick([0n, 1n, 5n]), MEMV(), pick(ADDRS)]; break;
      case 'BALANCE': case 'EXTCODESIZE': case 'EXTCODEHASH': args = [pick(ADDRS)]; break;
      case 'CALL': case 'CALLCODE': args = [SIZEV(), MEMV(), SIZEV(), MEMV(), pick([0n, 0n, 1n, 100n]), pick(ADDRS), pick([0n, 5000n, 100000n, 10n ** 6n, (1n << 64n)])]; break;
      case 'DELEGATECALL': case 'STATICCALL': args = [SIZEV(), MEMV(), SIZEV(), MEMV(), pick(ADDRS), pick([0n, 5000n, 100000n, 10n ** 6n])]; break;
      case 'CREATE': args = [SIZEV(), MEMV(), pick([0n, 0n, 1n])]; break;
      case 'CREATE2': args = [pick([0n, 1n, 77n]), SIZEV(), MEMV(), pick([0n, 0n, 1n])]; break;
      case 'RETURN': case 'REVERT': args = [SIZEV(), MEMV()]; break;
      case 'SELFDESTRUCT': args = [pick(ADDRS)]; break;
      case 'LOG0': case 'LOG1': case 'LOG2': case 'LOG3': case 'LOG4': args = [...Array(need - 2).fill(0).map(() => INTERESTING()), SIZEV(), MEMV()]; break;
      default: args = Array(need).fill(0).map(() => INTERESTING());
    }
    // args are listed bottom->top
    for (const a of args) pushv(a);
    items.push(name);
    depth += (PUSHES[name] || 0) - args.length;
    if (name === 'RETURN' || name === 'REVERT' || name === 'SELFDESTRUCT') break;
    if (rnd() < 0.15 && depth > 0) { items.push('POP'); depth--; }
    if (depth > 900) break;
  }
  lastItems = items;
  return asm(items);
}
let lastItems = [];
const fmtItems = (it) => it.map((x) => (typeof x === 'bigint' ? '0x' + x.toString(16) : typeof x === 'number' ? '0x' + x.toString(16) : x.raw ? 'RAW' : x)).join(' ');

const HAND = {
  sstore_refunds: asm([1, 0, 'SSTORE', 0, 0, 'SSTORE', 7, 1, 'SSTORE', 0, 1, 'SSTORE', 'STOP']),
  sstore_dirty: asm([9, 2, 'SSTORE', 5, 2, 'SSTORE', 9, 2, 'SSTORE', 'STOP']),
  memory_expand: asm([1, 100000, 'MSTORE', 'MSIZE', 0, 'MSTORE', 32, 0, 'RETURN']),
  exp_gas: asm([0xffffffff, 3, 'EXP', 0, 'MSTORE', 32, 0, 'RETURN']),
  call_value: asm([0, 0, 0, 0, 5, P(0xa8), 100000, 'CALL', 0, 'MSTORE', 32, 0, 'RETURN']),
  call_new_account: asm([0, 0, 0, 0, 5, P(0x77777), 100000, 'CALL', 'STOP']),
  staticcall_write: asm([0, 0, 0, 0, P(0xa3), 100000, 'STATICCALL', 0, 'MSTORE', 32, 0, 'RETURN']),
  delegate_storage: asm([0, 0, 0, 0, P(0xa3), 100000, 'DELEGATECALL', 'POP', 'STOP']),
  create_empty: asm([0, 0, 0, 'CREATE', 0, 'MSTORE', 32, 0, 'RETURN']),
  create2_salted: asm([1, 0, 0, 0, 'CREATE2', 0, 'MSTORE', 32, 0, 'RETURN']),
  revert_returndata: asm([0, 0, 0, 0, 0, P(0xa2), 100000, 'CALL', 'POP', 'RETURNDATASIZE', 0, 0, 'RETURNDATACOPY', 32, 0, 'RETURN']),
  selfdestruct_ben: asm([P(0xa8), 'SELFDESTRUCT']),
  logs: asm([0xaa, 0, 'MSTORE', 1, 2, 3, 32, 0, 'LOG3', 'STOP']),
  sha3: asm([0xabcdef, 0, 'MSTORE', 32, 0, 'SHA3', 0, 'MSTORE', 32, 0, 'RETURN']),
  ecrecover_bad: asm([0, 0, 'MSTORE', 128, 0, 128, 0, 0, 1, 100000, 'STATICCALL', 'POP', 'RETURNDATASIZE', 0, 'MSTORE', 32, 0, 'RETURN']),
  sha256_pc: asm([0xff, 0, 'MSTORE8', 1, 0, 32, 0, 1, 2, 100000, 'STATICCALL', 'POP', 32, 0, 'RETURN']),
  identity_pc: asm([0xff, 0, 'MSTORE8', 4, 0, 1, 0, 1, 4, 100000, 'STATICCALL', 'POP', 1, 0, 'RETURN']),
  oog_loop: asm([P(0xa7), 'POP', 0, 0, 0, 0, 0, P(0xa7), 50000, 'CALL', 0, 'MSTORE', 32, 0, 'RETURN']),
  counter: asm([0, 0, 0, 32, 0, P(0xa9), 100000, 'STATICCALL', 'POP', 32, 0, 'RETURN']),
  churn: asm([0, 0, 0, 0, 0, P(0xaa), 200000, 'CALL', 'POP', 'STOP']),
  jump_ok: asm([5, 'JUMP', 'INVALID', 'INVALID', 'JUMPDEST', 7, 0, 'MSTORE', 32, 0, 'RETURN']),
  jump_bad: asm([3, 'JUMP', 'INVALID', 'STOP']),
  stack_under: asm(['ADD']),
  signed_ops: asm([P(5), (1n << 256n) - 3n, 'SDIV', 0, 'MSTORE', P(7), (1n << 256n) - 5n, 'SMOD', 32, 'MSTORE', 64, 0, 'RETURN']),
  shifts: asm([(1n << 255n), 4, 'SAR', 1, 255, 'SHL', 'ADD', 0, 'MSTORE', 32, 0, 'RETURN']),
  signext: asm([0x80, 0, 'SIGNEXTEND', 0, 'MSTORE', 32, 0, 'RETURN']),
  addmod: asm([P(7), (1n << 256n) - 1n, (1n << 256n) - 2n, 'ADDMOD', 0, 'MSTORE', 32, 0, 'RETURN']),
  env: asm(['COINBASE', 'TIMESTAMP', 'NUMBER', 'GASLIMIT', 'CHAINID', 'BASEFEE', 'GASPRICE', 'ORIGIN', 'ADD', 'ADD', 'ADD', 'ADD', 'ADD', 'ADD', 0, 'MSTORE', 32, 0, 'RETURN']),
  extcodehash: asm([P(0xa8), 'EXTCODEHASH', 0, 'MSTORE', P(0xa1), 'EXTCODEHASH', 32, 'MSTORE', P(0x99999), 'EXTCODEHASH', 64, 'MSTORE', 96, 0, 'RETURN']),
  extcodecopy: asm([10, 0, 0, P(0xa3), 'EXTCODECOPY', 32, 0, 'RETURN']),
  push0: asm(['PUSH0', 'PUSH0', 'ADD', 0, 'MSTORE', 32, 0, 'RETURN']),
  modexp: asm([1, 0, 'MSTORE', 1, 32, 'MSTORE', 2, 64, 'MSTORE', (0x020a03e8n << 224n), 96, 'MSTORE', 2, 0, 100, 0, 5, 100000, 'STATICCALL', 'POP', 32, 0, 'RETURN']),
  modexp_big: asm([32, 0, 'MSTORE', 32, 32, 'MSTORE', 32, 64, 'MSTORE', 0xffffffffffffffffn, 96, 'MSTORE', 0x1234567n, 128, 'MSTORE', 0xfffffffffffffffffffffffffffffffbn, 160, 'MSTORE', 32, 0, 192, 0, 5, 1000000, 'STATICCALL', 'POP', 32, 0, 'RETURN']),
  modexp_zero_mod: asm([1, 0, 'MSTORE', 1, 32, 'MSTORE', 2, 64, 'MSTORE', (0x020a0000n << 224n), 96, 'MSTORE', 2, 0, 100, 0, 5, 100000, 'STATICCALL', 'POP', 32, 0, 'RETURN']),
  blake2f: asm([12, 0, 'MSTORE8', 0xbeef, 100, 'MSTORE', 1, 212, 'MSTORE8', 64, 0, 213, 0, 9, 100000, 'STATICCALL', 'POP', 64, 0, 'RETURN']),
  blake2f_badflag: asm([2, 212, 'MSTORE8', 64, 0, 213, 0, 9, 100000, 'STATICCALL', 0, 'MSTORE', 32, 0, 'RETURN']),
};

async function main() {
  common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  let fails = 0, total = 0;
  const check = async (name, code, opts = {}) => {
    total++;
    let mine, ref;
    try { mine = mineRun(code, opts); } catch (e) { console.log(`[${name}] MY EVM THREW:`, e.stack.split('\n').slice(0, 4).join(' | ')); fails++; return; }
    ref = await refRun(code, opts);
    if (process.env.GOLDEN && (!name.startsWith('fuzz') || golden.length < 260)) golden.push({ name, code: code.toString('hex'), opts: { data: Buffer.from(opts.data || []).toString('hex'), value: String(opts.value || 0n), gas: opts.gas || 1000000, to: opts.to || MAIN }, view: ref.view, accts: Object.fromEntries(Object.entries(ref.accts).map(([a, v]) => [a, { bal: String(v.bal), nonce: v.nonce, stor: v.stor.map(String) }])) });
    const d = compare(mine, ref);
    if (d.length) {
      fails++;
      if (fails <= 6) {
        let items = name.startsWith('fuzz') ? lastItems.slice() : null;
        if (items) { // greedy shrink: drop items while the programs still disagree
          let changed = true;
          while (changed) {
            changed = false;
            for (let k = 0; k < items.length; k++) {
              const t = items.slice(0, k).concat(items.slice(k + 1));
              try { const c = asm(t); const dd = compare(mineRun(c, opts), await refRun(c, opts)); if (dd.length) { items = t; changed = true; k--; } } catch { /* invalid */ }
            }
          }
          const c = asm(items); d.length = 0; d.push(...compare(mineRun(c, opts), await refRun(c, opts)));
        }
        console.log(`[${name}] DIFF ${items ? 'SHRUNK: ' + fmtItems(items) : 'code=' + code.toString('hex').slice(0, 160)}\n   ` + d.join('\n   '));
      }
    }
  };
  for (const [n, c] of Object.entries(HAND)) { await check(n, c); }
  await check('value_call', HAND.counter, { value: 5n });
  const N = Number(process.env.N || 1500);
  for (let i = 0; i < N; i++) await check('fuzz' + i, genProgram(4 + Math.floor(rnd() * 30)), { value: pick([0n, 0n, 7n]), gas: pick([30000, 100000, 1000000, 3000000]) });
  if (process.env.GOLDEN) {
    const world = Object.fromEntries(Object.entries(INIT).map(([a, i]) => [a, { balance: String(i.balance), nonce: i.nonce, code: a === MAIN ? null : Buffer.from(i.code).toString('hex'), storage: Object.fromEntries(Object.entries(i.storage).map(([k, v]) => [k, String(v)])) }]));
    require('fs').writeFileSync(process.env.GOLDEN, JSON.stringify({ about: 'Results of the reference @ethereumjs/evm (Shanghai) for programs run by test/evm.test.js against src/evm. Regenerate with scripts/evm-diff.js.', block: { ...BLOCK, prevrandao: '0', baseFee: String(BLOCK.baseFee) }, main: MAIN, caller: CALLER, coinbase: COINBASE, world, cases: golden }));
    console.log('golden written', golden.length);
  }
  console.log(`\n${total} programs, ${fails} differences`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });


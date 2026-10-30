# EVM layer

AUREN runs Ethereum bytecode. Contracts deploy and run on the same validators, fee market and state as everything else, and Ethereum tools connect through standard JSON-RPC.

Code: `src/evm/` (interpreter `vm.js`, journaled state `state.js`, chain glue `host.js`, raw-transaction parser `ethtx.js`, RPC `rpc.js`, Keccak/RLP/secp256k1). Tests: `test/evm.test.js`, `test/evm-chain.test.js`, differential harness `scripts/evm-diff.js`.

## Connecting a wallet or tool

| | devnet | testnet | mainnet |
|---|---|---|---|
| RPC URL | `http://127.0.0.1:9650` | your node | not launched |
| Chain ID | **77001** | 77002 | 77000 |
| Currency | AUR, **18 decimals** | AUR | AUR |

(Check chainlist.org for conflicts before any public launch; these numbers are placeholders.)

```js
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:9650', { chainId: 77001, name: 'auren-devnet' });
const wallet = new ethers.Wallet(privateKey, provider);
await (await wallet.sendTransaction({ data: initcode })).wait();   // deploy
```

To get test funds, ask the faucet for the account's **AUREN address**, which for an Ethereum key is `bech32("daur", [4, ...20-byte Ethereum address])` (helper: `keyFromHex(addrHex, 4, 'daur')` in `src/evm/host.js`).

**Verified live:** with unmodified `ethers` v6 against a running 4-validator devnet: connect, `eth_chainId`, fee data, deploy a contract (gas 77,708), `getCode`, `eth_call`, `getStorageAt`, send 2.5 AUR, nonces, balances, block with transactions. MetaMask itself has **not** been tested (no browser wallet automation here); it uses the same RPC methods, so it should work, but treat that as unconfirmed.

## From the command line

```bash
aurenctl evm deploy --data @contract.hex --from alice --network devnet      # prints the contract address and gas used
aurenctl evm call 0xCONTRACT --data 0x70a08231... --network devnet          # read-only, no key needed
aurenctl evm send 0xCONTRACT --data 0x... --value 1.5 --from alice --network devnet
aurenctl evm code 0xCONTRACT --network devnet
```

Gas is estimated automatically (`--gas N` to override; `--simulate` for a dry run). The block explorer shows gas, return data, logs and created contracts on each transaction page, and accepts Ethereum transaction hashes in search.

## What is implemented

- **Opcodes and rules: Ethereum "Shanghai"**: all opcodes through PUSH0, EIP-2929 warm/cold access, EIP-2200/3529 SSTORE and refunds, EIP-3541, EIP-3651, EIP-3855, EIP-3860, CREATE/CREATE2, depth and code-size limits, static calls, SELFDESTRUCT (Shanghai semantics).
- **Precompiles 1-5 and 9**: ecrecover, SHA-256, RIPEMD-160, identity, modexp (EIP-2565), blake2f. **Precompiles 6-8 (bn254 add/mul/pairing) are NOT implemented**: calls fail and burn the forwarded gas. Contracts that verify Groth16/zk-SNARK proofs will not work yet.
- **Not in Shanghai (not implemented):** transient storage (TLOAD/TSTORE), MCOPY, blob opcodes (Cancun).
- **Transactions:** (a) native `evm` transactions signed with any AUREN key (Ed25519 or passkey); (b) **raw Ethereum transactions** (legacy EIP-155, EIP-2930/EIP-1559 type 1-2 without access lists) signed with secp256k1, accepted through `eth_sendRawTransaction`. The raw bytes *are* the signature: the chain recomputes the transaction envelope from them and rejects any mismatch, so no field can be altered.
- **RPC:** `eth_chainId, eth_blockNumber, eth_getBalance, eth_getTransactionCount, eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory, eth_getCode, eth_getStorageAt, eth_call, eth_estimateGas, eth_sendRawTransaction, eth_getTransactionReceipt, eth_getTransactionByHash, eth_getBlockByNumber/Hash, eth_getLogs`, `net_*`, `web3_clientVersion`. Not implemented: `eth_subscribe`/filters, `debug_*`/`trace_*`, `eth_getProof`, access lists. `POST /` and `POST /rpc` both work.

## How it fits the chain

- **Addresses.** An account's EVM address is the 20-byte hash inside its bech32 address. Ethereum keys use address scheme 4 (`keccak256(pubkey)[12:]`, so the EVM address equals the Ethereum address); contracts use scheme 3. Mapping is stored in `eaddr`; contract code in `ecode`; storage in `estor` (all in the Merkle state root).
- **Units.** 1 AUR = 1e9 sparks = **1e18 wei**: contracts see 18-decimal values. The chain's smallest unit is 1 spark, so value transfers must be multiples of 1e9 wei; a call that sends a fractional amount fails (a raw transaction with such a value is rejected at submission).
- **Fees.** EVM gas is the **compute** dimension; a transaction also reserves `ceil(gasLimit/1000)` **state** units, so the effective gas price is `baseFee.compute + baseFee.state/1000` sparks per gas (`eth_gasPrice` quotes this plus rounding). Unused gas is refunded; the base part is burned, the tip goes to the proposer. A reverted call still pays for the gas it used and does not move value or change state.
- **Security features apply.** The account **daily limit** also caps value sent by EVM transactions.
- **Execution is sequential.** EVM transactions declare a wildcard access set, so a block that contains one runs in block order (no parallel lanes).
- **Block context.** `COINBASE` = proposer, `TIMESTAMP` = block time (s), `NUMBER`, `GASLIMIT` = compute limit, `BASEFEE` = per-gas price in wei, `PREVRANDAO` = 0 (no randomness beacon yet: do not build lotteries on it), `BLOCKHASH` for the last 256 blocks, `CHAINID` = the EVM chain id.

## How it was verified

- **Differential testing against the reference EVM** (`@ethereumjs/evm`, Shanghai): 7,569 programs (hand-written plus a stack-aware fuzzer with several seeds, including nested CALL/CREATE/DELEGATECALL/STATICCALL, SELFDESTRUCT, logs, memory growth, SSTORE refunds and precompiles) produced **zero differences** in success, gas, return data, logs, storage, balances and refunds. 260 of them are recorded in `test/fixtures/evm-golden.json` and replayed by `npm test` without any external dependency.
- Keccak-256, RLP and secp256k1 recovery cross-checked against `ethers` on random inputs; ethers-signed transactions parse and execute (`test/evm-chain.test.js`).
- Chain behaviour tested: deploy/call/send via raw Ethereum transactions and native transactions, gas refunds, reverts, daily-limit enforcement, replay protection, tamper detection, deterministic replay on a second node, token conservation.

## Known limitations

1. **Not audited.** The interpreter is verified against one reference implementation, not against the official Ethereum test suite (`ethereum/tests`), and not formally.
2. Precompiles 6-8 missing (above); Cancun opcodes missing.
3. The fee model approximates Ethereum's: gas costs are Ethereum's, but its price comes from two dimensions, so `eth_estimateGas` returns `gasUsed × 1.2` and wallets' fee estimates are slightly conservative.
4. An account funded under one address scheme but used from another needs the right AUREN address when receiving from the faucet or a native `transfer` (use scheme 4 for Ethereum keys); the EVM view finds the existing account automatically.
5. `eth_getLogs` scans blocks (max range 2,000) rather than using bloom filters; receipts are kept in memory.
6. No gas-price oracle beyond the current base fee; no EIP-1559 tip market for pending transactions beyond the simple tip rule.
7. Sequential-only execution caps throughput of EVM-heavy blocks.

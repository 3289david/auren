# Protocol specification (v0.1)

Normative description of what `src/` implements. Where the code and this document disagree, that is a bug in one of them.

## Encoding

- **Canonical JSON** (`canon`): object keys sorted, BigInt rendered as decimal strings, `undefined` omitted. All hashes and signatures are over canonical JSON.
- **Hash:** SHA-256, hex. **Merkle root:** binary tree over 32-byte leaves, odd node promoted; empty list = `sha256("")`.
- **Signatures:** Ed25519. Domain tags: `AUREN/tx/v1\0`, `AUREN/vote/v1\0`, `AUREN/block/v1\0`, `AUREN/gentx/v1\0`.
- **Units:** 1 AUR = 10⁹ sparks. All amounts are decimal strings on the wire, BigInt in state.

## Addresses

Bech32 (BIP-173). Payload is 21 bytes: `scheme` (0 = Ed25519, 1 = reserved ML-DSA, 2 = WebAuthn ECDSA P-256: see `hardware-wallets.md`) ‖ `sha256(scheme ‖ pubkey)[0:20]`.
Human-readable prefix per network: `aur` (mainnet), `taur` (testnet), `daur` (devnet).

## Transactions

```json
{ "v": 1, "chainId": "auren-devnet-1", "type": "transfer", "from": "daur1…", "pub": "<64 hex>",
  "nonce": 0, "maxFee": "400000", "tip": "1000", "body": { "to": "daur1…", "amount": "1000000000" }, "sig": "<128 hex>" }
```

- `chainId` is inside the signed bytes: no cross-network replay.
- Valid if: signature verifies, `from` is the address of `pub` (or, after recovery, `pub` equals the account's `authPub`), `nonce` equals the account nonce, `maxFee ≥ baseCost`, and spendable balance ≥ `baseCost + tip`.
- Fee: `baseCost = cost.compute × baseFee.compute + cost.state × baseFee.state` (burned). `tip = min(tx.tip, maxFee − baseCost)` (to the proposer at end of block).
- A transaction failing these checks makes the **block** invalid. A transaction failing in its handler is included with `status: 0`; fee and nonce are consumed, effects reverted.

### Types and fixed resource costs

| type | compute | state | body |
|---|---:|---:|---|
| `transfer` | 21,000 | 100 | `to`, `amount` |
| `delegate` | 60,000 | 250 | `validator`, `amount` |
| `undelegate` | 70,000 | 300 | `validator`, `amount` |
| `claim` | 40,000 | 100 | `validator` |
| `createValidator` | 150,000 | 600 | `consPub`, `commissionBps`, `moniker`, `amount` |
| `unjail` | 40,000 | 100 | |
| `registerDomain` | 80,000 | 400 | `name` (`label` or `label.tld`), `years` |
| `registerNode` | 60,000 | 300 | `payout` (see `node-rewards.md`) |
| `unregisterNode` | 50,000 | 250 | |
| `nodeProof` | 60,000 | 150 | `epoch`, `digest` |
| `registerTld` | 100,000 | 500 | `tld`, `open`, `price`, `ownerShareBps` (see `domains.md`) |
| `setTldPolicy` | 50,000 | 200 | `tld`, `open`, `price`, `ownerShareBps` |
| `transferTld` | 40,000 | 100 | `tld`, `newOwner` |
| `setDomainTarget` | 40,000 | 100 | `name`, `target` |
| `transferDomain` | 40,000 | 100 | `name`, `newOwner` (resets target and records) |
| `setRecord` | 50,000 | 300 | `name`, `key` (`addr:<ns>:<ref>` / `text:<k>` / `content`), `value \| null` |
| `setPrimary` | 40,000 | 100 | `name \| null` (only if the name already points to you) |
| `submitProposal` | 200,000 | 1,000 | `title`, `description`, `changes{param: value}` (see `governance.md`) |
| `vote` | 50,000 | 150 | `id`, `option` (`yes`/`no`/`abstain`/`veto`) |
| `setSecurity` | 60,000 | 400 | `guardians[]`, `threshold`, `delayBlocks`, `dailyLimit \| null` |
| `securityCancel` | 40,000 | 100 | `account` |
| `recoveryApprove` | 50,000 | 200 | `account`, `newPub` |
| `recoveryCancel` | 40,000 | 100 | |

Each type also declares an **access set** (keys it may read/write); see `fee-market.md`.

## Block

```
header: { v, chainId, height, round, time, prevHash, proposer,
          baseFee{compute,state}, txRoot, evidenceRoot, lastCommitHash, receiptsRoot, stateRoot,
          used{compute,state}, txCount }
block:  { header, hash = sha256(canon(header)), txs[], evidence[], lastCommit, sig }   // sig by proposer's consensus key
```

A block is valid iff: height/parent/chain match; `time` increases (and is not > local clock + 5 s when proposed); the proposer equals the deterministic draw for `(height, round)`; `sig` is valid; `baseFee` equals the value derived from the parent; `lastCommit` is a valid >⅔ certificate for the parent (height ≥ 2); all roots recompute; usage is within limits; and re-execution yields the committed `stateRoot` and `receiptsRoot`.

## Block execution order

1. **Evidence**: equivocation proofs (two votes of one type, same height and round, different blocks) slash, jail and tombstone. See `consensus.md`.
2. **Liveness**: count validators missing from `lastCommit`; at window boundaries jail those that missed > `maxMissedBps`.
3. **Transactions** in lane order (conflicting transactions keep block order). Fees accumulate; they are not credited mid-block.
4. **End of block**: credit tips to the proposer; mature unbonding entries; execute due recoveries; mint issuance to the previous block's signers (reward-index accounting); update `supply` and `burned`; recompute the active set for the next height.

## State

Namespaces: `acct` (balance, nonce, authPub, vesting, security), `val`, `del`, `unb`, `dom`, `rec`, `meta` (supply, burned, activeSet, lastValset). `stateRoot` is the merkle root over sorted `(namespace, key, canon(value))` leaves.

**Invariant (tested):** `supply = Σ balances + Σ bonded tokens + Σ unbonding + Σ accrued-unclaimed rewards`.

## Staking

- Delegations hold **shares** of a validator's pool, so slashing reduces everyone proportionally.
- Rewards use a per-validator **reward index** (`index += reward × 10¹⁸ / totalShares`); settled lazily on delegate/undelegate/claim. Commission is accrued separately.
- Unbonding takes `unbondingBlocks` (mainnet default 1,209,600 ≈ 28 days). Unbonding stake remains slashable for infractions committed before it began.
- Active set: top `maxValidators` by bonded tokens among non-jailed validators with ≥ `minSelfStake`; power = `min(tokens, cap)`.

## Parameters

Defaults live in `src/params.js`; a genesis file may override any of them. Highlights: `blockTimeMs 2000`, `roundTimeoutMs 4000`, `maxValidators 150`, `maxVotingPowerBps 1000`, `limits {compute 30,000,000; state 200,000}`, `initialBaseFee {40, 2000}`, `minBaseFee {10, 500}`, issuance `{3.0%, −15%/yr, 0.5% floor}`, slashing `{double-sign 5%, downtime 0.1%}`.

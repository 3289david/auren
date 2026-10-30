# Security architecture

Layered, because no single feature is "the" security.

| Layer | Mechanism | Where |
|---|---|---|
| Consensus | one-vote-per-height rule, double-sign evidence, slashing, jailing, power cap | `consensus.js`, `chain.js` |
| Transactions | chain ID in signed bytes, sequential nonces, Ed25519 signatures, fee pre-checks | `tx.js` |
| Execution | fixed deterministic costs, block resource limits, failure isolation (fork per tx) | `tx.js`, `chain.js` |
| Accounts | daily limits, timelocks, guardians, recovery | `tx.js` |
| Keys | scrypt + AES-256-GCM keystore, separate operator and consensus keys | `crypto.js`, `client.js` |
| Network | rate-limited RPC, body-size caps, peer genesis check | `node.js` |
| Upgrades | published proposals + timelock (Phase 2) | n/a yet |

## Account protection

### Daily limit
`setSecurity.dailyLimit` caps the sum of `transfer` amounts per window (`limitWindowBlocks`, 1 day on mainnet). Staking, claiming and name fees are not "withdrawals" and do not count.

### Timelocked loosening
A `setSecurity` call that is *at least as strict* as the current configuration (same guardians, threshold and delay not lower, limit not higher) applies immediately. Anything looser is queued for `delayBlocks`. Any guardian, or the account itself, can cancel the queued change (`securityCancel`).

### Guardian recovery
1. Owner sets 1-9 guardians and a threshold with `setSecurity` (delay ≥ protocol minimum).
2. If the key is lost, each guardian submits `recoveryApprove{account, newPub}`. A guardian proposing a *different* new key resets the approvals.
3. At threshold the recovery becomes ready after `delayBlocks`. The owner can `recoveryCancel` within that window.
4. When ready, the account's `authPub` becomes `newPub`: the old key stops working, and the account's address, balance and nonce stay the same.

**Limit of the design:** recovery is for *lost* keys. If a thief holds the key, they can cancel a recovery. What bounds that case is the daily limit and the guardian veto on loosening.

### Simulation
`aur_simulate` (or `aurenctl … --simulate`) runs the transaction against a fork of current state and returns `ok`, error code, fee, burn, and the exact before/after of every touched account, so a wallet can show "you will send X and pay Y" before signing. It is as accurate as the next block; fees can change by ≤ 12.5% per block.

## Keys

- **Operator key** (holds funds, creates the validator, claims rewards): keep offline / hardware-backed when hardware-wallet support lands. Encrypted keystore at `~/.auren/keystore` (override with `AUREN_KEYSTORE`).
- **Consensus key** (`priv_validator_key.json`, signs votes only): lives on the validator host, mode 0600. It can **never** move funds. Losing it costs availability; *duplicating* it costs 5% of stake. Never run two nodes with one consensus key.
- The faucet and `devnet` keys are public by design.

## Post-quantum readiness

Addresses embed a scheme byte; transactions will carry a scheme-tagged signature. Scheme 1 is reserved for ML-DSA (FIPS 204). We will not force large signatures on all transactions: the plan is to (1) benchmark signature size, verification time and bandwidth on a testnet, (2) let accounts opt in, (3) revisit defaults as the threat becomes concrete. Until then, Ed25519 is the only implemented scheme.

## What we do not claim

- No formal verification, no audit. The conservation invariant, lane-independence property and commit-quorum rules are tested, not proven.
- P2P is plain HTTP (see `consensus.md#known-limitations`).
- The node trusts its own disk: a corrupted block log is detected by replay verification, but there is no snapshot signature scheme.

## Operational checklist (validators)

1. Run exactly one instance per consensus key; no hot standby sharing the key.
2. Firewall the RPC (keep the default private RPC address + reverse proxy with TLS and rate limits for public RPC).
3. Monitor `/metrics`: `auren_block_height`, `auren_catching_up`, `auren_peers`.
4. Back up `priv_validator_key.json` offline and `data/priv_validator_state.json` with the node.
5. Keep operator keys off the validator host.

# AUREN Whitepaper (v0.1, draft)

**An independent Layer 1 built around verifiable security, predictable cost and protocol-level account protection.**

> Draft for discussion. Parameters marked *(proposed)* are starting assumptions, not commitments. AUREN/AUR are working names.

## 1. Motivation

Most new chains compete on headline throughput and low fees. Those numbers are easy to claim and hard to compare, and they say little about what users actually experience: fees that spike unpredictably, validator sets that quietly centralize, and accounts whose safety depends entirely on a wallet app.

AUREN pursues four goals and tries to *measure* each one:

1. **Verifiable security**: finality, slashing evidence and upgrade history are checkable from the chain itself.
2. **Predictable performance**: bounded blocks, fixed per-operation resource costs, fees that cannot move more than 12.5% per block.
3. **Validator accessibility**: requirements a normal operator can meet, with decentralization measured (Nakamoto coefficient) rather than asserted.
4. **Predictable monetary policy**: a published issuance schedule and a burned base fee, with no discretionary inflation.

None of these ideas is new in isolation (BFT PoS, EIP-1559-style pricing, delegated staking, guardian recovery all exist elsewhere). The contribution is the specific combination, the rules written down precisely, and a reference implementation with tests that anyone can run. We make no "world first" claim.

## 2. Architecture

```
Wallets · explorers · exchanges            aurenctl · website/explorer · JSON-RPC
RPC & P2P                                  HTTP JSON-RPC + REST, gossip, sync
Consensus      stake-weighted BFT          proposer draw · votes · commit certificate · slashing
Execution      resource-metered            fixed costs · access sets · parallel lanes
State          namespaced KV + merkle root accounts · validators · delegations · names · security
```

Modules: consensus, execution, fee engine, staking, state store, and optional name service. The name module is separate by construction: if it fails, transfers and consensus are unaffected.

## 3. Consensus (summary; full spec in `consensus.md`)

- Validators are the top *N* (default 150) by bonded stake, with a per-validator **voting-power cap** (default 10% of total bonded stake; effective once the set is large enough).
- For each `(height, round)` a proposer is drawn deterministically in proportion to voting power. It builds a block, executes it, and commits to the post-state root.
- Each validator re-executes the block, and signs **at most one block per height**, persisting the vote before sending it.
- A block with votes from **more than ⅔ of voting power** is final. The certificate is embedded in the next block.
- Safety: two conflicting finalized blocks require ≥ ⅓ of power to have signed twice at one height, which is provable and slashed (5%, permanent ejection).
- Liveness: if ⅔ cannot be reached, the chain stops finalizing instead of guessing.

The current implementation is single-phase; the roadmap replaces it with a two-round protocol with proof-of-lock (see limitations).

## 4. Adaptive Execution Market (summary; `fee-market.md`)

Resources are split into **compute** and **state**. Every transaction type has a fixed cost in each. A transaction pays
`cost_compute × baseFee_compute + cost_state × baseFee_state`, which is **burned**, plus an optional **tip** to the proposer.
Each base fee updates per block toward 50% utilization:

```
if used > target: base += max(1, base × (used − target) / target / 8)
if used < target: base −= base × (target − used) / target / 8        (never below the floor)
```

Transactions declare the state keys they touch. A lane scheduler groups them with union-find: independent transactions land in different lanes, conflicting ones share a lane in block order. Fees, burns and tips are settled at end of block, so lanes never contend for shared accounts. Lane order provably does not change the final state root (randomized test).

This combines known ideas (multi-dimensional fee markets, declared access sets, EIP-1559). Whether it beats alternatives is an empirical question the benchmarks in `scripts/` are meant to answer.

## 5. Monetary policy (summary; `tokenomics.md`)

- Native coin **AUR**, 9 decimals. Initial supply stated in genesis (mainnet *(proposed)*: 1,000,000,000 AUR).
- **Issuance:** 3.0% annually, decaying 15% per year to a 0.5% floor *(proposed)*. Minted per block, only for validators that signed the previous block, split with delegators.
- **Burn:** all base fees, slashed stake, and name-registration fees.
- **Net supply change** = issuance − burn. Burning does not by itself create value; demand, circulation and rewards matter.
- No hard cap: a tail emission funds security as block rewards shrink. Parameter changes require a public on-chain proposal, a long timelock and an explicit activation height.

## 6. Native account security (`security.md`)

- **Daily limit** enforced in the state machine. Tightening is instant; loosening is queued behind a timelock and any guardian can veto it.
- **Guardian recovery:** up to 9 guardians and a threshold. Approvals start a delay; the owner can cancel. After the delay the account's authorizing key changes.
- **Simulation:** any signed transaction can be dry-run, returning exact state effects and fee.
- **Crypto agility:** addresses embed a signature-scheme byte. Scheme 0 is Ed25519; scheme 1 is reserved for ML-DSA (NIST FIPS 204). Adoption follows benchmarking of signature size, verification speed and bandwidth.

What this does **not** do: recovery handles *lost* keys. Against an attacker holding the key, the daily limit and guardian veto bound the loss; they do not eliminate it.

## 7. Interoperability (design only)

Every block carries its parent's >⅔ certificate, so a light client can follow the chain by verifying signatures against a known validator set. A bridge must specify: how it verifies the other chain, what happens when the verifier or relayer fails, and when and how assets can be recovered. We will not ship a bridge without those three written down and reviewed.

## 8. Governance

Phase 2. Proposals, voting weighted by stake, long timelock, activation heights, and an emergency path limited to halting block production (never to changing balances).

## 9. Threat model and known gaps

See `consensus.md#known-limitations` and `security.md`. In short: the current reference node has an unauthenticated plain-HTTP P2P layer, single-phase voting, a grindable proposer draw, no smart contracts, no state sync, and no audit. Mainnet is gated on fixing or accepting each, in public.

## 10. References

- Ethereum EIP-1559 (fee market with base-fee burn).
- Tendermint / CometBFT consensus papers (BFT PoS with immediate finality).
- NIST FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) post-quantum signature standards.
- BIP-173 (Bech32) address encoding.

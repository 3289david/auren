# Roadmap

No dates: each phase ships when its exit criteria are met and published.

## Phase 0: reference chain (done in this repository)
- BFT PoS, commit certificates, slashing, jailing, voting-power cap
- Two-dimensional fee market, burn, tips, conflict-aware lanes
- Staking, rewards, unbonding; `.aur` names; guardian recovery; daily limits; simulation
- Node, JSON-RPC/REST, CLI wallet, faucet, explorer, website
- Devnet; testnet generator; mainnet ceremony tooling
- Tests: unit + 4-node HTTP integration (fault tolerance, halt without quorum, restart, late sync)

**Exit:** `npm test` green on Node 20/22/24, Linux and Windows.

## Done since Phase 0 (v0.3-0.4)
- On-chain governance: proposals, stake-weighted voting, quorum, veto, deposit, timelock, live parameter changes
- Two-phase BFT (propose/prevote/precommit) with proof-of-lock, fault-injection tested
- WebAuthn hardware-key signatures (scheme 2) and wallet support
- ANR-1 universal name resolution: records, verified reverse names, light-client proofs, DNS + ENS adapters

## Phase 1: public testnet
- Independent review of the BFT implementation; formal model of the lock rules
- Ledger app (needs device firmware work and a physical device to verify)
- Sequential header sync for the light client (removes the trusting-period limit) and non-membership proofs for names
- Authenticated, encrypted P2P (QUIC/Noise), peer scoring, DoS limits
- State sync, snapshots, pruning; fsync'd validator state
- Proposer randomness beacon (VRF) instead of parent-hash draw
- Deterministic vote-inclusion rule
- Hardware-wallet signing (Ledger/Trezor) for the operator and user keys
- Incentivized fault-injection and spam campaign; bug bounty

**Exit:** ≥ 3 months stable, ≥ 20 independent validators, published fault-injection and performance reports.

## Phase 2: programmability & governance
- EVM-compatible execution engine metered through the compute/state dimensions
- Standard interfaces: wallet JSON-RPC (`eth_*` subset), name-resolution interface for contracts
- Governance: proposals, stake-weighted votes, timelocks, activation heights
- Light client; relayer-free verification of commits
- Hotspot pricing research for contracts everyone touches

## Phase 3: interoperability & mainnet candidate
- Bridge design with explicit verification method, failure handling and asset-recovery rules, reviewed before any code ships
- Post-quantum signature scheme (ML-DSA) opt-in, after benchmarks
- Two independent audits; all reports public
- Genesis ceremony and launch per `networks/mainnet/README.md`

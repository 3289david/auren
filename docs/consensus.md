# Consensus: Auren BFT-PoS (two-phase, Tendermint-style)

Implementation: `src/bft.js` (pure state machine), wired to the network in `src/node.js`, primitives in `src/consensus.js`.

## Goals

Immediate finality; safety while < ⅓ of voting power is Byzantine; stop-rather-than-fork when quorum is unavailable; misbehavior is provable on-chain.

## Protocol

For each height *h* there are rounds *r = 0, 1, 2, …*. Voting power is stake-weighted (`min(tokens, cap)`); **quorum means strictly more than ⅔** of total power (`power × 3 > total × 2`), and **f+1 means more than ⅓**.

Per round:

1. **Propose.** The proposer for `(h, r)` (deterministic stake-weighted draw) broadcasts a signed `proposal {height, round, polRound, block}`. If it holds a *valid block* from an earlier round (it saw a proof-of-lock for it) it re-proposes that block with `polRound` set; otherwise it builds a new one.
2. **Prevote.** On a valid proposal, a validator prevotes the block, *unless it is locked on a different block*, in which case it prevotes nil. If the proposal carries `polRound ≥ 0`, the validator needs to have seen a quorum of prevotes for that block in `polRound`, and may then prevote it if its lock is at `polRound` or older (or the same block). No proposal before the timeout, or an invalid one: prevote nil.
3. **Precommit.** With a proposal and a quorum of prevotes for it in this round, the validator **locks** on the block (`lockedRound = r`) and precommits it. A quorum of nil prevotes: precommit nil. A quorum of prevotes of any kind starts a prevote timeout, after which it precommits nil.
4. **Commit.** A quorum of precommits for one block, **in any round** of the height, finalizes it. The certificate (the precommits) is embedded as `lastCommit` in the next block, so finality can be verified from the chain alone.
5. **Next round.** A quorum of precommits of any kind without a decision starts a timeout, then round *r+1*. A validator that sees more than ⅓ of voting power in a higher round jumps there immediately.

Timeouts grow with the round (`propose = roundTimeoutMs + r·500 ms`, votes `= roundTimeoutMs/2 + r·500 ms`), which gives the liveness argument below. After a commit, the next height starts one `blockTimeMs` later.

## Why it is safe

Suppose blocks *A* and *B* are both committed at height *h*. Each has a quorum (> ⅔) of precommits, in rounds `rA ≤ rB`. If `rA = rB` the two quorums overlap in more than ⅓ of power, so some validators signed two different precommits in the same round: provable equivocation. If `rA < rB`, the precommitters of *A* are locked on *A* from round `rA`; they will prevote nil for any other block unless they see a proof-of-lock for it from a round after `rA` and before the new proposal, which requires > ⅔ prevotes for *B* in such a round, and that again forces an overlap of > ⅓ that prevoted for *B* in violation of their own lock rule, or equivocated. Either way committing two blocks requires ≥ ⅓ of power to break a rule that the protocol punishes.

This is the standard Tendermint argument; what we add is the implementation and the tests below.

## Why it is live (after the network stabilizes)

After global stabilization time, message delays are bounded; timeouts grow until they exceed that bound; then a round with an honest proposer in which every honest validator is in the same round finishes. A validator that has seen a proof-of-lock keeps its block as `validBlock` and re-proposes it, so a block that some validators already locked on is not abandoned. The previous single-phase design could be stuck by two conflicting locks; here a lock can be replaced only by a *newer proof-of-lock*, so conflicting locks resolve.

## What a validator persists (before any vote is sent)

`priv_validator_state.json`: for the current height, the votes it signed (keyed by `height:round:type`), its lock and valid block. It is written with `fsync` and an atomic rename **before** the vote is broadcast. After a crash the node refuses to sign a different vote in a `(height, round, type)` it already voted in and restores its lock. Keep this file with the node; restoring an old copy while the node was running elsewhere is double signing.

## Evidence and slashing

Two valid signatures from one validator of the **same type** (prevote or precommit) for the **same height and round** naming **different blocks** (nil counts as different) are equivocation evidence. (Votes for different blocks in *different* rounds are legal after an unlock, so they are not evidence.) Observers queue evidence, the next proposer includes it, and the chain applies it: 5% of bonded stake and of in-flight unbonding burned, validator jailed and **tombstoned**.

## Downtime

Each block's `lastCommit` lists signers. A validator missing from more than 50% of a window (`downtimeWindow`) is jailed for `jailBlocks` and slashed 0.1%; non-signers earn no issuance for that block.

## Transport

Votes and proposals are signed, so forged messages are rejected regardless of transport. They are pushed to every peer (`POST /p2p/msg`) and repaired by pull (`GET /p2p/round-state?height=h`, polled while a height is stalled). Blocks and commit certificates are exchanged for catch-up (`/p2p/blocks`, `/p2p/commit`). Validators are assumed to be directly connected (peer discovery builds a full mesh); relaying across partial topologies is not implemented.

## How it is tested

- `test/bft.test.js` runs real chains, blocks and signatures under a **deterministic simulated network and clock** (the only simulated parts): the happy path; 5 seeds of 35% message loss with heavy reordering followed by stabilization; a 2/2 partition (no progress, no fork, resumes on healing); a 3/1 partition; crash and restart from the persisted snapshot with no equivocation; an equivocating validator (evidence produced and accepted by the chain, honest 3/4 still finalize); **12 seeds at 50% loss** specifically to create the conflicting-lock situations that could halt the old design, each required to recover and never to fork; weighted voting.
- `test/network.test.js` runs 4 validators as separate nodes over real HTTP: block production, tx gossip, one node down, **halt without quorum**, restart from disk, a late full node syncing.

## Known limitations

1. **Not formally verified.** The rules follow Tendermint and the tests are extensive, but there is no machine-checked proof and no independent audit.
2. **Clock-based timeouts** need roughly synchronized clocks (NTP). Large skew slows rounds; it does not break safety.
3. **Proposer draw uses the parent block hash**, so a proposer can try a few block variants to bias the next draw. A VRF or beacon would remove this.
4. **Unauthenticated, unencrypted P2P** (plain HTTP/JSON). Consensus messages are signed, but eclipse and DoS attacks are possible. Phase 1 replaces the transport (QUIC/Noise) and adds peer scoring.
5. **Full-mesh assumption** for message delivery (no gossip relay), which is fine for ≤ ~150 validators but needs a gossip layer to scale and to tolerate sparse topologies.
6. **Proposer vote omission:** the commit certificate includes the precommits the proposer saw; a malicious proposer could omit honest signatures to hurt a validator's downtime score (bounded by the 50% window).
7. **No amnesia-attack slashing:** a validator that precommits in round *r* and later prevotes a different block *without* a proof-of-lock violates the lock rule but is not slashed (it can be shown by forensics, as in Tendermint).
8. **Validator-set changes** take effect one height after the block that changes stake; there is no explicit epoch.
9. **Voting-power cap** is a single-pass clamp and only binds with ≥ ~20 validators; it is off on devnet/testnet by default.

## Measuring decentralization

`aur_status.concentration` reports `halt33` (fewest validators able to stall finality: > ⅓ of power) and `control67` (fewest able to finalize alone: > ⅔). Raw validator counts say little; these numbers do. Also track hosting provider, jurisdiction and operator concentration off-chain: the protocol cannot see them.

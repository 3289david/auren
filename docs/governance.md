# On-chain governance

Implementation: `src/gov.js` (rules), `src/tx.js` (`submitProposal`, `vote`), `src/chain.js` (settlement, live parameters). Tests: `test/gov.test.js`.

## What governance can change

Only the whitelisted parameters below, each with a hard range enforced both when a proposal is submitted and again when it executes. Everything else (block time, address prefix, token decimals, signature schemes, the governance rules themselves) needs a new network or a coordinated software upgrade.

| Parameter | Range |
|---|---|
| `limits.compute`, `limits.state` | 1e6..1e9, 1e4..1e7 (block resource limits) |
| `baseFeeChangeDenominator` | 2..64 |
| `minBaseFee.compute`, `minBaseFee.state` | 1..1,000,000 sparks |
| `maxValidators` | 4..300 |
| `maxVotingPowerBps` | 100..10000 |
| `maxCommissionBps` | 0..5000 |
| `issuance.decayBps`, `issuance.floorPpm` | 0..5000, 0..50000 (the floor can never exceed 5%/yr) |
| `slashing.doubleSignBps`, `slashing.downtimeBps` | 0..5000, 0..1000 |
| `domain.price3/4/5` | 0..10^15 sparks |

The *initial* issuance rate, the unbonding period and the governance parameters are deliberately not changeable.

## Lifecycle

1. **Submit** (`submitProposal {title, description, changes}`): 1-5 parameter changes. A **deposit** (mainnet default 1,000 AUR) is escrowed and counted in the supply invariant.
2. **Vote** for `votingBlocks` (mainnet 201,600 ≈ 7 days): `yes`, `no`, `abstain`, `veto`. Weight is the voter's **bonded stake** (sum of all their delegations, evaluated at tally time). Validators do **not** vote on behalf of their delegators. Re-voting replaces the earlier vote. Accounts without stake can vote but carry no weight.
3. **Tally** at the end of the period:
   - no **quorum** (voted stake < 33.4% of all bonded stake) → rejected, **deposit burned**
   - **veto** ≥ 33.4% of voted stake → rejected, **deposit burned**
   - otherwise `yes / (yes + no + veto) > 50%` passes; the deposit is **refunded** whether it passes or fails the threshold.
   - `abstain` counts toward quorum only.
4. **Timelock** (`timelockBlocks`, mainnet 86,400 ≈ 2 days): a passed proposal waits before it takes effect, so users can exit, validators can prepare, and the community can react.
5. **Execute** at the end of block *E*: the changes are re-validated and stored as overrides in state; the new parameters apply from block *E+1* on every node, deterministically (replay-tested).

## Properties

- **Deterministic and replayable:** overrides live in state (`meta/params`), so a node replaying the log reaches identical parameters and an identical state root.
- **Live proof:** on a real 4-validator devnet, a proposal raised `limits.compute` from 30,000,000 to 45,000,000 after a 3/4 stake vote and a timelock (voting 60 blocks, timelock 20 blocks on devnet).
- **Conservation:** deposits are escrowed supply; burn/refund paths are tested against the invariant.
- **Parallel-safe:** `submitProposal` and `vote` share the `global:gov` access key, so a vote never races the creation of its proposal under lane scheduling.

## Using it

```bash
aurenctl gov list --network devnet
aurenctl gov propose --from alice --network devnet --title "Raise compute limit" \
    --description "Allow bigger blocks" --set limits.compute=45000000
aurenctl gov vote 1 yes --from <staker> --network devnet
```

The web wallet has a **Govern** tab (proposals, live tally bars, vote buttons, submit form). REST: `GET /proposals`; JSON-RPC: `aur_getProposals`.

## Limitations (honest)

- **Plutocratic by design.** Weight is stake. There is no delegation of votes, quadratic weighting or identity layer. Large holders dominate; the veto and quorum rules and the timelock are the checks.
- **No "validators vote for delegators who abstain" inheritance** (as in some chains). Delegators must vote themselves, which lowers turnout but avoids validator overreach.
- **Not an upgrade mechanism.** It changes parameters only. Changing consensus rules or transaction formats still needs a coordinated software release, with a height agreed in advance.
- **No emergency path** and no protection against a hostile supermajority beyond the timelock; a malicious majority could, for example, set `issuance.floorPpm` to 5% (the cap) or raise name prices to the range maximum. The ranges above are what bound that.
- Parameter-range choices are initial and should be reviewed before mainnet.

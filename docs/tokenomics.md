# Tokenomics

> Everything marked *(proposed)* is a starting assumption for public discussion before mainnet. The code implements the mechanisms; the numbers live in genesis and can change before launch.

## Asset

| | |
|---|---|
| Name / symbol | AUREN / **AUR** (working names) |
| Decimals | 9 (1 AUR = 1,000,000,000 sparks) |
| Roles | pays fees, staked for security, weights governance (Phase 2) |
| Cap | none; issuance is rule-based and tapers |

## Supply mechanics

```
net supply change per block = issuance − burn
issuance_per_block = supply × rate(year) / blocksPerYear
rate(year) = max(0.5%, 3.0% × 0.85^(year−1))        (year counted from genesis)
```

- **Who receives issuance:** validators that signed the previous block, pro rata to voting power; each validator splits it between commission and delegators via the reward index.
- **Burned:** base fees, slashed stake, `.aur` registration fees.
- **Not burned:** tips (to the proposer) and unclaimed rewards (they accrue to delegators).

| Year | Issuance rate |
|---:|---:|
| 1 | 3.00% |
| 2 | 2.55% |
| 3 | 2.17% |
| 5 | 1.57% |
| 10 | 0.69% |
| 13+ | 0.50% floor |

Example: with 1,000,000,000 AUR, year-1 issuance is ≈ 30,000,000 AUR. If fees burn 10,000,000 AUR that year, net growth is 20,000,000 AUR (2.0%). Burning does not guarantee a falling supply or a rising price; it only offsets issuance when usage is high enough.

## Why a tail emission instead of a hard cap

A fixed cap means validator income eventually depends only on fees. If fee revenue is thin, security spend falls with it, which weakens the chain precisely when it is young. A small perpetual floor (0.5%) keeps a predictable security budget while the decaying schedule removes most dilution over time. The trade-off is explicit: AUR is **not** fixed-supply. If the community prefers a cap, this is the parameter to debate before genesis.

## Initial distribution (proposed, for discussion)

| Bucket | Share | Terms |
|---|---:|---|
| Community, ecosystem & grants | 35% | released by public programs |
| Validator & staking bootstrap | 15% | seeds genesis validator stake and early delegations |
| Foundation treasury | 20% | vested over 4 years |
| Core contributors | 15% | 1-year cliff, 4-year vesting |
| Early supporters | 10% | vesting, disclosed terms |
| Security, audits & bug bounty | 5% | |

The protocol already supports vesting accounts (`vesting: {total, start, cliff, end}` in genesis): locked balance is excluded from `spendable` and cannot pay fees or be staked until it unlocks. No token sale is part of this repository.

## Fee flows

```
user ── baseCost ──▶ burned
     ── tip ───────▶ block proposer
     ── name fees ─▶ burned
issuance ──▶ signing validators ──▶ commission to operator, rest to delegators (claimable)
slashing ──▶ burned
```

## Staking parameters (mainnet defaults)

| | |
|---|---|
| Max validators | 150 |
| Min self-stake | 10,000 AUR |
| Voting-power cap | 10% of bonded stake per validator |
| Max commission | 20% |
| Unbonding | 28 days |
| Double-sign | 5% slashed, tombstoned |
| Downtime | jailed 1 day, 0.1% slashed if absent from > 50% of a window |

## Conservation invariant

The test-suite asserts after every scenario: `supply = Σ balances + Σ bonded + Σ unbonding + Σ accrued rewards`. Any change that mints or burns must keep this exact.

## Governance of economics

Issuance, fee, and slashing parameters may change only through an on-chain proposal with a long timelock and an explicit activation height (Phase 2). Until the governance module exists, parameters are fixed by genesis and change only through a coordinated, publicly announced upgrade.

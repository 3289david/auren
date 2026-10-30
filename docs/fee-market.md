# Adaptive Execution Market

## What it is

A fee mechanism that (1) prices two resources separately, (2) gives each transaction type a fixed, quotable cost, and (3) schedules transactions with disjoint state access into independent lanes.

It combines established ideas: EIP-1559 base-fee dynamics, multi-dimensional resource pricing, and declared-access-set scheduling. It is not claimed to be novel as a whole; it is claimed to be specified precisely and tested.

## Resources

| dimension | meaning | default block limit | target (50%) |
|---|---|---:|---:|
| `compute` | execution work in abstract units | 30,000,000 | 15,000,000 |
| `state` | bytes of state written (approximate) | 200,000 | 100,000 |

At default limits a block can hold ≈ 1,428 plain transfers by compute (the binding dimension), i.e. a protocol cap of roughly **700 transfers/s** at 2 s blocks. Limits are parameters and should be set from testnet measurements, not marketing.

## Base fee update

Per dimension, from the parent block's usage:

```
target = limit / 2
used > target:  base' = base + max(1, floor(base × (used − target) / target / 8))
used < target:  base' = base − floor(base × (target − used) / target / 8)
base' = max(base', minBase)
```

So a full block raises each base fee by 12.5% (e.g. 40 → 45), an empty block lowers it by 12.5%, and a block exactly at target leaves it unchanged.

Default start `{compute: 4, state: 200}` sparks/unit; floor `{1, 50}`. A transfer therefore costs `21,000×4 + 100×200 = 104,000 sparks ≈ 0.000104 AUR` at the start and `21,000×1 + 100×50 = 26,000 sparks = 0.000026 AUR` at the floor. That is cents-or-less at any plausible price, and the fee is burned, not paid to anyone.

## Paying

`baseCost = cost.compute × base.compute + cost.state × base.state` is **burned**. The sender signs `maxFee` and `tip`. Wallets quote `aur_feeQuote`, set `maxFee = baseCost × 2 + tip` to absorb two blocks of worst-case increases (1.125² ≈ 1.27), and are refunded implicitly: only `baseCost + min(tip, maxFee − baseCost)` is charged.

Because costs are fixed per type, there is no gas estimation and no out-of-gas failure. The trade-off: no user-deployed code yet. When an EVM layer arrives (Phase 2) it will meter compute and state through these same two dimensions.

## Lanes (parallel execution)

Every transaction type declares an **access set**, the keys it may read or write, e.g. a transfer touches `acct:<from>` and `acct:<to>`. `scheduleLanes` runs union-find over the keys:

- Transactions sharing any key end up in the same lane, in block order.
- Others are in different lanes and may execute in any order, or on separate threads.

Shared hotspots would defeat this, so they are removed by construction: fees, burns and tips accumulate during the block and are applied once at the end; the proposer's balance is not touched mid-block.

**Guarantee (tested):** for a random mix of 60 transfers, delegations and name registrations, executing lanes in forward, reverse and shuffled order yields identical state roots. If you add a transaction type whose handler touches a key not in its access set, this guarantee silently breaks. Add it to `access` and extend the test.

The reference node executes lanes sequentially on one thread (about 9,400 transfers/s validating, see `npm run bench`). The scheduler is the foundation for threaded or multi-process execution; it is not yet exploited for speed.

## Spam resistance

- Every transaction pays at least the floor base fee, so spam has a price.
- Sustained congestion drives the base fee up exponentially (+12.5%/block ≈ ×3.2 in 10 blocks), which is what throttles it.
- Per-sender nonce gaps are limited (256) and mempool size is capped (20,000); replacing a pending transaction requires ≥ 10% higher tip.
- State-heavy abuse is priced on its own `state` dimension rather than hiding in compute.

## Known gaps

- Cost constants are initial estimates, not benchmark-derived. They must be recalibrated on a distributed testnet.
- Tips are a simple first-price auction for the proposer; priority ordering is not yet MEV-resistant.
- No per-account or per-contract hotspot pricing yet (a contract everyone touches serializes execution); this is a research item for Phase 2.

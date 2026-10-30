# AUREN mainnet: NOT LAUNCHED

There is intentionally **no `genesis.json` in this directory**. A mainnet genesis is created once, from public inputs, by a ceremony that every participant can reproduce. Anything claiming to be "AUREN mainnet" before that is not.

| | |
|---|---|
| Chain ID | `auren-mainnet-1` |
| Address prefix | `aur` |
| Block time | 2 s (round timeout 4 s) |
| Max validators | 150 |
| Min self-stake | 10,000 AUR |
| Voting-power cap | 10% |
| Unbonding | 28 days |
| Issuance | 3.0% → 0.5% floor, decaying 15%/yr |

Parameters are the protocol defaults in `src/params.js`; the ceremony sets only `addressPrefix: "aur"`.

## Launch gates (all must be true, publicly)

- [ ] Two independent security audits of consensus, execution and staking; every finding fixed or accepted in writing; reports published in full.
- [ ] Phase 1 complete: two-round BFT with proof-of-lock; encrypted authenticated P2P; state sync.
- [ ] Public testnet running ≥ 3 months with ≥ 20 independent validators across ≥ 3 hosting providers and ≥ 3 jurisdictions; fault-injection results published; no consensus-safety or inflation bug open.
- [ ] Fee costs and block limits recalibrated from distributed testnet measurements.
- [ ] Final name/symbol clearance: trademark, domain, exchange-symbol conflicts checked.
- [ ] Legal review of the distribution and of any token-related communications in the jurisdictions involved.
- [ ] Allocation table and vesting terms published ≥ 30 days before genesis.
- [ ] Genesis hash published through ≥ 3 independent channels; every genesis validator confirms it independently.

## Genesis ceremony (when the gates are met)

1. **Publish** `allocations.json` (see `allocations.example.json`: addresses, amounts in AUR, optional vesting) and the launch time.
2. **Each validator** creates its own keys and signs a *gentx* offline:
   ```bash
   node bin/aurenctl.js gentx --from operator --network mainnet \
       --cons-pub $(node bin/auren-node.js show-validator --home ~/.auren) \
       --moniker my-validator --commission 5 --amount 10000 > gentx-my-validator.json
   ```
   The operator's address must have an allocation at least as large as the self-stake; the ceremony deducts it.
3. **Collect** gentxs in a public repository (pull requests). Anyone can verify signatures.
4. **Assemble** (deterministic):
   ```bash
   node scripts/genesis-ceremony.js --allocations allocations.json --gentx-dir ./gentxs \
       --genesis-time <unix ms> --out networks/mainnet
   ```
   It rejects invalid addresses, bad gentx signatures, under-funded self-stakes, fewer than 4 validators.
5. **Verify.** Every participant re-runs step 4 and compares the printed genesis hash, then `auren-node init --network mainnet` checks it again.
6. **Launch** at `genesisTime`.

## After launch

Faucet is disabled in code on mainnet (`auren-faucet` refuses). Parameter changes need the governance module (Phase 2); until then only publicly announced, coordinated upgrades.

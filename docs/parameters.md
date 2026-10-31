# Network parameters

Every setting of the network, with its default. A network's genesis file may override any of them; some can be changed later by a governance vote (see [Governance](governance.md)). This page is generated from the source (`src/params.js`), so it always matches the code.

Amounts shown in AUR are stored as sparks (1 AUR = 1,000,000,000 sparks). Fees are in sparks per resource unit.

| Parameter | Default | What it does |
|---|---|---|
| `symbol` | `AUR` |  |
| `decimals` | `9` |  |
| `addressPrefix` | `aur` | Address prefix of the network |
| `blockTimeMs` | `2000` | Target time between blocks |
| `roundTimeoutMs` | `4000` | Time before consensus moves to the next round |
| `maxClockDriftMs` | `5000` |  |
| `blocksPerYear` | `15768000` | Blocks in a year (used for issuance and name expiry) |
| `maxValidators` | `150` | Most validators in the active set |
| `minSelfStake` | `10000 AUR` | Smallest self-stake to become a validator |
| `maxVotingPowerBps` | `1000` | Cap on one validator's share of voting power (basis points) |
| `maxCommissionBps` | `2000` | Highest commission a validator may charge (basis points) |
| `unbondingBlocks` | `1209600` | Blocks before unstaked coins return |
| `jailBlocks` | `43200` | Blocks a validator is paused after downtime |
| `limits` |  | Most resource units per block |
| `limits.compute` | `30000000` |  |
| `limits.state` | `200000` |  |
| `initialBaseFee` |  | Starting fee per resource unit, in sparks |
| `initialBaseFee.compute` | `4` |  |
| `initialBaseFee.state` | `200` |  |
| `minBaseFee` |  | Lowest fee per resource unit, in sparks |
| `minBaseFee.compute` | `1` |  |
| `minBaseFee.state` | `50` |  |
| `baseFeeChangeDenominator` | `8` | Fee moves by at most 1/N per block |
| `issuance` |  | New AUR per year (ppm of supply), decay per year, and floor |
| `issuance.initialPpm` | `30000` |  |
| `issuance.decayBps` | `1500` |  |
| `issuance.floorPpm` | `5000` |  |
| `slashing` |  | Penalties for double signing and downtime |
| `slashing.doubleSignBps` | `500` |  |
| `slashing.downtimeBps` | `10` |  |
| `slashing.downtimeWindow` | `10000` |  |
| `slashing.maxMissedBps` | `5000` |  |
| `security` |  | Account protection limits |
| `security.minDelayBlocks` | `43200` |  |
| `security.limitWindowBlocks` | `43200` |  |
| `security.maxGuardians` | `9` |  |
| `evmChainId` | `77000` | Chain ID for Ethereum tools |
| `governance` |  | Voting rules |
| `governance.votingBlocks` | `201600` |  |
| `governance.timelockBlocks` | `86400` |  |
| `governance.deposit` | `1000 AUR` |  |
| `governance.quorumBps` | `3340` |  |
| `governance.thresholdBps` | `5000` |  |
| `governance.vetoBps` | `3340` |  |
| `tld` |  | Cost to create a name ending, and the most an ending owner may keep |
| `tld.price` | `10000 AUR` |  |
| `tld.maxOwnerShareBps` | `9000` |  |
| `node` |  | Node rewards: bond, epoch length, share of issuance |
| `node.bond` | `10000 AUR` |  |
| `node.epochBlocks` | `14400` |  |
| `node.poolBps` | `1000` |  |
| `rpc` |  | Random draw (RPC): share of issuance and how many tickets are drawn per block |
| `rpc.poolBps` | `500` |  |
| `rpc.committeeSize` | `7` |  |
| `domain` |  | Name prices by length (3, 4, 5+ letters) and the longest registration |
| `domain.price3` | `100 AUR` |  |
| `domain.price4` | `20 AUR` |  |
| `domain.price5` | `1 AUR` |  |
| `domain.maxYears` | `10` |  |

## Changeable by governance

- `limits.compute`
- `limits.state`
- `baseFeeChangeDenominator`
- `minBaseFee.compute`
- `minBaseFee.state`
- `maxValidators`
- `maxVotingPowerBps`
- `maxCommissionBps`
- `issuance.decayBps`
- `issuance.floorPpm`
- `slashing.doubleSignBps`
- `slashing.downtimeBps`
- `tld.price`
- `domain.price3`
- `domain.price4`
- `domain.price5`

The devnet and testnet override some defaults (shorter epochs and lower bonds so they are easy to try); see `src/netgen.js`.

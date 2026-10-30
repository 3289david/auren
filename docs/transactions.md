# Transaction types

Every action on AUREN is a transaction of one of these types. Generated from the source (`src/tx.js`).

**Cost** has two parts, a compute cost and a state cost, each priced by its own fee level. The last column is the fee at the lowest fee level, in AUR. Fees are burned. How to build and sign one: [Integrate](integrate.md).

| Type | What it does | Body fields | Compute | State | Fee at the floor (AUR) |
|---|---|---|---:|---:|---:|
| `transfer` | Send AUR | `to`, `amount` | 21,000 | 100 | 0.000026 |
| `delegate` | Stake with a validator | `validator`, `amount` | 60,000 | 250 | 0.000073 |
| `undelegate` | Start unstaking | `validator`, `amount` | 70,000 | 300 | 0.000085 |
| `claim` | Collect staking rewards | `validator` | 40,000 | 100 | 0.000045 |
| `createValidator` | Become a validator | `consPub`, `commissionBps`, `moniker`, `amount` | 150,000 | 600 | 0.00018 |
| `unjail` | Return a paused validator | (none) | 40,000 | 100 | 0.000045 |
| `registerNode` | Bond a node to earn node rewards | `payout` | 60,000 | 300 | 0.000075 |
| `unregisterNode` | Stop earning and unbond | (none) | 50,000 | 250 | 0.000063 |
| `nodeProof` | Prove a node stores the chain this epoch | `epoch`, `digest` | 60,000 | 150 | 0.000068 |
| `registerTld` | Create a name ending | `tld`, `open`, `price`, `ownerShareBps` | 100,000 | 500 | 0.000125 |
| `setTldPolicy` | Change an ending's price or rules | `tld`, `open`, `price`, `ownerShareBps` | 50,000 | 200 | 0.00006 |
| `transferTld` | Hand an ending to someone else | `tld`, `newOwner` | 40,000 | 100 | 0.000045 |
| `registerDomain` | Register a name | `name`, `years` | 80,000 | 400 | 0.0001 |
| `setDomainTarget` | Point a name at an address | `name`, `target` | 40,000 | 100 | 0.000045 |
| `transferDomain` | Give a name away | `name`, `newOwner` | 40,000 | 100 | 0.000045 |
| `setRecord` | Set a record on a name | `name`, `key`, `value` | 50,000 | 300 | 0.000065 |
| `setPrimary` | Set your primary name | `name` | 40,000 | 100 | 0.000045 |
| `evm` | Call or deploy a smart contract | `to`, `data`, `value`, `gasLimit` (use the Ethereum RPC) | by gas |  | by gas |
| `submitProposal` | Propose a network change | `title`, `description`, `changes` | 200,000 | 1,000 | 0.00025 |
| `vote` | Vote on a proposal | `id`, `option` | 50,000 | 150 | 0.000058 |
| `setSecurity` | Set trusted helpers, delay and daily limit | `guardians`, `threshold`, `delayBlocks`, `dailyLimit` | 60,000 | 400 | 0.00008 |
| `securityCancel` | Cancel a waiting security change | `account` | 40,000 | 100 | 0.000045 |
| `recoveryApprove` | Help recover an account | `account`, `newPub` | 50,000 | 200 | 0.00006 |
| `recoveryCancel` | Cancel a recovery | (none) | 40,000 | 100 | 0.000045 |

Common to every transaction: `chainId`, `type`, `from`, `nonce`, `maxFee`, `tip`, `body`, `v`, `pub`, `sig`.

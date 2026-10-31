# Error codes

What the network says when something does not work. A transaction can be **rejected** before it is included (it never costs anything), or **fail** after inclusion (the fee is still charged). The wallet shows these in plain words; this page is for developers. Generated from the source.

| Code | Meaning |
|---|---|
| `ALREADY_BONDED` |  |
| `ALREADY_PROVEN` | This node already proved storage this epoch |
| `AMOUNT_TOO_SMALL` | The amount rounds to nothing |
| `BAD_BODY` | A field in the transaction body is missing or invalid |
| `BAD_FEE` | Fee fields are invalid |
| `BAD_FROM` | The sender address is invalid |
| `BAD_NONCE` | The payment number is wrong (use pendingNonce) |
| `BAD_PROOF` | The storage proof does not match |
| `BAD_PUB` | The public key is invalid |
| `BAD_SCHEME` | Unknown signature type |
| `BAD_SIGNATURE` | The signature does not match |
| `BAD_TX` | The transaction is malformed |
| `BAD_VERSION` | Unsupported transaction version |
| `CONSENSUS_KEY_IN_USE` | That validator key is already used |
| `DAILY_LIMIT_EXCEEDED` | Over the account's daily limit |
| `EXCEEDS_STAKE` | You asked to unstake more than you have |
| `FEE_TOO_LOW` | maxFee is below the current fee |
| `FREE_FULL` |  |
| `FREE_LIMIT` |  |
| `INSUFFICIENT_BALANCE` | Not enough balance |
| `INSUFFICIENT_BOND` | Not enough to lock the node bond |
| `INSUFFICIENT_DEPOSIT` | The proposal deposit is too small |
| `INSUFFICIENT_FEE_FUNDS` | Not enough balance to pay the fee |
| `INTRINSIC_GAS_TOO_LOW` | Gas limit below the minimum for a contract call |
| `MEMPOOL_FULL` | The node is too busy; try again or another node |
| `NAME_DOES_NOT_RESOLVE_TO_YOU` | You can only make a primary name that points to you |
| `NAME_NOT_FOUND` | No such name |
| `NAME_TAKEN` | Someone already owns that name |
| `NODE_EXISTS` | This node is already registered |
| `NODE_TOO_NEW` | Bonded after the epoch began; earns from the next epoch |
| `NONCE_TOO_HIGH` | The payment number skips ahead |
| `NONCE_TOO_LOW` | The payment number was already used |
| `NOT_AUTHORIZED` | The signing key is not allowed to act for this account |
| `NOT_A_NODE` | This address is not a registered node |
| `NOT_DELEGATED` | You have no stake with that validator |
| `NOT_GUARDIAN` | Only a trusted helper can do this |
| `NOT_JAILED` | The validator is not paused |
| `NOT_OWNER` | Only the owner can do this |
| `NO_PENDING_RECOVERY` | There is no recovery in progress |
| `NO_SECURITY_CONFIG` | The account has no protection settings |
| `NO_SUCH_PROPOSAL` | No such proposal |
| `NO_SUCH_VALIDATOR` | No such validator |
| `REPLACEMENT_UNDERPRICED` | To replace a waiting payment, pay a higher tip |
| `STAKE_BELOW_MINIMUM` | Below the minimum validator stake |
| `STILL_JAILED` | The pause period has not ended |
| `TLD_NOT_FOUND` | That name ending does not exist |
| `TLD_RESTRICTED` | Only the owner can register under that ending |
| `TLD_TAKEN` | Someone already owns that ending |
| `TOO_MANY_RECORDS` | A name holds at most 16 records |
| `UNKNOWN_TYPE` | Unknown transaction type |
| `VALIDATOR_EXISTS` | That validator already exists |
| `VALIDATOR_TOMBSTONED` | The validator was banned for cheating |
| `VOTING_CLOSED` | Voting on this proposal has ended |
| `WRONG_CHAIN` | Signed for a different network |
| `WRONG_EPOCH` | That epoch is not the current one |

How to see the code: `aur_simulate` returns `code` for a payment that would fail, and a confirmed transaction's `receipt.code` is `OK` or one of the above.

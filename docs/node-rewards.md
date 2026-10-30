# Node rewards: earn AUR by running a node

Anyone who runs a full node can earn AUR. You do not need to be a validator.

## How you earn

1. **Bond.** Your node locks a bond (a deposit) once. You get it back when you stop (after the unbonding period).
2. **Prove.** Once per epoch the network picks one old block at random. Your node proves it still has that block's data. Only a node that really stores the chain can do this, and the proof is tied to your node's address, so it cannot be copied from another node.
3. **Get paid.** Each block, a share of newly issued AUR goes into a **node reward pool**. At the end of every epoch the pool is split equally between all nodes that proved they store the chain, and paid to each node's payout address. If nobody proves, the pool rolls over to the next epoch.

All of this is done by the node software for you.

## Run an earning node

```bash
auren join testnet --earn                 # rewards go to the node's own address
auren join testnet --earn <your-address>  # rewards go to your wallet
```

On the devnet and testnet the node asks the faucet for test coins to cover the bond. Otherwise, send the bond (plus a little for fees) to the address the node prints when it starts. The node then registers itself and proves storage every epoch. Leave it running.

| | devnet | testnet | mainnet |
|---|---|---|---|
| Bond | 100 AUR | 500 AUR | 10,000 AUR (default) |
| Epoch | 120 blocks | 1,800 blocks | 14,400 blocks (default) |
| Pool share | 10% of issuance | 10% | 10% |

The pool share comes out of the normal issuance. Validator rewards are issuance minus the pool share, so total issuance does not change.

## Rules

- You must be bonded **before** an epoch starts to earn in it. A new node starts earning from the next epoch.
- Epoch 0 has no history to challenge, so earning starts in epoch 1.
- One proof per node per epoch.
- A node that is offline or does not store the chain earns nothing that epoch. It loses nothing else.
- Running many identities does not help: each one needs its own bond and gets one equal share, the same return as one honest node per bond.

## Check on it

```bash
curl http://127.0.0.1:9650/nodes
```

Returns the pool, current epoch, the challenged block, and every registered node with whether it has proved this epoch. The explorer shows the same under **Nodes**. JSON-RPC: `aur_getNodes`.

## Manual control (CLI)

```bash
aurenctl node register --payout <address>   # bond (needs the bond amount in the account)
aurenctl node unregister                    # return the bond after the unbonding period
```

## Transactions

| Type | Body |
|---|---|
| `registerNode` | `payout` |
| `unregisterNode` | |
| `nodeProof` | `epoch`, `digest` = sha256(`address` + `\|` + canonical JSON of the challenged block's header and txs) |

Parameters: `node.bond`, `node.epochBlocks`, `node.poolBps`. See `src/noderew.js`.

## What this is not

Rewards go to nodes that store the chain, not to nodes that merely exist. Serving data to others and uptime beyond one proof per epoch are not measured. Validators still earn the largest share, for proposing and signing blocks.

# Randomized Proof Consensus (RPC): the random draw

A new way to earn AUR that does not depend on how powerful your computer is or how many coins you hold. Every block, a small group of nodes is drawn at random and paid. A phone and a supercomputer have exactly the same chance.

Reference implementation, simulations and the full specification: **https://github.com/3289david/rpc-consensus**

## In one minute

1. Run a node with **Earn** turned on (the Miner app, or `auren join <network> --earn`). **You need no coins.**
2. Your node joins the **free tier** (no deposit, no fee) and **proves it stores the chain** once per epoch. That proof is your **ticket**. A node that holds the refundable deposit joins the **full tier** instead.
3. Each block, the network draws a **committee** of ticket holders using a **random beacon** that nobody can predict. Drawn nodes share that block's pool, paid straight to their reward address.
4. You do nothing extra. The node does steps 2 and 3 for you.

Look at it live in the explorer under **Draw**.

## Why it is hardware-neutral

- The chance of being drawn is **the same for every ticket**. A faster computer does not get more tickets, and holding more coins does not either.
- A ticket is cheap to verify. A phone can hold one.
- Staking AUR is not needed to be drawn, and neither is any deposit: the free tier needs no coins at all.

## Starting with no coins: two tiers

A new network has no coins, so a deposit-only design would lock everyone out. RPC has two tiers:

| | Free tier | Full tier |
|---|---|---|
| Deposit | none | refundable (`node.bond`) |
| Fee to join and prove | none | normal tiny fee |
| Seats in each draw | `rpc.freeSeats` of `rpc.committeeSize` (default 2 of 7) | the rest |
| Limits | `rpc.freeRegsPerEpoch` joins per epoch, `rpc.freeTxPerBlock` free transactions per block | none |
| Epoch node-reward pool | no | yes |

Seats a tier cannot fill go to the other, so at the very start, when nobody has coins, every seat goes to the free tier. A free node **upgrades itself** to the full tier once its own account holds the deposit (rewards paid to the node's address build it up).

The cost of this is real and stated plainly: **free identities cost nothing**, so someone can run many of them and take the free seats. The limits bound the damage: free identities can take at most the reserved free seats once bonded miners exist, they can join only so fast, and they cannot influence block finality, which BFT proof-of-stake still decides. What they can do is dilute the free tier's share of the pool.

## The hard problem: fake nodes

If every identity had the same chance and identities were free, one person could create thousands and win almost every draw. That is the **Sybil problem**, and no open system avoids it for free. RPC raises the cost of each extra identity:

| Defence | What it does |
|---|---|
| **Bond** | Each identity locks a deposit (`node.bond`). Ten thousand fake identities need ten thousand deposits. |
| **Contribution proof** | A ticket exists only if the node proved it stores the chain this epoch or last. A ticket cannot be made without the data (free tier included). |
| **Epoch expiry** | Tickets expire after about one epoch, so an old proof cannot be reused forever. |
| **One ticket per identity per epoch** | Proofs are tied to the node's own address, so one proof cannot serve two identities. |

Be honest about the limit: these make fake identities **cost something**, but they do not make them impossible. An attacker with enough capital for many bonds can still hold many tickets, just as in any stake-based system. What RPC changes is that **a bond buys a ticket, not extra power per coin**, and that hardware cannot buy tickets at all. See [the specification](https://github.com/3289david/rpc-consensus/blob/main/docs/SPEC.md) for the analysis.

## How the draw works

```
previous beacon + the signatures that finalized the last block
                  |
                  v
         new beacon (sha256)
                  |
                  v
   draw k distinct tickets, equal weight
                  |
                  v
   pay the block's pool equally to the winners
```

- **Beacon.** `beacon(h) = sha256(beacon(h-1) | sorted precommit signatures of block h-1)`. It cannot be computed before block h-1 is final, and every node computes the same value.
- **Draw.** For `i = 0..k-1`, pick an index from `sha256(beacon | i)` among the remaining ticket holders (sorted by address). Anyone can recompute it.
- **Payout.** The pool grows by `rpc.poolBps` of each block's issuance and is paid to the winners' payout addresses. If nobody holds a ticket, the pool keeps growing, so a quiet network never loses the reward.

### What is and is not proven

| Property | Status |
|---|---|
| Deterministic and verifiable by anyone | Yes |
| Equal chance for every ticket, hardware-neutral | Yes (tested) |
| Predicting a draw before the previous block is final | Not possible |
| Bias-free beacon | **Not fully.** The block proposer chooses which two-thirds of precommits to include, so it has a small amount of influence over the beacon. A threshold-signature beacon (threshold BLS or a distributed verifiable random function) removes this and is the planned upgrade. |
| Finality | The draw does not decide blocks. [BFT consensus](consensus.md) still finalizes every block. |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rpc.poolBps` | 500 (5%) | Share of each block's issuance that goes to the draw |
| `rpc.committeeSize` | 7 | How many tickets are drawn per block |
| `node.bond` | see [Node rewards](node-rewards.md) | Deposit per identity |
| `node.epochBlocks` | see [Node rewards](node-rewards.md) | Epoch length (ticket lifetime) |

The draw's share comes out of the validators' part of new issuance, so total issuance does not change: validators receive issuance minus the node-reward pool (10%) minus the draw pool (5%).

## Compared with the other ways to earn

| | Staking | Running a validator | Node rewards | Random draw |
|---|---|---|---|---|
| Needs coins | yes | yes (large) | a deposit | a deposit |
| Needs a good computer | no | yes | stores the chain | stores the chain |
| Payout | steady, by stake | steady, by stake | split evenly each epoch | lumpy: random each block |
| Chance depends on hardware | no | partly | no | no |

The draw pays the same people as node rewards, but in a different shape: instead of an even split once per epoch, small winnings arrive randomly every block.

## Check a draw yourself

Take the beacon from the explorer's Draw page (or `GET /draw`) and the ticket-holder list, then run the same `pick` function from the reference repository. You will get the same committee, which is how anyone can check that the network did not cheat.

```bash
git clone https://github.com/3289david/rpc-consensus
cd rpc-consensus
node examples/04-verify-draw.js
```

## Transactions and API

No new transaction types: tickets come from `registerNode` and `nodeProof` ([Node rewards](node-rewards.md)). Read status with `GET /draw` or `aur_getDraw` ([RPC API](rpc-api.md)).

## Where this came from

RPC (Randomized Proof Consensus) started as a design proposal for an independent chain with probabilistic validator selection, a distributed random beacon, BFT finality and hardware-neutral participation. AUREN keeps its proven BFT proof-of-stake core and adds the parts of RPC that can be built safely today: **tickets from a contribution proof, a verifiable random beacon and a random draw that pays participants**. The open research problems (a threshold-signature beacon and a stronger scarce resource for tickets) are listed in the specification.

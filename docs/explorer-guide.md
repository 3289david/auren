# Explorer guide

The explorer lets anyone look at everything that happens on AUREN. Nothing is hidden: every block, payment, account and validator is public.

## Searching

The search box accepts:

- a **block number**, like `1234`
- a **payment ID** (64 characters)
- an **address**, like `taur1…` or an Ethereum-style `0x…`
- a **name**, like `alice.aur` or `alice.david`
- the words `governance` or `tlds`

## Pages

| Page | What you see |
|---|---|
| **Home** | Latest blocks and payments, fee chart, validators, headline numbers |
| **Blocks** | Every block: time, number of payments, who created it, how full it was |
| **Transactions** | Every payment and action, newest first |
| **Validators** | Who runs the network, their share, fee cut and reliability |
| **Accounts** | The biggest balances |
| **Nodes** | The node-reward pool and nodes that earn rewards |
| **Names** | Name endings (TLDs) and who owns them |
| **Governance** | Proposals that change network settings, and how the vote is going |

## Reading a payment page

- **Status**: confirmed and in which block, or still waiting.
- **From / to / amount** and the **fee**. Fees are burned, which means the coins are removed for good.
- For smart-contract calls: gas used, the contract created, and logs.

## Reading an address page

Balance, spendable amount, number of payments sent, stake, and recent activity. If an address is a smart contract you also see its code. If it has a name, the name is verified in both directions so nobody can fake it.

## Reading a name page

Owner, the address it points to, and records. The page shows whether the answer was **verified by your own device** against the chain, so you do not have to trust the server.

## Fee chart

On the home page the gold line is the fee level and the blue bars show how full blocks are. When blocks are more than half full the fee rises a little; when they empty it falls back to the minimum.

## Choosing a network

Use the selector at the top, just like in the wallet. The explorer shows the network you are connected to.

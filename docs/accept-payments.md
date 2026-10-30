# Accept AUR payments (merchant guide)

How a shop, a game or a service can take payments in AUR and know they are final.

## The idea

1. You create a wallet that only receives.
2. For each order, you give the customer your address and an amount (and an order ID you track yourself).
3. You watch the chain for a payment that matches. When it shows as confirmed, it is final: AUREN has no reorganisations once a block is confirmed.

## Use a name as your payment address

Register a name like `myshop.aur` ([Names](domains.md)). Customers can pay the name instead of a long address, and their wallet checks it for them.

## Watch for payments

Poll the account's recent activity:

```bash
curl "https://testnet.auren.im/account/YOUR_ADDRESS/txs?limit=25"
```

or with the SDK:

```js
const { Client } = require('./sdk/js');
const node = new Client('https://testnet.auren.im');
const seen = new Set();
setInterval(async () => {
  const rows = await node.call('aur_getAccountTxs', ['YOUR_ADDRESS', 25]);
  for (const t of rows) {
    if (seen.has(t.hash) || t.type !== 'transfer' || t.body.to !== 'YOUR_ADDRESS') continue;
    if (t.status !== 1) continue;                    // only payments that succeeded
    seen.add(t.hash);
    console.log('paid', t.body.amount, 'sparks by', t.from, 'in block', t.height);
  }
}, 2000);
```

## Matching payments to orders

A transfer has no memo field. The simplest reliable ways:

- **One address per order.** Derive a fresh address for each customer. The payment tells you the order.
- **Unique amounts.** Ask for `10.000137` AUR where the last digits identify the order.
- **Names.** Give each customer a sub-account name like `order123.myshop`. (Register an ending you own and keep it restricted.)

## Confirmations

A payment is final as soon as its block is confirmed, usually within a few seconds. There is nothing to wait for beyond that. Check `receipt.status === 1` (the payment succeeded) and that the amount and recipient match.

## Refunds

Send a normal transfer back to the `from` address of the payment.

## Safety

- Keep the receiving wallet's recovery key offline. For withdrawals use a separate wallet with a daily limit and trusted helpers ([Wallet guide](wallet-guide.md)).
- Pin the network's genesis hash ([Integrate](integrate.md)) so you know you are talking to the right chain.
- Never accept a payment as final from a transaction that is only "waiting".

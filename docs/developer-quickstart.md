# Developer quickstart

Send your first payment from code in about ten minutes.

## 1. Pick a network

Use the public devnet: `https://devnet.auren.im` (mirror `https://devnet.krl.kr`). It has a faucet at `https://devnet.auren.im/faucet`. The testnet and mainnet work the same way; see [Networks](networks.md).

Check it:

```bash
curl https://devnet.auren.im/status
```

## 2. Make a wallet and get coins (JavaScript)

```js
const { Client, Wallet } = require('./sdk/js');
const node = new Client('https://devnet.auren.im');
const wallet = Wallet.generate('daur');
await fetch('https://devnet.auren.im/faucet/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address }) });
console.log(wallet.address, await node.balance(wallet.address));
```

## 3. Send a payment

```js
const friend = Wallet.generate('daur');
const tx = await wallet.transfer(node, friend.address, '1.5');
console.log(tx.receipt.status === 1 ? 'confirmed' : 'failed', await node.balance(friend.address));
```

## 4. The same in Python

```python
from auren import Client, Wallet
node = Client("https://devnet.auren.im")
wallet = Wallet.generate("daur")
friend = Wallet.generate("daur")
# fund the wallet from the faucet first, then:
wallet.transfer(node, friend.address, "1.5")
```

## 5. Names and name endings

```js
await wallet.registerName(node, 'alice');                       // alice.aur
await wallet.createTld(node, 'david', { price: '1' });          // your own ending
await wallet.registerName(node, 'bob.david');
console.log(await node.resolve('bob.david'));                   // owner, target, proof
```

## 6. Read the chain

```bash
curl https://devnet.auren.im/blocks?limit=5
curl https://devnet.auren.im/account/<address>
curl https://devnet.auren.im/tlds
```

Every call is also available as JSON-RPC at `POST /rpc`, including the Ethereum `eth_*` methods.

## 7. Use Ethereum tools

```js
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://devnet.auren.im/rpc', 77001);
```

Chain IDs: devnet 77001, testnet 77002, mainnet 77000. More in [EVM](evm.md).

## Where next

| Topic | Read |
|---|---|
| All API methods | [Integrate](integrate.md), [RPC API](rpc-api.md) |
| Signing a transaction yourself | [Integrate](integrate.md) |
| Smart contracts | [EVM](evm.md) |
| Command-line tool | [CLI reference](cli.md) |
| The three networks and their addresses | [Networks](networks.md) |

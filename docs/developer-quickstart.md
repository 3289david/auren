# Developer quickstart

Send your first payment from code in about ten minutes.

## 1. Get a node

Run a devnet on your computer (needs Node.js 20 or newer, nothing else):

```bash
git clone https://github.com/3289david/auren
cd auren
node scripts/devnet.js --clean
```

It starts four validators. The first one answers on `http://127.0.0.1:9650`, and a faucet runs on port 9690. (To use a public network instead, connect to a node of that network.)

Check it:

```bash
curl http://127.0.0.1:9650/status
```

## 2. Make a wallet and get coins (JavaScript)

```js
const { Client, Wallet } = require('./sdk/js');
const node = new Client('http://127.0.0.1:9650');
const wallet = Wallet.generate('daur');
await fetch('http://127.0.0.1:9690/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address }) });
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
node = Client("http://127.0.0.1:9650")
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
curl http://127.0.0.1:9650/blocks?limit=5
curl http://127.0.0.1:9650/account/<address>
curl http://127.0.0.1:9650/tlds
```

Every call is also available as JSON-RPC at `POST /rpc`, including the Ethereum `eth_*` methods.

## 7. Use Ethereum tools

```js
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:9650/rpc', 77001);
```

Chain IDs: devnet 77001, testnet 77002, mainnet 77000. More in [EVM](evm.md).

## Where next

| Topic | Read |
|---|---|
| All API methods | [Integrate](integrate.md), [RPC API](rpc-api.md) |
| Signing a transaction yourself | [Integrate](integrate.md) |
| Smart contracts | [EVM](evm.md) |
| Command-line tool | [CLI reference](cli.md) |
| Running a local test network | [Networks](networks.md) |

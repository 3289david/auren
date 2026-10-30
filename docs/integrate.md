# Integrate AUREN into your wallet or app

Everything a wallet, exchange, game or bot needs: the networks, the API, the SDKs and how to sign a transaction yourself.

## Pick a network

| | Chain ID | Address prefix | Ethereum chain ID |
|---|---|---|---|
| Mainnet | `auren-mainnet-1` | `aur1…` | 77000 |
| Testnet | `auren-testnet-1` | `taur1…` | 77002 |
| Devnet | `auren-devnet-1` | `daur1…` | 77001 |

`networks/networks.json` lists the official genesis hashes. Pin the genesis hash of the network you integrate with, so a wrong or malicious node is detected. A node serves its genesis at `GET /genesis`.

Amounts everywhere are decimal strings in **sparks**: 1 AUR = 1,000,000,000 sparks.

## The API

Every network has two public addresses that serve the same API (the second is a mirror):

- **REST** for reads, such as `GET /status`, `/account/{address}`, `/tx/{hash}`, `/tlds`.
- **JSON-RPC 2.0** at `POST /rpc` for everything, including sending transactions.
- **Ethereum JSON-RPC** on the same `/rpc` (`eth_*`), so ethers, viem, MetaMask and Hardhat work. Add the network with the chain ID from the table.

The full, machine-readable reference is the [OpenAPI file](https://github.com/3289david/auren/blob/main/website/api/openapi.json). Browse the methods in [rpc-api.md](rpc-api.md).

```bash
curl https://testnet.auren.im/status
curl https://devnet.auren.im/account/daur1...
curl -X POST https://testnet.auren.im/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"aur_status","params":[]}'
```

## SDKs

| Language | Where | Notes |
|---|---|---|
| JavaScript (Node 20+) | `sdk/js` | `Client`, `Wallet`, amounts in AUR |
| JavaScript (browser) | `website/aurlib.js` | the library the wallet uses; global `Aur` |
| Python 3 | `sdk/python/auren.py` | no dependencies, pure-Python Ed25519 |
| Any language | this page | sign a transaction yourself, below |

JavaScript:

```js
const { Client, Wallet } = require('./sdk/js');
const node = new Client('https://testnet.auren.im');
const wallet = Wallet.generate('daur');            // or Wallet.fromSeed(seedHex, 'daur')
console.log(wallet.address, await node.balance(wallet.address));
await wallet.transfer(node, 'daur1...', '1.5');    // amounts in AUR
await wallet.registerName(node, 'alice');          // alice.aur
await wallet.createTld(node, 'david', { price: '1', ownerSharePercent: 80 });
```

Python:

```python
from auren import Client, Wallet
node = Client("https://testnet.auren.im")
wallet = Wallet.generate("daur")
wallet.transfer(node, "daur1...", "1.5")
wallet.register_name(node, "alice")
```

## Keys and addresses

| Scheme byte | Key | Use |
|---|---|---|
| 0 | Ed25519 | software wallets (the default) |
| 2 | ECDSA P-256 (WebAuthn) | phone passkeys and security keys |
| 4 | secp256k1 (Ethereum) | Ethereum wallets; the address is the same 20 bytes as `0x…` |

An address is Bech32 of `[scheme byte] + sha256(scheme byte ‖ public key)[0..20]` with the network prefix. Ethereum accounts also answer at their `0x` address (`GET /account/0x…`). One seed can serve every network; only the prefix changes.

## Sign a transaction yourself

A transaction is a JSON object:

```json
{ "chainId": "auren-devnet-1", "type": "transfer", "from": "daur1…", "nonce": 7,
  "maxFee": "300000", "tip": "1000", "body": { "to": "daur1…", "amount": "1500000000" },
  "v": 1, "pub": "<public key hex>", "sig": "<signature hex>" }
```

1. **Nonce:** use `pendingNonce` from `aur_getAccount`.
2. **Fee:** `maxFee` must be at least the base fee for the type (from `aur_feeQuote`) plus your `tip`. Setting it to twice the quote is safe; unused fee is not charged. The fee is burned.
3. **Sign:** build the object without `sig`, serialize it as **canonical JSON** (keys sorted, no spaces, amounts as decimal strings), prepend the bytes `AUREN/tx/v1` followed by a zero byte, and sign those bytes with your key. Put the signature (hex) in `sig`.
4. **Check:** send it to `aur_simulate` first. It returns the effects, the fee and whether it would succeed, without changing anything.
5. **Send:** `aur_sendTx`. The result has the transaction hash (`sha256` of the canonical JSON including `sig`).
6. **Wait:** poll `aur_getTx(hash)` until `status` is `confirmed`; `receipt.status` is `1` on success.

Transaction types and their bodies are listed in [protocol.md](protocol.md). The common ones:

| Type | Body |
|---|---|
| `transfer` | `to`, `amount` |
| `delegate` / `undelegate` | `validator`, `amount` |
| `claim` | `validator` |
| `registerDomain` | `name` (`alice`, `alice.aur` or `alice.david`), `years` |
| `setDomainTarget` | `name`, `target` |
| `registerTld` | `tld`, `open`, `price`, `ownerShareBps` |
| `registerNode` / `nodeProof` | see [node-rewards.md](node-rewards.md) |
| `evm` | smart-contract calls; use the Ethereum RPC instead |

Reference implementations to copy: `signTx` in `src/tx.js` (JavaScript) and `Wallet.build` in `sdk/python/auren.py`. The two produce byte-identical signatures, which a test checks.

## Names

- Look up: `GET /domain/{name}` or `aur_resolve` (with a Merkle proof). `website/anr.js` verifies proofs on the client, so a wallet does not have to trust the node.
- Show a name for an address: `aur_reverse`, checked in both directions.
- Register `.aur` names and your own name endings with `registerDomain` and `registerTld`; see [domains.md](domains.md). The website's [Names page](https://github.com/3289david/auren/blob/main/website/names.html) links straight into the wallet, so you can send users there: `wallet.html?tab=names&name=alice.aur`.

## Smart contracts and Ethereum tools

Point any Ethereum tool at the network address plus `/rpc` (for example `https://testnet.auren.im/rpc`) with the Ethereum chain ID above. Raw Ethereum transactions are accepted. See [evm.md](evm.md).

## Tips for wallet makers

- Use **`aur_simulate`** before every send and show the user the fee and result.
- Show amounts in AUR, never sparks. Round only for display.
- Refuse to pay a name that resolves differently in two places (the `ambiguous` result of `aur_resolve` across namespaces).
- Pin the genesis hash of the network you integrate with.
- Never log seeds. Keep them encrypted at rest.

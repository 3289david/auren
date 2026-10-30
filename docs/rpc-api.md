# Node API

Every node serves HTTP on its RPC port (default `9650`). CORS is open (`*`) for read use; put a proxy with TLS and rate limits in front of public endpoints. Amounts are decimal strings of sparks.

## JSON-RPC 2.0: `POST /rpc`

```bash
curl -s localhost:9650/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"aur_status","params":[]}'
```

Batches (arrays, ≤ 50) are supported.

| Method | Params | Returns |
|---|---|---|
| `aur_status` | | chain ID, height, base fees, transfer fee quote, supply/burned/bonded, issuance rate, validator concentration, peers, mempool |
| `aur_getParams` | | resolved protocol parameters |
| `aur_getNodes` | `[address?]` | node-reward pool, epoch, challenged block and registered nodes |
| `aur_getTlds` | | every TLD (built-in `.aur` first): owner, open, price, owner share, name count |
| `aur_getTld` | `[tld]` | one TLD's rules, or `null` |
| `aur_getBlock` | `[height \| "latest"]` | block + commit certificate |
| `aur_getTx` | `[hash]` | `{status: "confirmed"\|"pending", tx, height, receipt}` |
| `aur_getAccount` | `[address]` | balance, spendable, nonce, `pendingNonce`, security config, delegations, unbonding |
| `aur_getValidators` | | validators (power, status) + concentration |
| `aur_feeQuote` | | base fees and the exact base cost per transaction type |
| `aur_sendTx` | `[signedTx]` | `{hash, isNew}`; error `-32010` with `data` = reason code |
| `aur_simulate` | `[signedTx]` | `{ok, code, fee, burned, effects[]}` without changing state |
| `aur_resolveDomain` | `[name]` | owner, target, expiry, or `null` |
| `aur_getPeers` | | peer URLs |

Common rejection codes: `BAD_SIGNATURE`, `WRONG_CHAIN`, `BAD_NONCE`, `NONCE_TOO_LOW`, `FEE_TOO_LOW`, `INSUFFICIENT_FEE_FUNDS`, `NOT_AUTHORIZED`, `REPLACEMENT_UNDERPRICED`, `MEMPOOL_FULL`.
Execution failure codes (in the receipt, `status: 0`): `INSUFFICIENT_BALANCE`, `DAILY_LIMIT_EXCEEDED`, `NO_SUCH_VALIDATOR`, `NOT_DELEGATED`, `EXCEEDS_STAKE`, `NAME_TAKEN`, `NOT_OWNER`, `NOT_GUARDIAN`, …

## REST (GET, JSON)

`/txs?limit=25&before={height}` (newest transactions across blocks) · `/richlist?limit=50` (accounts by balance) · `/account/0x…` (Ethereum-style address) · `/status` · `/validators` · `/fees` · `/params` · `/block/{height|latest}` · `/blocks?limit=20&before={height}` · `/account/{address}` · `/account/{address}/txs?limit=25` (newest first, any address involved in the tx) · `/tx/{hash}` · `/domain/{name}` (`label` or `label.tld`) · `/nodes` · `/tlds` · `/tld/{tld}` · `/metrics` (Prometheus text)

`POST /tx` accepts a signed transaction body.

## Building a transaction

```js
const { RpcClient, Wallet } = require('./src/client');
const { Keypair } = require('./src/crypto');

const rpc = new RpcClient('http://127.0.0.1:9650');
const st = await rpc.status();
const wallet = new Wallet(Keypair.fromSeedHex(process.env.SEED), st.addressPrefix);
const res = await wallet.send(rpc, 'transfer', { to: 'daur1…', amount: '1500000000' });   // waits for inclusion
```

`wallet.build()` fills `chainId`, `nonce` (from `pendingNonce`) and `maxFee = baseCost × 2 + tip`. To sign by hand: Ed25519 over `"AUREN/tx/v1\0" ‖ canonicalJSON(tx without sig)`; see `src/tx.js` (`signingBytes`).

## P2P endpoints (node ↔ node)

`GET /p2p/info`, `/p2p/blocks?from=&limit=`, `/p2p/lock?height=`; `POST /p2p/tx`, `/p2p/proposal`, `/p2p/commit`, `/p2p/hello`. These are unauthenticated in this version; do not expose them to untrusted networks without a filtering proxy.

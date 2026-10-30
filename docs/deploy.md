# Deploying the official public network (CORE TEAM ONLY)

> For the core team that operates the official seed and validator machines. To simply run a node, see `RUN-A-NODE.md`. There is only one official testnet and one mainnet; do not create parallel ones.

Everything in this repository runs for real on a single machine (`npm run devnet`). A **public** network additionally needs machines on the internet and a domain, which only you can provide. This guide is the exact path from this repo to a public testnet with a wallet and explorer anyone can open.

Mainnet is a different decision with its own gates: see `networks/mainnet/README.md`. Do not skip them.

## What you need

| Item | Notes |
|---|---|
| 4+ Linux hosts | one validator each, at least 2 cores / 4 GB / SSD; use **different providers and regions**, otherwise it is one point of failure with four names |
| A domain | for TLS RPC + wallet + explorer (`rpc.testnet.<yours>`) and a faucet host |
| Node.js 20+ on each host | no other dependencies |
| Time sync | `chrony`/NTP on every host; consensus rounds use local clocks |

## 1. Generate the genesis (on a trusted machine)

```bash
npm run gen:testnet            # networks/testnet/genesis.json + networks/testnet/_private/
```

`_private/` contains, per genesis validator, a home directory with its consensus key and config, plus `accounts.json` (faucet key, operator keys). **Treat it as secret**: copy each `nodeN/` to its own host over SSH, then delete the rest or keep it offline. Commit only `genesis.json` and `network.json`.

## 2. Start the validators

On each host (replace the repo path):

```bash
node bin/auren-node.js start --home ~/nodeN --rpc-host 0.0.0.0 --website \
  --self-url http://<this-host-public-ip>:9650 \
  --peers http://<ip-of-node0>:9650,http://<ip-of-node1>:9650,http://<ip-of-node2>:9650
```

Open TCP 9650 between the validators (security group allow-list by IP). Use `deploy/auren-node.service` to keep it running. **One instance per consensus key, ever.**

All nodes must be up within a few minutes of `genesisTime` (printed by `gen:testnet`).

## 3. Verify it is one network

```bash
node scripts/verify-network.js http://ip0:9650 http://ip1:9650 http://ip2:9650 http://ip3:9650
```

Passes only if all nodes share the genesis hash and agree on a block hash and state root at a common height, finality certificates exist, and no node lags.

## 4. Public RPC, wallet and explorer over HTTPS

Put `deploy/Caddyfile` in front of one or two nodes (not the validators if you can avoid it: run separate full nodes with `--website` that peer with them). The node serves the landing page, `/wallet.html` and `/explorer.html` itself, and the browser pages automatically use the origin they were loaded from as the RPC URL, so there is nothing else to configure.

```bash
node bin/auren-node.js init --network testnet --home /var/lib/auren --full-node
node bin/auren-node.js start --home /var/lib/auren --rpc-host 127.0.0.1 --website --peers http://ip0:9650,...
```

Block `/p2p/*` at the proxy (the Caddyfile does).

## 5. Faucet

```bash
node bin/auren-faucet.js --rpc http://127.0.0.1:9650 \
  --key-file networks/testnet/_private/faucet.json --port 9690 --amount 100 --cooldown-sec 86400
```

Put the faucet's URL into `networks/networks.json` (`testnet.faucet`, `testnet.rpc`, `testnet.seeds`) and into the wallet's faucet setting if it is not on the same host name (browser storage key `auren.faucet`). The faucet refuses to run on a network whose genesis says `mainnet`.

## 6. Invite outside validators

Follow `docs/validators.md`. Give them the genesis file, its hash (`node bin/auren-node.js genesis-hash --home <dir>`), seed URLs, and some testnet AUR (the faucet's 100 AUR is below the 10,000 AUR minimum self-stake, so transfer stake from the treasury key in `accounts.json`).

## 7. Operate it like it matters

- Monitor `/metrics` (`deploy/prometheus.yml`) and alert on height stalls and `auren_catching_up`.
- Run the fault drills from `docs/networks.md` and publish results.
- Back up each validator's `priv_validator_key.json` and `data/priv_validator_state.json`.
- Keep security contact and disclosure policy current (`SECURITY.md`).

## What stays your decision

Hosting, domain, who runs the genesis validators, token distribution, legal review, and when (or whether) to go beyond testnet. The software does not decide these for you.

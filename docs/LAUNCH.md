# Launching a network: the complete path (CORE TEAM ONLY)

> **Not for users or node operators.** There is exactly one mainnet, one testnet and one devnet, and they are created once, by the core team, using the tools below. If you just want to use AUREN or run a node, read `GETTING-STARTED.md` and `RUN-A-NODE.md` and **join** the existing network with `./auren join testnet`. Running `make-bundles` yourself creates a *different, unofficial* network that no wallet or explorer will recognize.

Everything below is implemented in this repository and was exercised on a real multi-process network. The parts that need *your* servers, domain, people and legal decisions are marked **YOU**.

## A. Public testnet (do this first; ~1 hour of work)

1. **YOU:** get 4+ machines (different providers/regions; 2 cores, 4 GB, SSD) with public IPs. Install Node.js 20+.
2. Put the repo on each machine (`git clone`, or copy the folder).
3. On one trusted machine generate the bundles (keys are created here, treat the output as secret):
   ```bash
   node scripts/make-bundles.js --network testnet --hosts 203.0.113.10,203.0.113.11,203.0.113.12,203.0.113.13 --out ./bundles
   ```
   It prints the genesis hash and genesis time. Each `bundles/nodeN/` holds that validator's genesis, key, config (peers already pointing at the other hosts), `start.sh`, `start.ps1` and a systemd unit.
4. **YOU:** copy `bundles/nodeN/` to machine N over SSH. Open TCP 9650 between the validators only. `chmod 600 priv_validator_key.json`.
5. Start all four within a few minutes of the genesis time: `sh start.sh` (or install the systemd unit). One instance per key, ever.
6. Verify from your laptop:
   ```bash
   node scripts/verify-network.js http://203.0.113.10:9650 http://203.0.113.11:9650 http://203.0.113.12:9650 http://203.0.113.13:9650
   ```
7. Public access: put `deploy/Caddyfile` in front of one full node (not a validator) and point a domain at it. Each node serves the **website, wallet and explorer** itself (`--website`), plus Ethereum-compatible RPC (chain id 77002 on testnet).
8. Faucet: `node bin/auren-faucet.js --rpc http://127.0.0.1:9650 --key-file bundles/faucet.json --amount 100`.
9. Publish `genesis.json`, its hash, seed URLs, and add them to `networks/networks.json`. Invite outside validators with `docs/validators.md`.

This was tested locally with four separate processes started from generated bundles: all nodes agreed on genesis, blocks, state roots and finality certificates (`scripts/verify-network.js` passed).

## B. Mainnet (real value): gates, not shortcuts

The software is **unaudited**. Do not put real value on it until every gate in `networks/mainnet/README.md` is met:

- [ ] independent security audits (consensus, EVM, staking), all findings fixed, reports published
- [ ] public testnet for months with 20+ independent validators across providers and countries
- [ ] encrypted/authenticated P2P transport, plus review of the BFT and EVM implementations
- [ ] **YOU:** final name/symbol/trademark/domain clearance; legal review of any distribution
- [ ] **YOU:** allocation table and vesting published at least 30 days before genesis (`networks/mainnet/allocations.example.json`, proposal in `docs/tokenomics.md`)
- [ ] genesis ceremony: each validator signs a gentx (`aurenctl gentx`), then `scripts/genesis-ceremony.js` builds the genesis; everyone verifies the same hash

## What each piece is and where it lives

| Need | Where |
|---|---|
| Chain, consensus (two-phase BFT), staking, governance, fee market | `src/` |
| Smart contracts (EVM, Ethereum RPC) | `src/evm/`, `docs/evm.md` |
| Node / validator | `bin/auren-node.js` |
| Wallet (web, hardware keys), CLI | `website/wallet.html`, `bin/aurenctl.js` |
| Block explorer, website | `website/` |
| Faucet | `bin/auren-faucet.js` |
| Devnet / testnet / mainnet tooling | `scripts/devnet.js`, `scripts/make-bundles.js`, `scripts/genesis-ceremony.js` |
| Health check | `scripts/verify-network.js` |
| Deploy configs | `deploy/` (systemd, Caddy, Prometheus), `Dockerfile` |
| Specs | `docs/` |

## Honest limits

Unaudited; P2P is unencrypted HTTP (messages are signed); precompiles 6-8 and Cancun opcodes are missing; MetaMask is untested; the name/symbol are working names; the economics are proposals to review before genesis.

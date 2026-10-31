# AUREN

**A public network with its own coin, AUR: send it in seconds, earn rewards by staking, use smart-contract apps, and check everything yourself.**

> **Status: pre-launch.** AUR is the coin of the AUREN mainnet. The public testnet and devnet are live now and hand out coins from a faucet. **Mainnet has not launched** and will not until independent security audits and a long public test are done. The software is unaudited.

## Start here

| I want to… | Go to |
|---|---|
| Use AUREN (wallet, send, stake, names) | [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) |
| **Run a node** on Windows, Mac, Linux or Android | [`docs/RUN-A-NODE.md`](docs/RUN-A-NODE.md) |
| Look at the chain | the explorer on the website (`/explorer.html`) |

## Run a node in one command (no npm)

You need **only Node.js 20+**. Unpack the download, then:

```bash
./auren join testnet        # Windows: auren.cmd join testnet
./auren status
```

Windows users can instead right-click `install\windows\Install-AUREN.ps1` → *Run with PowerShell*, then open **AUREN Node** from the Start Menu. Android: install the **AUREN Node** or **AUREN Miner** app from the releases page.

## One mainnet, one testnet, one devnet

You **join** these networks; you do not create them.

| Network | Chain ID | Address prefix | Status |
|---|---|---|---|
| Mainnet | `auren-mainnet-1` | `aur1…` | **not launched** |
| Testnet | `auren-testnet-1` (EVM 77002) | `taur1…` | official genesis in this repo; join with `./auren join testnet` |
| Devnet | `auren-devnet-1` (EVM 77001) | `daur1…` | official genesis in this repo; join with `./auren join devnet` |

Each network's genesis hash is pinned in `networks/networks.json`, and `auren join` refuses a genesis that does not match.

## What it does

- **Consensus:** stake-weighted two-phase BFT with finality in seconds, slashing, and a measured validator-concentration metric ([`docs/consensus.md`](docs/consensus.md)).
- **Fees:** separate compute and state fee markets, base fee burned, predictable costs ([`docs/fee-market.md`](docs/fee-market.md)).
- **Supply:** 3% issuance decaying to a 0.5% floor, set by published rules ([`docs/tokenomics.md`](docs/tokenomics.md)); changes only by on-chain governance with a timelock ([`docs/governance.md`](docs/governance.md)).
- **Smart contracts:** an EVM (Ethereum "Shanghai" rules) with Ethereum-compatible RPC ([`docs/evm.md`](docs/evm.md)).
- **Account safety:** daily limits, guardian recovery, transaction preview, hardware keys and passkeys ([`docs/security.md`](docs/security.md), [`docs/hardware-wallets.md`](docs/hardware-wallets.md)).
- **Names:** `alice.aur`, verified by a built-in light client, with safe handling of look-alike and colliding names ([`docs/name-resolution.md`](docs/name-resolution.md)).
- **Website, wallet, explorer:** served by every node (`--website`).

## Honest limits

Unaudited; the consensus and EVM implementations are new and tested but not independently reviewed; node-to-node traffic is unencrypted (messages are signed); MetaMask is untested; precompiles for zero-knowledge proof verification and Cancun opcodes are missing; there is no standalone Android app. See each doc for details.

## For the core team and contributors

Creating a network (genesis, validator keys, mainnet ceremony) is the core team's job and is **not** needed to use or join AUREN: [`docs/LAUNCH.md`](docs/LAUNCH.md), [`docs/deploy.md`](docs/deploy.md), [`networks/mainnet/README.md`](networks/mainnet/README.md). Contributors can run a throwaway local network and the tests: [`CONTRIBUTING.md`](CONTRIBUTING.md). Specs: [`docs/`](docs/). Security reports: [`SECURITY.md`](SECURITY.md). License: [MIT](LICENSE).

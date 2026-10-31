# Run an AUREN node

A node keeps its own copy of the network and checks every block. You need **only Node.js 20+**. No npm, no git, no build step, no admin rights.

There is **one mainnet, one testnet and one devnet.** You *join* them; you never create them. (The tools the core team uses to create a network are in `docs/LAUNCH.md` and are not needed here.)

| Network | Use it for | Status |
|---|---|---|
| **testnet** | trying everything with faucet coins (recommended) | official genesis in this package; join with `auren join testnet` |
| **devnet** | early features, may be reset | same command with `devnet` |
| **mainnet** | real value | **not launched.** It will only launch after independent audits and a long public test. `auren join mainnet` will say so. |

## 1. Get AUREN

Download the package from the official site's **Run a node** page (`/run-a-node.html`) and unpack it. It is under 200 KB and contains no keys. Every node started with `--website` serves it at `/downloads/`.

## 2. Join

**Windows** (easiest): unzip, right-click `install\windows\Install-AUREN.ps1` → *Run with PowerShell* (installs Node.js if missing, adds **AUREN Node** to the Start Menu, can start it at sign-in), then open **AUREN Node**. Or in a terminal: `auren.cmd join testnet`.

**macOS / Linux:** install Node.js 20+ from nodejs.org, then in the unpacked folder:
```bash
./auren join testnet
```

**Android:** install the **AUREN Node** app (or **AUREN Miner** to earn). It is one standalone app: nothing else needs to be installed. Needs a 64-bit phone.

The first run creates `~/.auren/testnet` (Windows: `C:\Users\<you>\.auren\testnet`) and syncs from the network's seed nodes. Leave the window open.

## 3. Check it

```bash
./auren status --network testnet        # running · auren-testnet-1 · block 1234 · 4 peers · in sync
```
Your node also serves the website, wallet and explorer: open the address printed in the node window (default port 9650).

## Options

| Option | Meaning |
|---|---|
| `--port 9650` | port for your node |
| `--home <dir>` | where data lives (never share one folder between two networks) |
| `--public` | accept connections from other machines (default: only this computer) |
| `--tls-cert f --tls-key f [--tls-port 443]` | also serve **HTTPS** |

## Keep it running

- **Windows:** `Install-AUREN.ps1` can create a sign-in task. Remove it with `schtasks /Delete /TN "AUREN Node (testnet)" /F`.
- **Linux:** `deploy/auren-node.service` (systemd). Use `ExecStart=/usr/bin/node bin/auren.js join testnet`.
- **Android:** the app keeps the node running with a notification. Allow notifications and turn off battery optimization for the app.

## Update

Download the newest package and unpack it over (or beside) the old one. Your data in `~/.auren` is separate and is kept. Never mix data between networks.

## Becoming a validator (advanced)

A regular node checks the network, and with `--earn` it also earns AUR (see [node-rewards.md](node-rewards.md)). Validators also propose and sign blocks and earn rewards, and putting their stake at risk. Read `docs/validators.md` first: you will create a separate consensus key, stake AUR, and must never run two nodes with the same key (that is slashed).

## Back up

Your wallet seed phrase is the only copy of your funds. Node data (`~/.auren/<network>`) can always be re-downloaded from the network; do back up `priv_validator_key.json` if you run a validator.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "cannot reach the seed nodes" | the network's public address is not answering right now; try again in a minute |
| "has not been launched yet" | the network you named has no genesis in this package (mainnet) |
| "genesis … does not match the official one" | this copy was modified or is outdated: download a fresh package |
| `auren status` says not running | start it first, or use `--port` if you changed the port |

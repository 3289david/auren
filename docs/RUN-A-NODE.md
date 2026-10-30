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

**Android:** install **Termux** (F-Droid), copy the package in, then `sh install/android/termux-setup.sh`. This runs a real node inside Termux. There is no standalone Android app yet: an APK needs the Android SDK and a signing key, which this project does not ship.

The first run creates `~/.auren/testnet` (Windows: `C:\Users\<you>\.auren\testnet`) and syncs from the network's seed nodes. Leave the window open.

## 3. Check it

```bash
./auren status --network testnet        # running · auren-testnet-1 · block 1234 · 4 peers · in sync
```
Your node also serves the website, wallet and explorer: open the address printed in the node window (default port 9650).

## Options

| Option | Meaning |
|---|---|
| `--peers http://host:port,…` | nodes to connect to (default: the published seed nodes; if none are published yet, you must give at least one) |
| `--port 9650` | port for your node |
| `--home <dir>` | where data lives (never share one folder between two networks) |
| `--public` | accept connections from other machines (default: only this computer) |
| `--tls-cert f --tls-key f [--tls-port 443]` | also serve **HTTPS** |

## Use the wallet from another computer or phone: HTTPS

Browsers only enable wallet cryptography on **secure pages**: `https://…` (or `localhost`). If other devices open your node's address over plain `http://`, the wallet cannot create or sign anything (the browser disables it). Two ways to fix that:

- **A real domain** (best): put the node behind Caddy (`deploy/Caddyfile`), which gets a trusted certificate automatically. Visitors need nothing.
- **Your own certificate** for a private network: create one, start with `--tls-cert/--tls-key`, and install that certificate as trusted on each device. A self-signed certificate is refused by browsers until you do; AUREN cannot and will not bypass that.
  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=192.168.1.20" -addext "subjectAltName=IP:192.168.1.20"
  ./auren join testnet --public --tls-cert cert.pem --tls-key key.pem --tls-port 9660
  ```

(Verified: the HTTPS listener serves the API, wallet page and RPC. A browser accepting the certificate is on your side.)

## Keep it running

- **Windows:** `Install-AUREN.ps1` can create a sign-in task. Remove it with `schtasks /Delete /TN "AUREN Node (testnet)" /F`.
- **Linux:** `deploy/auren-node.service` (systemd). Use `ExecStart=/usr/bin/node bin/auren.js join testnet`.
- **Android:** Termux keeps running with a wake lock (`termux-wake-lock`); disable battery optimization for Termux.

## Update

Download the newest package and unpack it over (or beside) the old one. Your data in `~/.auren` is separate and is kept. Never mix data between networks.

## Becoming a validator (advanced)

A regular node checks the network, and with `--earn` it also earns AUR (see [node-rewards.md](node-rewards.md)). Validators also propose and sign blocks and earn rewards, and putting their stake at risk. Read `docs/validators.md` first: you will create a separate consensus key, stake AUR, and must never run two nodes with the same key (that is slashed).

## Back up

Your wallet seed phrase is the only copy of your funds. Node data (`~/.auren/<network>`) can always be re-downloaded from the network; do back up `priv_validator_key.json` if you run a validator.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "no public seed nodes are published" | pass `--peers http://host:port` of any node you know |
| "has not been launched yet" | the network you named has no genesis in this package (mainnet) |
| "genesis … does not match the official one" | this copy was modified or is outdated: download a fresh package |
| `auren status` says not running | start it first, or use `--port` if you changed the port |
| wallet buttons do nothing on another device | you are on plain `http://`: use HTTPS (above) |

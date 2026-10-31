# AUREN Miner

The AUREN Miner is a one-button app for **Windows, Mac and Android** that earns AUR for you with the [random draw](rpc-consensus.md). Press **Start mining** and leave it running.

## What "mining" means here

It is not a race. Nothing burns electricity trying to solve puzzles. Your device joins the network, keeps a copy of the chain data and proves it every epoch. Every block, a few of those devices are **drawn at random** and paid. A phone has the same chance as a gaming PC or a supercomputer. See [Random draw](rpc-consensus.md) for how it works and why it is fair.

## Get it

| Device | Download |
|---|---|
| Windows | `AUREN-Miner-<version>.exe` |
| Mac (Apple chip) | `AUREN-Miner-<version>-mac-arm64.tar.gz` |
| Mac (Intel) | `AUREN-Miner-<version>-mac-x64.tar.gz` |
| Android (64-bit) | `AUREN-Miner-<version>.apk` |

All are on the [releases page](https://github.com/3289david/auren/releases/latest) and the website's Download section.

## Use it

1. **Open the app** and pick a network (Testnet or Devnet).
2. Optionally enter an **address for your rewards**. Leave it empty to pay the miner's own address. To get paid in your wallet, paste your wallet address.
3. Press **Start mining**.
4. The app shows an address and the deposit it needs. Send that deposit (plus a little for fees) to the address. It is a refundable deposit, not a fee. The app registers itself and proves storage automatically. On test networks the node also asks the faucet for coins.
5. After the first proof you hold a **ticket** and can be drawn every block. The screen shows your draws won, what you won in draws, and the balance at your reward address.

To stop, press **Stop mining**. Your deposit comes back after the unbonding period if you also unregister (`aurenctl node unregister`).

## Mac notes

Extract the download and double-click **AUREN Miner**. It is a normal Mac app: no Terminal window opens. It carries its own Node.js runtime, so nothing else needs to be installed. macOS may say it cannot verify the developer because the app is not notarized. Right-click the app, choose **Open**, then **Open**.

## Windows notes

Windows SmartScreen may warn because the exe is not code-signed. Choose **More info**, then **Run anyway**. The miner opens in its own app window, with no console or command prompt. Keep the window open (you can minimize it); closing it quits the app.

## Android notes

Allow notifications so the miner can run in the background, and turn off battery optimization for the app. Keep the phone plugged in if you leave it running overnight. The app includes everything it needs; no other app has to be installed.

## Node, Miner and Wallet: which one?

| App | For |
|---|---|
| **Wallet** | Hold, send and receive AUR; stake; names |
| **Node** | Run a full node for the network (no earning screen) |
| **Miner** | Run a node that earns, with a simple earnings screen |

## Questions

**Does it use a lot of power?** No. There is no hashing race. The device syncs blocks and answers one small storage challenge per epoch.

**How much will I earn?** It depends on how many tickets exist: the pool each block is split between a few random winners, so with more miners each earns less often. See [Random draw](rpc-consensus.md) for the expected earnings formula.

**Why a deposit?** Fake identities would otherwise be free and could dominate the draw. A refundable deposit per identity makes that costly while keeping the odds equal for everyone.

**Where is my key?** The miner makes its own key inside its data folder (`~/.auren/miner` on desktop). Rewards go to the reward address you chose, so the key itself holds only the deposit.

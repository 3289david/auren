# FAQ

## The basics

**What is AUREN?** A public network with its own coin, AUR. You can send it, stake it, give your wallet a name, and run apps on it.

**What is AUR?** The coin of AUREN. 1 AUR is split into 1,000,000,000 tiny parts called sparks.

**Is mainnet live?** Not yet. It launches after independent security audits and a long public test. Today the devnet and testnet are live.

**What is the difference between devnet, testnet and mainnet?** Mainnet is the real network. The testnet is the official place to try everything before launch. The devnet is for early features and may be reset. There is exactly one of each, each with one public address (`devnet.auren.im`, `testnet.auren.im`, `mainnet.auren.im`, mirrored on `krl.kr`). You join them rather than create them. See [Networks](networks.md).

**Does a node runner get their own network or address?** No. Running a node joins the one network and helps keep it running; it does not create a new network or a new address. This is how other blockchains work too. See [Networks](networks.md).

## Money

**How much does a payment cost?** A tiny fraction of a cent. At the minimum fee level a transfer costs 0.000026 AUR. Fees rise a little only when the network is busy.

**Where does the fee go?** It is burned: removed from the supply forever. Nobody collects it. That makes AUR slightly scarcer over time.

**How do I get AUR on the testnet or devnet?** Open **Receive** in the wallet and press **Get 1,000 AUR**.

**What is staking and is it safe?** Staking locks your AUR behind a validator to earn rewards. See the [Staking guide](staking-guide.md) for the risks.

**Where do rewards come from?** Newly issued AUR. See [Tokenomics](tokenomics.md).

## Wallet and safety

**I forgot my password.** Add your wallet again using your recovery key (**I already have a wallet**) and choose a new password. Without the recovery key nobody can recover it, including us.

**Where is my wallet stored?** On your device only, locked with your password.

**Can AUREN staff recover my coins?** No. Nobody can.

**Can I use my Ethereum wallet?** Yes. AUREN speaks the Ethereum protocol, so tools like MetaMask can connect with the chain ID from [Integrate](integrate.md).

## Names

**What is `alice.aur`?** An easy name for your address. Register it in the wallet's **Names** tab.

**What is a TLD?** The ending of a name, like `.aur` or `.david`. You can create your own ending and set its price. See [domains](domains.md).

**Can I register `alice.com`?** No. Real-world endings like `.com` and `.eth` are reserved so nobody can imitate them.

## Nodes

**Do I earn anything by running a node?** Yes. Start your node with Earn turned on. It locks a deposit, proves each epoch that it stores the chain and shares a pool of new AUR. See [Node rewards](node-rewards.md).

**What is the random draw?** Every block a few nodes are picked at random and paid. A node needs a bond and a storage proof (a ticket); hardware and coin balance do not change the odds. See [Random draw](rpc-consensus.md).

**Will it use a lot of space or data?** Very little on the test networks. A phone should stay plugged in.

**Can I run a node on my phone?** Yes, with the AUREN Node app for 64-bit Android, or the AUREN Miner app if you want to earn. Nothing else needs to be installed.

**What is the Miner app?** A one-button app for Windows, Mac and Android that runs a node and earns AUR through the random draw. See [Miner](miner.md).

## For developers

**Is there an API?** Yes: REST and JSON-RPC on every node, plus Ethereum-compatible JSON-RPC. See [Integrate](integrate.md) and the [Developer quickstart](developer-quickstart.md).

**Are there SDKs?** JavaScript and Python, with no dependencies. See [Integrate](integrate.md).

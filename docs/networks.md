# Networks: devnet, testnet, mainnet

AUREN has exactly **three networks**, and each has exactly **one public address** (with a mirror). You never create a network and you never get a new address by running a node.

| | Devnet | Testnet | Mainnet |
|---|---|---|---|
| Address | `https://devnet.auren.im` | `https://testnet.auren.im` | `https://mainnet.auren.im` |
| Mirror | `https://devnet.krl.kr` | `https://testnet.krl.kr` | `https://mainnet.krl.kr` |
| Chain ID | `auren-devnet-1` | `auren-testnet-1` | `auren-mainnet-1` |
| Address prefix | `daur` | `taur` | `aur` |
| Ethereum chain ID | 77001 | 77002 | 77000 |
| Faucet | `https://devnet.auren.im/faucet` | `https://testnet.auren.im/faucet` | never |
| Status | live for early features, may be reset | the official place to try everything | not launched yet |

The two addresses of a network are mirrors of the same network. Wallets, the explorer and the apps connect only to these addresses. There is no "custom node" setting.

A transaction signed for one chain ID is invalid on the others, and address prefixes make mistakes visible.

## Do node runners get their own network or address?

No, and this is the same as every other public blockchain:

- A blockchain is **one network**. Everyone who runs a node joins that same network and helps keep it running. Running a node does not create a new network.
- Wallets talk to the network through a few **well-known public addresses** (the ones in the table). Other chains work the same way: Solana's wallets use `api.mainnet-beta.solana.com`, Cosmos chains publish a short official list of endpoints, and Ethereum wallets use a handful of provider addresses. Wallet users never type in the address of someone's home computer.
- A node joins through the network's **peer-to-peer connection**: it starts from the official seeds, finds other nodes, downloads and checks every block, and from then on is part of the network. Your node has no web address of its own that anyone needs to know.
- Operators of big, always-on nodes sometimes offer their own public address as a convenience. That is optional, and in AUREN wallets only use the official addresses above.

So when you press **Start** in the AUREN Node app, you are joining the one testnet or devnet, not creating a new one.

## How the addresses work

Each address points at the network's public nodes. They serve the same API (see [Integrate](integrate.md)), the Ethereum-compatible RPC, and the chain data the explorer reads. If one address is down, the mirror answers. Operators who run these addresses use `deploy/Caddyfile` ([Deploy](deploy.md)).

## Differences between the networks

All three run the same software. They differ in chain ID, address prefix, parameters, and how genesis is made.

| | Devnet | Testnet | Mainnet |
|---|---|---|---|
| Block time | 1 s | 2 s | 2 s |
| Validators at genesis | 4 (public keys) | 4+ | at least 4 independent operators |
| Unbonding | 60 blocks | 1 day | 28 days |
| Voting-power cap | off | off | 10% |
| Faucet | yes | yes | **never** |
| Keys | public | secret | secret |

The genesis hash of each network is pinned in `networks/networks.json`, so wallets can detect a wrong network.

## For people launching the official networks (core team)

Creating the official networks is a one-time job for the core team and is not part of using AUREN:

```bash
npm run gen:devnet                   # reproducible genesis (CI checks it byte for byte)
npm run gen:testnet                  # writes networks/testnet/genesis.json + secret validator homes
```

Output in `networks/testnet/_private/` (gitignored): one home per genesis validator, the faucet seed and operator seeds.

1. Copy each validator home to its own server, set `peers` to the other servers, and start them within a few minutes of `genesisTime`.
2. Put the public addresses in front of them with `deploy/Caddyfile`.
3. Start the faucet behind `/faucet`.
4. Check agreement with `node scripts/verify-network.js <server urls>`.

For mainnet follow the genesis ceremony in [Launch](LAUNCH.md): collect validator gentxs, build genesis, publish its hash, and only then start.

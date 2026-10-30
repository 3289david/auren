# Networks: devnet, testnet, mainnet

**There is exactly one of each.** Users and node operators *join* them (`./auren join <network>`, see `RUN-A-NODE.md`). The "Devnet (local)" and "Testnet" generation sections below are for the core team and contributors who create or test networks; they are not part of using AUREN.

All three run the same software. They differ in chain ID, address prefix, parameters, and how genesis is made.

| | Devnet | Testnet | Mainnet |
|---|---|---|---|
| Chain ID | `auren-devnet-1` | `auren-testnet-1` | `auren-mainnet-1` |
| Address prefix | `daur` | `taur` | `aur` |
| Block time | 1 s | 2 s | 2 s |
| Validators at genesis | 4 (deterministic keys) | 4+ (random keys, you hold them) | ≥ 4 independent operators (gentx ceremony) |
| Unbonding | 60 blocks | 1 day | 28 days |
| Voting-power cap | off | off | 10% |
| Faucet | yes (1000 AUR / 5 s) | yes (you run it) | **never** |
| Keys | **public** | secret | secret |
| Value | none | none | real: *only after the launch checklist* |

A transaction signed for one chain ID is invalid on the others, and address prefixes make mistakes visible. `aurenctl --network X` also refuses to talk to a node reporting a different chain ID.

## Devnet (local)

```bash
npm run devnet               # 4 validators :9650-9653, faucet :9690, website :8080
node scripts/devnet.js --clean --validators 7
docker compose up --build
```

Genesis is committed at `networks/devnet/genesis.json` and is reproducible: `npm run gen:devnet` regenerates it byte-for-byte (CI checks this). Seeds for the public dev accounts (`alice`, `bob`, `carol`, `dave`, `faucet`) are written to `.devnet/accounts.json`.

## Testnet

```bash
npm run gen:testnet                  # writes networks/testnet/genesis.json + secret validator homes
```

Output in `networks/testnet/_private/` (gitignored): one home per genesis validator (`node0…`), the faucet seed and operator seeds in `accounts.json`.

1. Copy each `nodeN/` home to a separate host. Edit its `config.json`: set `peers` to the other hosts' public URLs, and `rpcHost` as needed.
2. Start them: `node bin/auren-node.js start --home <dir>` (all must start within a few minutes of `genesisTime`).
3. Start a faucet: `node bin/auren-faucet.js --rpc http://<node> --key-file <faucet seed json> --amount 100`.
4. Publish `genesis.json`, its hash, seed URLs and RPC URL; fill them into `networks/networks.json`.
5. Invite outside validators with `docs/validators.md`. Aim for ≥ 20 independent operators before anyone argues about decentralization.

Fault-injection checklist for the testnet phase: kill validators below and above ⅓; partition the network; restart with stale state; feed malformed blocks; spam transactions; record base-fee behaviour; publish results.

## Mainnet

Not launched. See `networks/mainnet/README.md` for the checklist and the genesis ceremony (`scripts/genesis-ceremony.js`), which builds genesis from public allocations and validator-signed gentxs so anyone can reproduce the hash.

# Changelog

## 0.10.1

- **No console windows.** The Windows apps are now real windowed programs: no command prompt opens. The Node app has its own window (start, stop, network, status) like the Miner. Closing an app window quits the app. The Mac Miner is a double-clickable `AUREN Miner.app` instead of a Terminal script.

## 0.10.0

- **AUREN Miner** for Windows, Mac and Android: a one-button app that runs a node that earns AUR and shows draws won, balance and ticket status. `docs/miner.md`. Mac builds ship the official Node.js runtime for macOS (`scripts/build-miner-mac.js`).
- **Android apps fixed and simplified.** The Node.js runtime now ships as native libraries inside the APK (the one place every Android version lets apps run programs from), the apps target Android 14, and nothing else needs to be installed. Termux is no longer mentioned or required; the Termux setup script is removed.
- **Fixed the Android sync failure:** the Android Node.js build has no root certificates, so every HTTPS connection to the network failed and the node never synced. The apps now ship a certificate bundle. Verified on an Android 14 emulator syncing the live testnet.
- **Testnet genesis updated to the live network** (`e50d022b…`, served by testnet.krl.kr). The repository previously pinned a different genesis, so nodes could not join the real testnet.
- **Node app** is a plain node; earning moved to the Miner. The node writes a status file for the apps (`miner-status.json`).
- Wallet: new **Earn** tab (stake, run a node, mine). Website: Miner download buttons for Windows, Mac and Android.

## 0.9.0

- **Random draw (RPC):** a new way to earn. Every block a committee of ticket holders (bonded nodes that proved storage) is drawn uniformly from a verifiable random beacon and paid from a pool (`rpc.poolBps`, default 5% of issuance; `rpc.committeeSize`, default 7). Hardware, balance and stake do not change the chance. `GET /draw`, `aur_getDraw`, explorer **Draw** page, `docs/rpc-consensus.md`. Reference implementation and simulations: https://github.com/3289david/rpc-consensus.
- Validators now receive issuance minus the node pool and the draw pool.

## 0.8.0

- **Official addresses only.** Each network has one public address plus a mirror: devnet `devnet.auren.im` / `devnet.krl.kr`, testnet `testnet.auren.im` / `testnet.krl.kr`, mainnet `mainnet.auren.im` / `mainnet.krl.kr`. Wallets, the explorer, the Names page, the CLI, the SDK examples and both apps connect only to these. The "custom node" option, the node address box, `--rpc`, and every localhost address in the interface and docs are gone.
- Android apps no longer start a local web server: the wallet pages are served inside the app. The Windows wallet opens in its own app window.
- Faucets are reached at `/faucet` on the network address. `deploy/Caddyfile` serves all six names.
- Docs: Networks page explains that node runners join the one network and do not get new addresses.

## 0.7.0

- **SDKs and API for integrators:** `sdk/js` (Node) and `sdk/python/auren.py`, both dependency-free, with identical signatures (a test checks it); OpenAPI spec at `website/api/openapi.json`; `docs/integrate.md` and `docs/developer-quickstart.md`.
- **Names page** (`names.html`): search a name, see price and availability, register in the wallet with a deep link (`wallet.html?tab=names&name=alice.aur`), create your own name ending, list all endings.
- **Network switching fixed:** choosing Testnet or Mainnet no longer silently connects to a local devnet; it connects only to a node that answers for that network, otherwise it says none is reachable.
- **Docs:** Start here, Wallet guide, Explorer guide, Staking guide, FAQ, Troubleshooting, Glossary, CLI reference, Developer quickstart. All published on the website.

## 0.6.4

- **New wallet design:** one step per page (welcome, save recovery key, set password, or add an existing wallet, or use a device key), one clean column, a big balance with Send / Receive / Stake / Activity buttons, a Receive page with Copy address and the faucet.

## 0.6.3

- Wallet and explorer: the node address box is hidden (pick Devnet, Testnet or Mainnet; "Custom node…" shows it). Plain-language wording throughout for non-developers: recovery key instead of seed, trusted helpers instead of guardians, "payments" instead of transactions, and no developer commands or file paths in the interface.

## 0.6.2

- Copy: removed the "test network, no monetary value" wording everywhere. AUR is presented as the mainnet coin; the testnet and devnet are described as faucet networks; mainnet is stated as not yet launched.

## 0.6.1

- **Fees 10x lower:** floor `{compute 1, state 50}` sparks per unit (a transfer costs 0.000026 AUR at the floor, 0.000104 at the start). Fix: the base fee now always steps down by at least one unit, so a small fee can reach the floor instead of stalling above it.
- **Docs on the website:** every page in `docs/` is rendered to `website/docs/` (`node scripts/build-docs.js`), linked from the site header.
- Node-rewards docs explain what the 10% pool share means.

## 0.6.0

- **Apps:** single-file Windows apps (`AUREN-Node.exe`, `AUREN-Wallet.exe`) and Android apps (`AUREN Node` with a bundled Node.js runtime, `AUREN Wallet`). Build scripts: `scripts/build-exe.js`, `android/build.js`. See `docs/BUILD-APPS.md`.
- Wallet and explorer: a **Network** picker (Devnet, Testnet, Mainnet, custom node) next to the Connect button.
- New favicon files (`favicon.ico`, apple-touch icon); `/networks.json` is served by the static server; run-a-node page links to release downloads.

- **Node rewards:** full nodes earn AUR. `auren join <network> --earn` bonds the node and proves each epoch that it stores the chain; 10% of issuance goes to a pool split between proven nodes. New txs `registerNode`, `unregisterNode`, `nodeProof`; params `node.bond|epochBlocks|poolBps`; `/nodes`, `aur_getNodes`. See `docs/node-rewards.md`. Changes genesis (devnet/testnet hashes updated).

- **Your own TLDs:** anyone can create a TLD (`registerTld`), set it open or restricted, set the yearly price and their share of each registration, change it later (`setTldPolicy`) and hand it over (`transferTld`). Domains work under any TLD (`alice.david`); real-world TLDs are reserved; fees are split between the TLD owner and the burn. Names resolve with light-client proofs. New param `tld.price`, governable. See `docs/domains.md`.
- CLI: `aurenctl tld list|show|register|policy|transfer`. API: `/tlds`, `/tld/{tld}`, `aur_getTlds`, `aur_getTld`. Wallet: TLD picker and create-a-TLD form. Explorer: **Names** page.
- Website redesigned: minimal, light by default, follows the system dark mode.
- Docs: new index and domains guide.

## 0.5.2: chain scanner

- Explorer is now an Etherscan-style scanner: latest blocks and transactions on the home page, paginated **Blocks** and **Transactions** lists, a **Validators** page (voting power, commission, missed blocks, Nakamoto coefficients), **Top accounts** (rich list), **Governance** proposals, contract pages (EVM address, code size, bytecode), and search by block, tx hash, Ethereum tx hash, `0x` address, address or `name.aur`.
- Node API: `GET /txs?limit&before`, `GET /richlist`, `/account/0x…` (Ethereum-style address lookup), `evm` info on `/account/{addr}`.
- Fix: the home page status chip now shows "connected". EVM values display in AUR.

## 0.5.1: verification pass

- **Fix (security-relevant):** the committed testnet genesis lacked `evmChainId` and would have used mainnet's default (77000), allowing Ethereum-signed transactions to replay between testnet and mainnet. Testnet now sets 77002 (same validator keys; new genesis hash `912816ec…`). `test/networks.test.js` guards that every network has distinct chain id, address prefix and EVM chain id, and that pinned genesis hashes match the files.
- **Fix:** SDK/browser library sized `maxFee` for EVM transactions from the 21,000-gas minimum, so contract deployments were rejected (`Wallet.build`); regression test added.
- **Fix:** `aurenctl` no longer trips a Windows libuv assertion on error exit.
- **CLI:** `aurenctl evm deploy | send | call | code` (gas auto-estimated, `--simulate` supported).
- **Explorer:** EVM execution on transaction pages (gas, return data, logs, contract address), Ethereum-hash search, Governance page.
- Verified live on a fresh devnet: CLI deploy/call/send, an unmodified `ethers` client, every website asset served by a node, explorer pages without console errors. 78 tests.

## 0.5.0: EVM

- `src/evm/`: EVM interpreter (Shanghai), journaled state, Keccak-256, RLP, secp256k1 recovery, precompiles 1-5 and 9, chain glue, Ethereum raw-transaction envelope (signature scheme 4), `eth_*` JSON-RPC.
- New transaction type `evm` (variable cost: gas limit as compute, gasLimit/1000 state units, unused gas refunded), wildcard access set (EVM blocks execute sequentially), receipts carry `evm` data (gas, logs, output, contract address).
- Params: `evmChainId` (devnet 77001, testnet 77002, default 77000). Devnet genesis changed (regenerate with `npm run gen:devnet`).
- Daily limit applies to EVM value; contract accounts use address scheme 3; Ethereum keys scheme 4.
- Tests: 5 EVM unit tests (incl. 260 reference-validated programs), 9 EVM chain tests; `scripts/evm-diff.js` differential fuzzer (needs `@ethereumjs/*`, not a dependency).

## 0.4.0: governance

- `src/gov.js`, `submitProposal` and `vote` transactions; stake-weighted tally (quorum 33.4%, threshold 50%, veto 33.4%), escrowed deposit (refund or burn), timelock, whitelisted ranged parameters, overrides stored in state and applied from the next block.
- `Chain.getProposals`, `aur_getProposals`, `GET /proposals`, `aurenctl gov`, wallet Govern tab.
- Devnet genesis now includes governance parameters (new genesis hash; regenerate with `npm run gen:devnet`).
- Tests: 10 governance tests (59 total).

## 0.3.0: two-phase BFT, hardware keys, universal name resolution

- **Consensus:** `src/bft.js`, a Tendermint-style propose/prevote/precommit engine with locks, valid-block re-proposal, round skipping, growing timeouts and fsync'd vote/lock persistence. Equivocation evidence is now per `(height, round, type)`. Node: push + pull (`/p2p/msg`, `/p2p/round-state`) replace single-phase `/p2p/proposal` and `/p2p/lock`. Breaking: old `priv_validator_state.json` files are ignored; evidence format changed.
- **Hardware keys:** signature scheme 2 (WebAuthn, ECDSA P-256) in `src/crypto.js`/`src/tx.js`, wallet support, guardian recovery to hardware keys (`recoveryApprove.newScheme`).
- **Names (ANR-1):** `setRecord`, `setPrimary`, hardened registration rules, `transferDomain` resets target/records, Merkle proofs for state entries (`State.prove`), `aur_resolve`/`aur_reverse`/`/genesis`/`/resolve`/`/reverse`, `website/anr.js` (light client, universal resolver, DNS + ENS adapters, Keccak-256).
- Wallet: single in-flight action guard, resolver-aware send flow, records and primary-name UI, resolver settings (third-party lookups opt-in).
- Tests: 8 BFT fault-injection tests, 4 WebAuthn, 10 name-system, extended 4-node integration (light-client verification over HTTP).

## 0.2.0: real wallet, real explorer, node-hosted site

- Web wallet (`website/wallet.html`): browser-side Ed25519 keys, PBKDF2 + AES-GCM keystore, send / stake / names / security / activity / backup, node dry-run before every signature.
- `website/aurlib.js`: browser + Node client library; `test/webwallet.test.js` proves byte-for-byte parity with the chain.
- Explorer rewritten: block, transaction, account, validator and name pages; live fee/utilization chart.
- Landing page shows only live node data (fee history, supply, burn, issuance schedule from chain parameters).
- Node: address -> transactions index (`/account/{addr}/txs`, `aur_getAccountTxs`), `--website` static hosting (path-traversal safe), fsync'd validator vote state.
- `scripts/verify-network.js` multi-node health check; `docs/deploy.md`, Caddy config for TLS + CSP.

## 0.1.0: reference implementation

- BFT proof-of-stake consensus with commit certificates, stake-weighted proposer selection, double-sign evidence, downtime jailing.
- Two-dimensional adaptive fee market (compute, state), base-fee burn, proposer tips, conflict-aware lane scheduler.
- Staking: delegation with reward index, unbonding queue, slashing (also applied to in-flight unbonding), voting-power cap.
- Issuance schedule: 3.0% decaying 15%/yr to 0.5%, minted only for signers of the previous block.
- Native account security: daily limits, timelocked loosening, guardian recovery, transaction simulation.
- Optional `.aur` naming module (fees burned).
- Node with block log, sync, mempool, JSON-RPC/REST, Prometheus metrics; `aurenctl` wallet; faucet; explorer + website.
- Devnet (deterministic), testnet generator, mainnet genesis-ceremony tooling.
- Tests: 22 unit tests, 4-node HTTP integration test (fault tolerance, halt without quorum, restart, late-joiner sync).

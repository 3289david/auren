# How AUREN works (architecture)

A guided tour of the pieces, from a button press in the wallet to a confirmed block.

## The pieces

| Piece | What it is | Where |
|---|---|---|
| **Wallet** | Holds keys, builds and signs payments. Runs in a browser, a Windows app or an Android app. | `website/wallet.js`, apps |
| **Node** | A program that keeps a full copy of the chain, checks every block and answers requests. | `src/node.js` |
| **Validators** | Nodes that also propose and sign blocks. They are chosen by stake. | `src/consensus.js`, `src/bft.js` |
| **Chain** | The rules: accounts, fees, staking, names, governance, smart contracts. | `src/chain.js`, `src/tx.js` |
| **Explorer** | A website that reads from a node and shows everything. | `website/explorer.js` |
| **Faucet** | On test networks, a small service that gives coins away. | `bin/auren-faucet.js` |

## A payment, step by step

1. **Build.** The wallet asks a node for your payment number (nonce) and the current fee, and writes a transaction.
2. **Preview.** It sends the transaction to the node's `aur_simulate`, which runs it against the current state without changing anything and returns the exact effect and fee. You see this on the Review screen.
3. **Sign.** The wallet signs with your key, on your device. The key never leaves it.
4. **Submit.** The signed transaction goes to a node (`aur_sendTx`). The node checks the signature, nonce and fee, adds it to its waiting list (the mempool) and tells its peers.
5. **Propose.** Validators take turns. The chosen validator for this height packs waiting transactions into a block, ordered by fee.
6. **Vote.** Validators vote in two rounds (prevote, precommit). With more than two thirds of voting power, the block is final. There is no "wait for six confirmations".
7. **Execute.** Every node runs the block with the same code and gets the same result, byte for byte. The block header commits to the resulting state, so any difference is detected at once.
8. **Confirm.** The wallet polls the node and shows "confirmed".

## Consensus

AUREN uses a two-phase Byzantine fault tolerant proof-of-stake protocol: a block needs signatures from more than two thirds of the voting power. Validators that sign two different blocks at the same height are penalised and removed. Details: [Consensus](consensus.md).

## Fees: the adaptive market

Two resources are priced separately: compute (how much work) and state (how much is stored). Each has a fee level that rises when blocks are more than half full and falls when they are empty, within limits. The fee is burned. Because the two are separate, a storage-heavy action cannot make plain payments expensive. Details: [Fee market](fee-market.md).

## Parallel execution

Transactions that touch different accounts run side by side in lanes. Every transaction declares which parts of the state it touches, so the node can prove which ones are independent. The result is identical to running them one by one. Smart-contract calls and name registrations under user-created endings run alone because they touch shared state.

## Accounts and keys

An account is an address derived from a public key. Software wallets use Ed25519; phone and security-key wallets use ECDSA P-256 (WebAuthn); Ethereum wallets use secp256k1. Accounts can add trusted helpers, a delay for weakening settings and a daily limit, enforced by every validator. Details: [Account security](security.md).

## Money

New AUR is issued every block, starting at 3% a year and falling to 0.5%. Validators and their stakers get most of it; 10% goes to the node-reward pool. Fees and penalties are burned. Details: [Tokenomics](tokenomics.md), [Node rewards](node-rewards.md).

## Names

Names like `alice.aur` live on the chain as records. A node answers a lookup with a Merkle proof, so a light client can check the answer against the validator set without trusting the node. Anyone can create their own name ending (TLD). Details: [Names](domains.md), [Name resolution](name-resolution.md).

## Smart contracts

An Ethereum-compatible virtual machine runs contracts. The Ethereum JSON-RPC is available on every node, so Ethereum tools work with a different chain ID. Details: [EVM](evm.md).

## Governance

People who stake vote on proposals that change a whitelist of network settings. A passed proposal waits for a timelock before it applies. Details: [Governance](governance.md).

## Networks

One mainnet, one testnet and one devnet. Each is identified by its genesis file; the genesis hash is pinned in `networks/networks.json` so wallets can detect a wrong network. Details: [Networks](networks.md).

## Trust model in one paragraph

You trust your own device and the code you run. You do not have to trust any single node: payments are checked by the whole network, name answers come with proofs, and the genesis hash pins the chain. If a node lies, other nodes and your own checks catch it.

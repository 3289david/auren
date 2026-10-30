# ANR-1: AUREN Name Resolution (fixing name-service fragmentation)

## The problem

Independently built name systems do not share a common way to **identify**, **resolve** and **trust** names. The same string (`alice.david`) can exist in several systems with different owners; wallets support some systems and not others; ordinary browsers and DNS know nothing about them; look-alike names enable phishing; a wrong resolver answer sends real money to the wrong place. Ownership (a chain, a contract) is separate from resolution (registries, resolvers) and from use (wallets, apps), and nothing connects the three layers.

A single central resolver does not fix this: you still have to decide **whose answer to trust, who writes the rules, and how a wallet checks the answer**. ANR-1 is a set of rules plus working code for exactly those three questions. It does not claim to unify every name system; it makes the failures visible and safe.

## The six failure modes and what ANR-1 does

| # | Problem | ANR-1 answer | Where |
|---|---|---|---|
| ① | **Namespace collision**: same name, different owners | A name is only fully identified together with its **namespace**: `alice.aur@auren-mainnet-1` (chain ID = namespace). The resolver asks every namespace it knows; **if namespaces disagree it returns `ambiguous` and offers no address.** Machine interfaces must carry the namespace. | `website/anr.js` `UniversalResolver`; `aur_resolve` returns `chainId` + `genesisHash` |
| ② | **Resolver incompatibility** | One interface, pluggable adapters, one result type: `{status, candidates[{source, namespace, address, verified}], sendable, notes}`. Adapters: AUREN (native), ENS, DNS. | `website/anr.js` |
| ③ | **Wallet integration fragmentation** | The wallet calls `resolve(input)` once; adapters live behind it. A new name system = a new adapter, not a new wallet feature. The explorer uses the same library. | `wallet.js`, `explorer.js` use `ANR` |
| ④ | **Gap to the ordinary internet** | **DNS bridge:** a domain publishes `_auren.example.com TXT "v=ANR1 aur:auren-mainnet-1=aur1…"`. Resolved over DNS-over-HTTPS; **DNSSEC-validated answers are marked, unsigned ones are not.** ENS names resolve through the Ethereum JSON-RPC (registry → resolver → `addr`). | `dnsResolve`, `ensResolve` |
| ⑤ | **Trust and security** | (a) **Verified resolution:** AUREN answers come with Merkle proofs and a commit certificate and are checked by a **light client**; a lying node is downgraded to `unverified`. (b) **Registry hygiene:** ASCII only (no homograph alphabets), no `--` (blocks `xn--` spoofing), a name may not look like an address or key. (c) **Reverse names are forward-verified**: `address → name` is shown only if the name still resolves back to that address, so nobody can claim a name they do not hold. (d) **Safe transfers:** selling a name resets its target and records, so the buyer's funds can never be routed to the seller. (e) **Wallet policy:** ambiguous or missing → refuse; unverified → explicit confirmation; the review dialog shows name, namespace, and how it was verified. | chain: `src/tx.js`, `src/chain.js`; client: `anr.js`, `wallet.js` |
| ⑥ | **Ecosystem lock-in** | Everything is open: the proof format, the library, the DNS record format. Ownership and resolution live on the same chain, and the proof lets anyone verify without using the operator's infrastructure. Records are **multi-chain**: one name holds `addr:<namespace>:<ref>` entries (Ethereum, Bitcoin, …) so a name is not tied to one chain's tooling. | `setRecord`, `aur_resolve` |

## Identifiers

```
name        = label "." "aur"                       (label: 3-63 chars, a-z 0-9 "-", no "--", must not look like an address)
qualified   = name "@" namespace                    namespace = chain ID, e.g. auren-mainnet-1
records     = "addr:" <caip2-namespace> ":" <reference>   e.g. addr:eip155:1, addr:bip122:000000000019d6689c085ae165831e93
            | "text:" <key>
            | "content"
DNS bridge  = TXT at _auren.<domain>:  "v=ANR1 aur:<chain id>=<address>"
```

## On-chain objects (all in the state root, so all provable)

- `dom/<name>` → `{owner, target, expiresAt, records?}` (≤ 16 records, values ≤ 256 printable chars).
- `rev/<address>` → `{name}`, only trusted when `dom/<name>.target == address` and the name is live.
- Transactions: `registerDomain`, `setDomainTarget`, `transferDomain` (resets target + records), `setRecord`, `setPrimary` (accepted only if the name already points to you).

## Verified resolution protocol

`aur_resolve(name)` returns the record and a proof bundle:

```
proof.block        { header, hash }            header.stateRoot commits to ALL state
proof.commit       > 2/3 precommits for block.hash
proof.record       {ns:"dom", key, value, steps[]}         Merkle path to header.stateRoot
proof.validators   {ns:"meta", key:"lastValset", value, steps[]}   the set that signed this block, same root
```

The client (`ANR.verifyResolution`) checks, without trusting the node:

1. `sha256(canon(header)) == block.hash`.
2. Both Merkle paths fold to `header.stateRoot`.
3. The response matches the proven record, and the name had not expired at that height.
4. More than ⅔ of the proven validator set signed the block (Ed25519 verification of each precommit).
5. **More than ⅓ of the validator set the client already trusts also signed it.** This is the light-client rule: it stops an attacker from presenting a complete, self-consistent fake history signed by their own validators. (Tested: a fully forged chain is rejected.)

**Trust anchor.** The client's initial trusted set is computed from the **genesis file**, whose hash is checked against a **pinned genesis hash** (`networks/networks.json`, shipped with the app). After each verified proof the trusted set advances to the proven one and is stored, so it follows validator-set changes. If the node's genesis hash is not pinned (a custom network) results are still verified relative to that node's genesis, and the UI says "genesis not pinned".

**Limits (honest):**
- *Trusting period:* if the trusted set is so old that fewer than ⅓ of it still signs (long absence), verification fails closed ("re-sync"), because sequential header sync is not implemented yet.
- *Freshness:* a proof is for the latest block the node had; a malicious node can serve an older (still valid) block. The proof carries the block time and height so the wallet can show it. Expiry/transfer in the last few blocks could be missed.
- *Non-membership:* "name not registered" is not proven; a node can falsely say a name does not exist (it cannot make a different address verify).
- *Pre-registered key reuse:* a name resolves to what its owner wrote; verification proves authenticity of the *record*, not that the owner is who you believe. Check the name carefully.

## Resolver policy (what wallets MUST do)

| status | meaning | wallet behavior |
|---|---|---|
| `verified` | one address, every source proven (light client / DNSSEC) | proceed; show namespace + proof height |
| `unverified` | one address, at least one source is only someone's word (node, Ethereum RPC provider, unsigned DNS) | require explicit user confirmation; show why |
| `ambiguous` | different namespaces give different addresses | **refuse**; ask for a namespace-qualified name |
| `notfound` | nothing resolved | refuse |

Only candidates that are valid for the connected network (`aur:<chainId>`, checksum-valid address) are **sendable**; an Ethereum address found via ENS is information, not a destination for AUR.

**Privacy:** ENS and DNS lookups reveal the name to a third party (an RPC provider, a DoH server), so the wallet keeps them **off until the user opts in**. Native `.aur` lookups go to your own node.

## Testing

- `test/names.test.js`: registry rules; records, limits, sale reset, reverse verification; Merkle proofs for every state entry (odd and even sizes); light-client accept/reject matrix including a fully forged chain; trusted-set advance; **namespace collision → ambiguous**; lying node → unverified; DNSSEC-marked vs unsigned DNS; ENS call encoding; Keccak-256 and ENS namehash against published vectors.
- `test/network.test.js`: a name registered through a live 4-validator network is verified over HTTP by the light client.
- `scripts/check-live-resolvers.js`: runs the ENS and DNS adapters against **real** services (verified result: `vitalik.eth → 0xd8da6bf2…6045` via a public Ethereum RPC; DNS `_auren` lookups with the DNSSEC flag read from real resolvers).
- Manually in a browser against the devnet: register, set records, set primary, pay to `lightclient.aur`, review dialog showing "verified by light client, proven at block N".

## What ANR-1 does not do

It cannot make third-party systems adopt it, force other wallets to implement the policy, or make an ENS answer verifiable without ENS-side proofs (CCIP-Read and offchain names are unsupported; results are marked as the RPC provider's word). It does not stop typo-squatting or brand disputes in the human sense; it makes lookalikes harder to register and wrong answers easier to detect. Governance of names (disputes, reserved names, price changes) belongs to the Phase 2 governance module.

# Names, domains and your own TLD

AUREN has a built-in naming system. You can:

- **Register a domain** under `.aur` (`alice.aur`), or under any TLD someone created (`alice.david`).
- **Create your own TLD** (`.david`, `.mycoin`, `.shop`) and decide who can register under it and what it costs.

Names are optional. The chain works without them. They simply give an address a name people can read.

## How names look

| Form | Meaning |
|---|---|
| `alice` | Same as `alice.aur`. |
| `alice.aur` | A name in the built-in `.aur` namespace. |
| `alice.david` | A name under the user-created `.david` TLD. |

Rules:

- A label is 3 to 63 characters: `a-z`, `0-9` and hyphens, not starting or ending with a hyphen.
- A TLD is 3 to 24 characters: `a-z` and `0-9`, starting with a letter.
- One level only: `a.b.c` is not valid.
- `alice.aur` and `alice.david` are different names with different owners. They never collide.
- Real-world TLDs and country codes (`com`, `org`, `eth`, `btc`, `uk`, `io`, `google`, `localhost`, ...) cannot be created, so nobody can pretend to be a name from another system.

## Register a domain

**Wallet:** open **Wallet → Names**, type `alice` or `alice.david`, check the price shown, and confirm.

**CLI:**

```bash
node bin/aurenctl.js domain register alice --years 2
node bin/aurenctl.js domain register alice.david --years 1
```

What you pay:

- Under `.aur`: the price depends on the name length (shorter costs more). The whole fee is **burned**.
- Under a user-created TLD: the TLD owner's yearly price times the number of years. The owner receives their configured share and the rest is **burned**.
- The TLD owner registers names under their own TLD for free (only the normal network fee applies).

## Create your own TLD

**Wallet:** open **Wallet → Names → Create your own TLD**. Choose:

| Setting | Meaning |
|---|---|
| TLD | The name, for example `david` for `.david`. |
| Open | If on, anyone can register names under it. If off, only you can. |
| Price | Yearly price per name, in AUR. `0` means free. |
| Your share | The percentage of each registration paid to you (up to 90%). The rest is burned. |

**CLI:**

```bash
node bin/aurenctl.js tld register david --price 5 --share 80
node bin/aurenctl.js tld register brand --closed           # only you can register names
node bin/aurenctl.js tld policy david --price 2 --share 70 # change the rules later
node bin/aurenctl.js tld transfer david <address>          # hand the TLD to someone else
node bin/aurenctl.js tld list
node bin/aurenctl.js tld show david
```

Creating a TLD costs the network parameter `tld.price` (burned). It is set per network and can change by governance.

You can change the price, the share and whether it is open at any time. Names that are already registered keep working.

## Manage a name

Every name has an owner, a target address, and optional records.

```bash
node bin/aurenctl.js domain target alice.david <address>    # where the name points
node bin/aurenctl.js domain transfer alice.david <address>  # give the name away
node bin/aurenctl.js domain record alice.david text:url https://example.com
node bin/aurenctl.js domain primary alice.david             # make it your reverse name
```

Transferring a name resets its target and records, so a buyer never inherits the old owner's settings.

## Resolve and verify

Anyone can look up a name without trusting a server. The node returns a Merkle proof, and the light client in `website/anr.js` checks it against the validator set pinned at genesis. A proof for `bob.david` cannot be passed off as `bob.aur`.

```bash
curl http://<node>/domain/alice.david
curl http://<node>/tlds
curl http://<node>/tld/david
```

JSON-RPC: `aur_resolve`, `aur_resolveDomain`, `aur_getTlds`, `aur_getTld`. See [rpc-api.md](rpc-api.md). The explorer lists all TLDs under **Names**.

## Transactions

| Type | Body |
|---|---|
| `registerTld` | `tld`, `open`, `price`, `ownerShareBps` |
| `setTldPolicy` | `tld`, `open`, `price`, `ownerShareBps` (owner only) |
| `transferTld` | `tld`, `newOwner` (owner only) |
| `registerDomain` | `name` (`label` or `label.tld`), `years` |

Registrations under a user-created TLD pay the TLD owner, so they use a block-wide lane (they run one after another). `.aur` registrations still run in parallel.

See also [name-resolution.md](name-resolution.md) for the proof format and the cross-system resolver.

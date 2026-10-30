# Running a validator

Works the same on testnet and (eventually) mainnet; only the network name and the money differ.

## 1. Requirements

- Node.js 20+, a dedicated Linux host (2+ cores, 4 GB RAM, SSD), a stable public IP or port-forward, accurate clock (use `chrony`/NTP).
- Two keys: an **operator key** (funds, kept in a keystore) and a **consensus key** (created by `auren-node init`, signs votes).
- Stake: at least `minSelfStake` (mainnet default 10,000 AUR; testnet via the faucet).

## 2. Initialize

```bash
node bin/auren-node.js init --network testnet --home /var/lib/auren --moniker my-validator
# prints your consensus public key and the genesis hash; compare the hash with the one published by the network
chmod 600 /var/lib/auren/priv_validator_key.json
```

Edit `/var/lib/auren/config.json`: add seed `peers`, and keep `rpcHost` on its default so the node is only reachable from its own server (put TLS + rate limiting in front if you serve public RPC). Leave `operator` as `null` until step 4.

## 3. Start as a full node and let it sync

```bash
node bin/auren-node.js start --home /var/lib/auren
node bin/aurenctl.js status --network testnet    # catchingUp must be false
```

A systemd unit is in `deploy/auren-node.service`.

## 4. Create the validator on-chain

```bash
node bin/aurenctl.js keys new operator
# testnet only: the faucet's default drip (100 AUR) is below the 10,000 AUR minimum self-stake,
# so ask the testnet coordinators for stake, or have them run the faucet with --amount 10000
node bin/aurenctl.js faucet operator --faucet-url <faucet url>
node bin/aurenctl.js validator create --from operator --network testnet \
    --cons-pub $(node bin/auren-node.js show-validator --home /var/lib/auren) \
    --moniker my-validator --commission 5 --amount 10000
```

Now set `"operator": "<your operator address>"` in `config.json` and restart the node. It starts voting once it is in the active set (next block after your stake lands and exceeds `minSelfStake`).

## 5. Operate

| Task | Command |
|---|---|
| Am I active? | `aurenctl status` → `validator.active`; `aurenctl validators` |
| Claim rewards + commission | `aurenctl claim <your operator address> --from operator` |
| Add stake | `aurenctl delegate <operator address> <amount> --from operator` |
| Leave | `aurenctl undelegate <operator address> <amount> --from operator`; funds return after unbonding |
| Unjail after downtime | `aurenctl validator unjail --from operator` (after `jailBlocks`) |

## 6. Rules that cost money if broken

1. **Never run two nodes with the same consensus key.** That is double signing: 5% slashed, tombstoned forever. This includes "failover" setups and restoring a backup while the old node is alive.
2. Always keep `data/priv_validator_state.json` with the node. If you migrate hosts, copy it too and stop the old node first.
3. Downtime: missing > 50% of a window jails you; you also forgo rewards when you are not signing.
4. Keep the operator key off the validator host.

## 7. Monitoring

`GET /metrics` (Prometheus): `auren_block_height`, `auren_catching_up`, `auren_peers`, `auren_mempool_size`, `auren_base_fee_*`, `auren_active_validators`, `auren_nakamoto_*`. Alert on: height not advancing for > 30 s, `catching_up == 1`, peers == 0.

## 8. Decentralization etiquette

The chain measures voting-power concentration but cannot see hosting. Please avoid the largest cloud region among current validators, publish your jurisdiction and operator identity if you can, and do not split one entity into many validators to take more power.

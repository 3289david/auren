# Command-line reference

`aurenctl` is the AUREN wallet and chain tool for the terminal. Run it as `node bin/aurenctl.js …`, or `./auren ctl …` (the launcher), or `AUREN-Node.exe ctl …` from the Windows app.

## Global flags

| Flag | Meaning |
|---|---|
| `--network devnet\|testnet\|mainnet` | which network (default testnet) |
| `--from <key name>` | which wallet signs |
| `--simulate` | preview only, send nothing |
| `--no-wait` | do not wait for the block |
| `--tip <AUR>` | pay an extra tip |

Amounts are in AUR (up to 9 decimals). Passwords are read from the `AUREN_PASSWORD` environment variable or prompted.

## Wallets

```bash
aurenctl keys new me          # create an encrypted wallet named "me"
aurenctl keys import me --seed <64 hex>
aurenctl keys list
aurenctl keys show me         # addresses on every network
aurenctl keys export me       # prints the recovery key. Keep it private
```

## Look things up

```bash
aurenctl status
aurenctl balance me --network testnet     # a key name, address or name.aur
aurenctl account <address>
aurenctl block 100
aurenctl tx <hash>
aurenctl validators
aurenctl fees
aurenctl params
```

## Send and stake

```bash
aurenctl send alice.aur 5 --from me
aurenctl delegate <validator> 100 --from me
aurenctl undelegate <validator> 50 --from me
aurenctl claim <validator> --from me
```

## Names and name endings

```bash
aurenctl domain register alice --years 2 --from me
aurenctl domain register bob.david --from me
aurenctl domain resolve bob.david
aurenctl domain target alice <address> --from me
aurenctl domain transfer alice <address> --from me
aurenctl domain record alice text:url https://example.com --from me
aurenctl domain primary alice --from me

aurenctl tld list
aurenctl tld show david
aurenctl tld register david --price 5 --share 80 --from me
aurenctl tld register brand --closed --from me     # only you can register names
aurenctl tld policy david --price 2 --share 70 --from me
aurenctl tld transfer david <address> --from me
```

See [Names, domains and your own TLD](domains.md).

## Node rewards

```bash
aurenctl node info
aurenctl node register --payout <address> --from me
aurenctl node unregister --from me
```

Normally you just run `auren join <network> --earn`. See [Node rewards](node-rewards.md).

## Account security

```bash
aurenctl security set --guardians a,b --threshold 2 --delay-blocks 43200 --daily-limit 100 --from me
aurenctl security cancel --from me
aurenctl recovery approve <account> <new public key hex> --from me
aurenctl recovery cancel --from me
```

## Smart contracts

```bash
aurenctl evm deploy --data @contract.bin --from me
aurenctl evm send 0xADDRESS --data 0xCALLDATA --value 1 --from me
aurenctl evm call 0xADDRESS --data 0xCALLDATA
aurenctl evm code 0xADDRESS
```

## Governance

```bash
aurenctl gov list
aurenctl gov vote 3 yes --from me
aurenctl gov propose --title "Lower the minimum fee" --description "…" --set minBaseFee.compute=1 --from me
```

## Validators

```bash
aurenctl validator create --cons-pub <hex> --moniker mynode --commission 5 --amount 10000 --from me
aurenctl validator unjail --from me
```

See [Validators](validators.md).

## Faucet (devnet and testnet)

```bash
aurenctl faucet <address>
```

## The `auren` launcher

```bash
auren join testnet                  # run a node
auren join testnet --earn           # run a node and earn AUR
auren join testnet --earn <address> # rewards go to this address
auren status --network testnet
auren ctl <any aurenctl command>
```

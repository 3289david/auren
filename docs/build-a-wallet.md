# Build a wallet app

A checklist and walkthrough for making your own wallet on AUREN, in any language.

## What a wallet must do

1. **Make and store keys safely.**
2. **Show a balance** and activity.
3. **Send** payments with a preview.
4. **Receive** (show an address).
5. Optionally: staking, names, security settings.

## 1. Keys

Generate 32 random bytes (the seed). From it make an Ed25519 key pair. The address is Bech32 of the scheme byte and the first 20 bytes of `sha256(scheme ‖ public key)` with the network prefix (`aur`, `taur`, `daur`). The same seed works on all networks; only the prefix differs. Details and code: [Integrate](integrate.md).

Store the seed encrypted with a user password (a slow password hash such as PBKDF2 or Argon2, then AES-GCM). Offer a printed recovery key. Never send it anywhere or write it to logs.

Device keys (passkeys, security keys) use scheme 2. The private key never leaves the device and signing goes through WebAuthn.

## 2. Connect

Let the user pick Devnet, Testnet or Mainnet. Ask a node for `aur_status`. Check `status.network` matches what the user picked, and refuse to continue if not. Pin the genesis hash from `networks/networks.json`.

## 3. Balance and activity

```bash
curl http://NODE:9650/account/ADDRESS          # balance, spendable, nonce, stake
curl "http://NODE:9650/account/ADDRESS/txs?limit=30"
```

Show **spendable** as the headline number. Show amounts in AUR, never sparks.

## 4. Send with a preview

```js
const tx = await wallet.build(node, 'transfer', { to, amount });    // fills in nonce and fee
const sim = await node.simulate(tx);                                // ok? fee? effects?
// show the user: recipient, amount, fee, "should go through"
const { hash } = await node.sendTx(tx);
const t = await node.wait(hash);                                    // confirmed
```

Always preview with `aur_simulate` and show the fee and result. If `sim.ok` is false, show the reason and do not send.

## 5. Names

Before paying a name, resolve it with `aur_resolve` and verify the proof (`website/anr.js`). If the same name gives different addresses on different networks, refuse and ask for the address. Show the verified name next to the address the user is paying.

## 6. Receive

Show the address with a copy button. Optionally a QR code. On test networks add a faucet button (`POST /drip` on the faucet).

## 7. Recommended extras

- **Lock after inactivity** (the AUREN wallet uses 10 minutes).
- **Daily limit and trusted helpers** from the Security screen: `setSecurity` ([Wallet guide](wallet-guide.md)).
- **Plain language.** Say "recovery key", "payment" and "fee", not nonce or seed.
- **Error messages** from [Error codes](errors.md), translated for your users.

## Reference implementations

| Language | Code |
|---|---|
| Browser JavaScript | `website/aurlib.js`, `website/wallet.js` |
| Node.js | `sdk/js/index.js` |
| Python | `sdk/python/auren.py` |

Both SDKs produce byte-identical signatures; the test suite checks it.

## Test it

Run a local devnet (`node scripts/devnet.js --clean`), take coins from its faucet, and exercise every flow before touching a real network. See the [Developer quickstart](developer-quickstart.md).

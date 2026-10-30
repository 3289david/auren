# Getting started with AUREN

AUREN is a public network with its own coin, **AUR**. This page is for people who want to *use* it. Running a node is in `RUN-A-NODE.md`.

## The three networks (there is only one of each)

| Network | What it is | Coins |
|---|---|---|
| **Mainnet** | the real network | **not launched yet** |
| **Testnet** | the official place to try everything | free, no value |
| **Devnet** | early features, may be reset | free, no value |

You never start your own network to use AUREN. You open the wallet and pick one of these.

## Use the wallet (nothing to install)

1. Open the AUREN website and choose **Open wallet**.
2. **Create a new wallet.** Write down the recovery phrase it shows and keep it offline: it is the only way to get your funds back. Choose a password (it protects the wallet on this device). Or choose **Hardware key / passkey** to use a security key, Touch ID, Windows Hello or a phone passkey. (Needs a secure `https://` page.)
3. On the testnet press **Get test AUR**. Free coins arrive in a few seconds.
4. **Send:** enter an address or a name like `alice.aur`, an amount, and press **Review**. The wallet asks the network to preview the payment and shows the exact fee and your balance change *before* you sign.
5. **Stake:** the *Stake* tab lets you back a validator and earn rewards. Unstaking takes a waiting period.
6. **Protect yourself:** the *Security* tab sets a daily spending limit and trusted friends (guardians) who can help you recover your account.

Every payment, account and validator is public in the **Explorer**.

## Names

`alice.aur` is an easy name for your address. Register one in the wallet's *Names* tab. The wallet checks names cryptographically and refuses to pay if a name is ambiguous, so you cannot be tricked into paying the wrong person.

## Staying safe

- AUREN is new software that is still being tested and has not been independently reviewed. Use test coins only.
- Never share your recovery phrase. Nobody from AUREN will ever ask for it.
- Check the address and amount on the *Review* screen every time.

## Command line (optional)

`./auren ctl keys new me` · `./auren ctl balance me --network testnet` · `./auren ctl send alice.aur 5 --from me --network testnet`. Full list: `./auren ctl help`.

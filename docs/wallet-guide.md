# Wallet guide

A tour of every screen in the AUREN wallet (website, Windows app and Android app).

## Connecting

At the top you pick a network: **Devnet**, **Testnet**, **Mainnet**, or **Custom node…** (for people who run their own node; it reveals an address box). The tag next to the title shows which network you are on. If a network is not reachable, the wallet says so instead of switching silently.

## Making or adding a wallet

The first screen offers three choices, one step per page:

- **Create a new wallet.** Step 1 shows your recovery key. Step 2 asks you to choose a name and a password.
- **I already have a wallet.** Paste your recovery key and choose a new password for this device.
- **Use my phone or security key.** The key lives inside your device (fingerprint, face, Windows Hello or a hardware key). Every payment needs your touch. If you lose the device you lose the wallet, so add trusted helpers in **Security** first.

Your wallet is locked with your password and stays on this device. Nothing secret is ever sent anywhere.

## The main screen

The big number is your **spendable balance**. Under it you see what is staked, rewards waiting for you, coins coming back from unstaking, and anything locked. Four buttons cover everyday use; more tabs sit below them.

### Send
Enter an address or a name (`alice.aur`, `alice.david`) and an amount. Names are checked on your device. If a name could belong to different people on different networks the wallet refuses to pay until you are sure. **Review** shows the fee and what will change, and asks the network to preview the payment. You confirm to sign and send.

The optional **Extra tip** pays a little more to go first when the network is busy. Leave it as is normally.

### Receive
Your address, with **Copy address**. On the devnet and testnet there is also **Get 1,000 AUR**.

### Stake
Back a validator to earn rewards. Choose one, enter an amount, confirm. **Your stake** lists what you staked and your rewards (press to claim). Unstaking returns your coins after a waiting period, shown under **Coming back to you**. See the [Staking guide](staking-guide.md).

### Activity
Your recent payments, with their result and fee. Each links to the explorer.

### Names
Search and register names like `alice.aur`, point a name at an address, set your **primary name** (shown when people look up your address), and manage a name you own. You can also **create your own name ending** such as `.david` and set its price. See [Names, domains and your own TLD](domains.md).

### Vote
Anyone who stakes can vote on proposals that change network settings. Votes count in proportion to stake.

### Security
- **Trusted helpers:** addresses of people or other wallets that can help you recover your account if you lose your key. You choose how many must agree.
- **Waiting time:** a delay before weaker settings apply, so a thief cannot loosen your protection at once. Any helper can cancel it.
- **Daily limit:** the most that can leave your account per day. This limits the damage if someone gets your key.
- **Help someone recover:** if you are a trusted helper for someone, approve moving their account to their new key.

### Backup
Show your recovery key again (needs your password), or remove this wallet from this device. Removing it without a saved recovery key loses access to your coins for good.

## Safety checklist

1. Keep your recovery key offline and private.
2. Check the address and amount every time.
3. Set a daily limit and trusted helpers.
4. The wallet locks itself after 10 minutes of inactivity.

Problems? See [Troubleshooting](troubleshooting.md).

# Troubleshooting

## The wallet cannot connect

- Check your internet connection.
- Pick a network in the selector and press **Connect**.
- If the message says there is no public node for that network yet, that network is not reachable right now. Mainnet has not launched. You can run your own node ([Run a node](RUN-A-NODE.md)) or choose **Custom node…** and enter the address of one.

## "That password did not work"

Passwords are case-sensitive. If you really forgot it, choose **Add another wallet → I already have a wallet** and enter your recovery key with a new password.

## My payment is stuck on "waiting"

Blocks arrive every second or two. If the network is busy, add a small **Extra tip**. If the node you use is behind, wait a moment or choose another node.

## "would fail" on the review screen

The network previewed your payment and it would not work. Common reasons: not enough balance (remember the fee), a name that does not exist, or a daily limit you set. The review screen shows the reason. You are not charged for a payment you do not send.

## A name is refused as "ambiguous"

Two networks give that name to different addresses. The wallet refuses to pay so you cannot pay the wrong person. Use the address instead.

## The faucet says "refused"

You may have asked too often. Wait a little and try again, or use a different address. The faucet exists only on the devnet and testnet.

## The device-key option is greyed out

Your browser cannot use device keys here. Device keys need a secure page (HTTPS or the local app) and a supported browser. The Windows and Android wallet apps run on a secure local address, so they work.

## Windows says it protects my PC

The apps are not code-signed. Choose **More info**, then **Run anyway**. You can compare the file to the one on the [releases page](https://github.com/3289david/auren/releases/latest).

## The Android app will not install

Allow installs from this source when Android asks. The node app needs a 64-bit phone and a few hundred MB of space.

## The node will not start

- Check you chose the right network.
- If you see a message about genesis, you may have old data from another chain. Use a new data folder (`--home`).
- A devnet on your computer is reachable from a phone only at your computer's network address, not `127.0.0.1`.

## Still stuck

Open an issue at https://github.com/3289david/auren/issues with what you did and what you saw. Never include your recovery key.

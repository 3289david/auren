# Hardware keys and passkeys

## What is supported

**Signature scheme 2: WebAuthn / ECDSA P-256.** The web wallet can create a key *inside* a security key (YubiKey and similar FIDO2 keys), a platform authenticator (Touch ID, Windows Hello, Android biometrics) or a phone passkey. The private key never leaves the device and every transaction requires the user's touch or biometric.

How it works on-chain (`src/crypto.js verifyWebAuthn`, `src/tx.js`):

- Address = `bech32(scheme byte 2 ‖ sha256(2 ‖ publicKey)[0:20])`; the public key is the uncompressed P-256 point (65 bytes). A transaction carries `scheme: 2`, that `pub`, and `sig = {authData, clientData, signature}`.
- The wallet asks the device to sign the challenge `sha256(signingBytes(tx))`. The chain checks: `clientData.type == "webauthn.get"`; `clientData.challenge == base64url(sha256(signingBytes(tx)))` (so a signature is bound to the exact transaction, chain ID and nonce, and cannot be transplanted); the **user-present** flag is set; and the ECDSA signature over `authData ‖ sha256(clientData)` verifies under the account's key.
- Recovery can move any account onto a hardware key: guardians approve `recoveryApprove {account, newPub, newScheme: 2}`.

## Things to know

- **Not exportable, so use guardians.** A hardware key cannot be backed up. Losing the device loses the key; set guardians (Security tab) so the account can be recovered to a new key.
- **Bound to the site name.** WebAuthn credentials are scoped to the host name (relying-party ID) of the page that created them (for example `app.auren.im`). They cannot be used from another host name, which is also what stops a phishing site from asking your key to sign.
- **Secure pages only.** Browsers expose WebAuthn only on secure (HTTPS) pages. The AUREN apps and website are secure.
- **Signature size:** about 200-300 bytes more than Ed25519 per transaction (authenticator data + client data). Fine at current block limits; this is a measured trade-off, not free.
- **Approval prompt shows less than the review screen.** The device usually shows only "sign in to <site>". The wallet's review dialog (with the node's dry-run) is the place where you check amounts and recipients, then the touch confirms.

## Ledger and Trezor

**Not supported yet, and this is a hard external dependency, not a missing feature flag.** A Ledger signs only through an app installed on the device, and no AUREN app exists. Building one means writing and submitting device firmware (C, Ledger SDK) and passing Ledger's review; it cannot be verified without a physical device. WebAuthn gives the same property (key never leaves hardware, user confirmation per transaction) with devices people already own. A Ledger app is on the roadmap for after the transaction format is frozen.

## Testing, and what is not covered

`test/webauthn.test.js` verifies the chain-side logic with real P-256 cryptography and the exact byte formats a browser returns, via a software authenticator: acceptance and execution, rejection when the amount, nonce or chain ID changes, rejection of a signature transplanted from another transaction, rejection without user presence, parity of address derivation between the browser library and the node, and guardian recovery onto a hardware key (old key stops working).

**Not covered by automated tests:** a physical security key or biometric prompt (a test runner cannot touch a YubiKey), and browser-specific differences. Manual checklist before relying on it:

1. Open the wallet (website or app) in current Chrome, Edge, Safari or Firefox.
2. "Hardware key / passkey" → create; the device prompts; the wallet shows an address.
3. Fund it from the faucet; send a transaction; the device prompts; the transaction confirms.
4. Set a guardian, and complete a recovery to another key.
5. Repeat with a second authenticator type (platform vs. USB key).

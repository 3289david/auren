# AUREN SDKs

- `js/`: JavaScript (Node 20+), no dependencies. `const { Client, Wallet } = require('./sdk/js')`.
- `python/auren.py`: Python 3, no dependencies.
- Browser: `website/aurlib.js` (global `Aur`).
- API reference: `website/api/openapi.json`. Guide: `docs/integrate.md`.

Both SDKs run the same flow: build a transaction, simulate it, sign it locally, send it, wait for the block.

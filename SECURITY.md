# Security policy

AUREN is **unaudited, pre-testnet software**. Do not use it to hold value.

## Reporting a vulnerability

Please report privately; do not open a public issue for anything that could affect a running network.
Set a monitored security contact (e.g. `security@<your-domain>`) before any public testnet and replace this line.
Include: affected component, a reproduction (a failing test is ideal), and the impact you believe it has.

Targets we care most about: consensus safety (two finalized blocks at one height), state-root divergence between honest nodes,
inflation/minting bugs (the token-conservation invariant is tested in `test/core.test.js`), signature or replay bypass,
mempool/RPC denial of service, and keystore weaknesses.

## Scope and rules of engagement

- Test against your own local devnet (`npm run devnet`). Never test against third-party nodes without permission.
- Give us reasonable time to fix before disclosure. A bug bounty is planned for the public testnet phase.

## What the project commits to

- Security-relevant protocol changes are published as proposals with a timelock before activation.
- Audit reports and their resolutions will be published in full before any mainnet launch.

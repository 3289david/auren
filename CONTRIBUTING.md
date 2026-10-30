# Contributing

Thanks for helping. A few rules keep a consensus-critical codebase healthy.

## Ground rules

1. **Determinism is sacred.** Anything reachable from `executeBlock` must produce identical results on every node:
   no `Date.now()`, `Math.random()`, floating-point math, or iteration over unsorted maps. Use `BigInt` for amounts.
2. **Every state key a transaction touches must be in its access set** (`src/tx.js`). The lane scheduler relies on it.
   `test/core.test.js` runs a randomized lane-order test; extend it when you add a transaction type.
3. **Conservation must hold.** `assertConserved()` in the tests checks `supply == balances + bonded + unbonding + accrued rewards`.
   New minting or burning paths need a test that keeps it green.
4. **Consensus changes need a spec change** in `docs/` in the same pull request, plus a note in `CHANGELOG.md`.
5. **Zero runtime dependencies.** Prefer `node:` built-ins. Discuss before adding one.

## Workflow

```bash
npm test            # unit tests + 4-node integration test (~10 s)
npm run bench       # check you did not regress execution speed
npm run devnet      # manual testing on your own machine (contributors only)
```

Keep pull requests small and focused; include tests that fail without your change.
Code style: CommonJS, `'use strict'`, 2-space indent, comments explain *why*.

## Adding a transaction type

1. Add an entry to `TYPES` in `src/tx.js` with `cost`, `check`, `access`, `run`.
2. Cost units: `compute` ~ work, `state` ~ bytes written. Pick numbers by comparison with existing types.
3. Add tests: success, failure (fee still charged), conservation, and lane-order independence.
4. Document it in `docs/protocol.md` and `aurenctl`.

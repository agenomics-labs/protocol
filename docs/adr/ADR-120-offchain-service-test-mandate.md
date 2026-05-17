# ADR-120: Off-chain service unit-test mandate

## Status
Accepted (2026-05-13) — both mandated suites are live on `main`: `src/indexer/package.json` `test` script runs 9 files via `tsx --test` (NODE_ENV=test gates the OFF-213 production guard), and `src/x402-relay/package.json` `test` script runs `tsx --test test/*.test.ts`. Cycle-3 regression coverage (OFF-200..217 in the indexer suite and OFF-201/203/205/206/211/216 in the x402-relay suite) landed on top of the mandated harness and is now the load-bearing reason this ADR closes.

## Date
2026-04-24

## Context

Runtime validation of the 2026-04-24 architecture re-audit
(`docs/ARCHITECTURE_REAUDIT_2026-05b-runtime-validation.md`) surfaced
R2-offchain-01 and R2-offchain-02: two production services ship with
no unit test suite at all.

- `src/indexer/package.json:scripts` has only `start`, `dev`, `build`,
  `clean` — no `test`.
- `src/x402-relay/package.json:scripts` — identical gap.

Both services carry non-trivial correctness-critical logic:

- **Indexer** — WAL/tombstone gate (ADR-082 closure), name-based enum
  decoder (ADR-082), backfill ↔ live-stream ordering (subject of
  R-offchain-02 High, ADR-118). None has a unit test harness.
- **x402-relay** — trust-proxy parsing (ADR-056 closure), rate-limit
  eviction (ADR-056), JWT algorithm pinning (ADR-056),
  error-redaction envelope (proposed ADR-117). None has a unit test
  harness.

Every other workspace in the repo has a `test` script running a
`node --test` / `tsx` suite with substantive coverage (mcp-server 172
tests, capability-manifest-validator 19, sas-resolver 68, sdk/client
9, sdk/idl 6, sdk/action-runtime 14).

The absence of a test surface on indexer and x402-relay is not
accidental — both predate ADR-088 (typed Anchor decode) and ADR-091
(NodeNext ESM), and were skipped during the test-harness rollout. The
cost of that skip is now visible: audit findings targeting these
services cannot be regression-tested, and proposed ADRs 117 and 118
have nowhere to write their fix-forward tests.

## Decision

Every workspace under `src/*` and `packages/*` MUST ship a `test`
script and a minimum smoke suite. Implement in three passes:

### Pass 1 (this ADR, one PR)

Add a `test` script to both gap services using the same shape as
mcp-server's:

```json
"test": "node --import tsx --test test/*.test.ts"
```

Ship minimal smoke suites (one file each) that only assert module
import + public surface:

- `src/indexer/test/smoke.test.ts` — imports `./index.ts`, asserts
  `startIndexer` export exists.
- `src/x402-relay/test/smoke.test.ts` — imports `./index.ts`, asserts
  `createRelayApp` export exists.

Add `tsx` as a devDependency on both. Commit.

### Pass 2 (companion to ADR-118)

Add a concurrency test harness to `src/indexer/test/`:
`backfill-live-race.test.ts`, `tombstone-gate.test.ts`,
`enum-decoder.test.ts`. These become the regression surface for
ADR-118's write-mutex + PRAGMA fullsync fix.

### Pass 3 (companion to ADR-117)

Add unit tests to `src/x402-relay/test/`:
`trust-proxy.test.ts`, `rate-limit-eviction.test.ts`,
`jwt-algorithm.test.ts`, `error-redaction.test.ts`. The last file is
the regression surface for ADR-117's error-envelope refactor.

### CI wiring

Add the two new test jobs to `.github/workflows/ci.yml`:

```yaml
indexer-tests:
  name: Indexer unit tests
  runs-on: ubuntu-latest
  needs: anchor-build
  steps:
    ...
    - run: npm test --workspace @agenomics/indexer

x402-relay-tests:
  name: x402-relay unit tests
  runs-on: ubuntu-latest
  steps:
    ...
    - run: npm test --workspace @agenomics/x402-relay
```

Both blocking (no `continue-on-error: true`).

## Consequences

- **Closes R2-offchain-01 and R2-offchain-02** as raised gaps.
- **Unblocks ADR-117 and ADR-118** from landing without a regression
  harness.
- Matches the test-coverage posture of every other workspace in the
  repo (no special-casing).
- CI gate count grows by 2. Steady-state CI time impact is small
  (each suite is 10-30 quick unit tests, sub-second per file).
- No production behavior change from Pass 1 alone. Pass 2 + Pass 3
  prevent regression of future fixes.

## References

- `docs/ARCHITECTURE_REAUDIT_2026-05b-runtime-validation.md` — raising
  finding.
- `docs/adr/ADR-082-indexer-event-coverage-ci-gate.md` — related
  indexer test infrastructure.
- `docs/adr/ADR-117-x402-relay-error-redaction.md` — needs the x402
  test harness to regress against.
- `docs/adr/ADR-118-indexer-concurrency-hardening.md` — needs the
  indexer test harness to regress against.
- `src/indexer/package.json:scripts`, `src/x402-relay/package.json:scripts`.

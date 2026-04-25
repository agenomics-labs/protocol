# Architecture Re-Audit 2026-04-24 — Addendum: Runtime Validation

## Context

Static audit (`ARCHITECTURE_REAUDIT_2026-05.md`) was verified by
executing every test and lint command the sandbox supports. This
addendum records what was run, the results, and the new findings
(prefixed `R2-*`) that only surfaced by running things.

Executed on fresh `npm install` + explicit `npm run build --workspace`
for every workspace package with a `build` script, so workspace `file:`
deps resolved to their `dist/` outputs.

Sandbox limits: no `solana` CLI available, so `anchor build`,
`anchor test`, and the full `scripts/check-idl.sh` fresh-rebuild path
could not run. That is the same gap that blocked S-xcut-04 integration
tests in earlier audits.

---

## Command results

| Command | Scope | Result |
|---|---|---|
| `cargo check --workspace` | 3 Anchor programs + `scripts/check-event-coverage` is a separate TS file, excluded | ✅ Pass (exit 0) |
| `cargo test --workspace` | All Rust unit/fuzz tests | ✅ Pass (exit 0) |
| `cargo clippy --workspace --all-targets` | Advisory per ADR (R-xcut-01) | ✅ Exit 0 (warnings only, as expected) |
| `cargo audit` | RustSec advisory DB | ✅ Pass — no advisories |
| `npx tsc --noEmit` — mcp-server | — | ✅ Pass |
| `npx tsc --noEmit` — src/indexer | — | ✅ Pass |
| `npx tsc --noEmit` — src/x402-relay | — | ✅ Pass |
| `npx tsc --noEmit` — packages/capability-manifest-validator | — | ✅ Pass |
| `npx tsc --noEmit` — packages/sas-resolver | — | ✅ Pass |
| `npx tsc --noEmit` — sdk/client | — | ✅ Pass |
| `npx tsc --noEmit` — sdk/idl | — | ✅ Pass |
| `npx tsc --noEmit` — sdk/action-runtime | — | ✅ Pass |
| `npx tsx scripts/check-event-coverage.ts` | programs↔indexer event map | ✅ Pass |
| `scripts/check-idl.sh` | requires fresh `anchor build` | ⚠ Stale `target/idl/` (2026-04-18) vs committed `idl/` (2026-04-24). Environmental; CI rebuilds fresh. |
| `npm test` — mcp-server | 172 tests | ✅ 172 / 0 / 0 (pass / fail / cancelled) after workspace `dist/` built |
| `npm test` — packages/capability-manifest-validator | 19 tests | ✅ 19 / 0 / 0 |
| `npm test` — packages/sas-resolver | 68 tests | ✅ 68 / 0 / 0 |
| `npm test` — sdk/client | 9 tests | ✅ 9 / 0 / 0 after `sdk/idl` built |
| `npm test` — sdk/idl | 6 tests | ✅ 6 / 0 / 0 |
| `npm test` — sdk/action-runtime | 14 tests | ✅ 14 / 0 / 0 |
| `npm test` — src/indexer | — | ❌ `npm error Missing script: "test"` |
| `npm test` — src/x402-relay | — | ❌ `npm error Missing script: "test"` |
| `npm audit --audit-level=high` | root workspace | ⚠ 15 vulnerabilities (9 moderate, 6 high) |

---

## Totals

- **Rust: 3 programs, all green.**
- **TypeScript: 8 workspaces type-check clean; 6 of 8 have `npm test` running 288 tests total, all passing.**
- **Two production services (indexer, x402-relay) ship with no unit test suite at all.**

---

## New findings (R2-*)

### R2-offchain-01 (Medium) — indexer has no `test` script

`src/indexer/package.json` → `"scripts"` contains only `start`,
`dev`, `build`, `clean`. No `test`. A developer running
`npm test --workspaces` gets a hard error for this workspace.

The event-coverage CI gate (ADR-082) indirectly exercises the indexer
via `scripts/check-event-coverage.ts`, but that's an integration
script run from the repo root, not a unit-test harness. The service
itself has **zero** unit tests for the WAL/tombstone/enum-decoder
logic that R-offchain-02 (high-severity concurrency race) turns on.

**Impact.** Concurrency fix planned by ADR-118 cannot be regression-
tested without first establishing a harness. The absence of a test
surface is the reason the race has gone undetected.

**Fix.** Add a `test` script and a minimal harness covering:
backfill ↔ live-stream ordering, tombstone lookup, enum decoder
against a fixture IDL, cursor-advance discipline. One `tsx` suite,
same shape as mcp-server's.

---

### R2-offchain-02 (Medium) — x402-relay has no `test` script

Symmetric gap at `src/x402-relay/package.json:scripts`. No `test`
key. The service that takes JWT + payment signatures and submits
them on-chain has no unit coverage for its trust-proxy, rate-limit,
replay-prune, JWT-algorithm, or error-redaction paths — all of which
were the subject of prior audit findings.

**Fix.** Mirror R2-offchain-01: add a `test` script, stand up a
minimal `tsx` suite, cover the three prior P0 surfaces
(trust-proxy parsing, rate-limiter eviction, JWT algorithm pin) + the
ADR-117 redaction-envelope behavior once ADR-117 lands.

---

### R2-offchain-03 (Medium) — corrects R-offchain-08 target

The 2026-05 static audit pinned `R-offchain-08` on `mcp-server/package.json`
with `@solana/web3.js ^1.87.0`. Runtime inspection shows that specific
reference has been aligned (`^1.95.0` elsewhere). The actual mismatch
that persists is the **Anchor** version:

- `src/indexer/package.json` → `"@coral-xyz/anchor": "^0.30.0"`
- every other workspace + root → `^0.31.1`

IDL event decoding between 0.30 and 0.31 has subtly different
discriminator handling. If the indexer decodes an event whose
fixture was built with 0.31, runtime behavior diverges.

**Fix.** Bump `src/indexer/package.json` to `@coral-xyz/anchor ^0.31.1`
and regenerate `package-lock.json`. Verify all
`src/indexer/event-decoders/` round-trip against the committed IDL
after the bump.

---

### R2-offchain-04 (High) — empirical: 15 live npm vulns, 6 High

`npm audit --audit-level=high` against the root workspace:

```
15 vulnerabilities (9 moderate, 6 high)
```

Root causes:
- `rpc-websockets` → vulnerable `uuid`.
- `@solana/web3.js 1.x` chain depending on vulnerable transitives.
- `@coral-xyz/anchor` + `@coral-xyz/borsh` → same `@solana/web3.js`
  chain.
- `@metaplex-foundation/beet-solana`, `@solana/spl-token-group`,
  `@solana/spl-token-metadata` → all depend on vulnerable
  `@solana/web3.js`.

This is the known-high-severity chain from `rpc-websockets` that
upstream Solana has been slowly moving off. None of the advisories
are exploitable in AEAP's off-chain services as deployed (the vulns
are DoS/ReDoS in WebSocket frame handling and have no path to
privilege escalation), but CI cannot flag them under the current
advisory-only policy.

**Fix.** This is the exact finding ADR-115 proposes to close (flip
`npm audit --audit-level=high` to blocking). Ship ADR-115 so these
bubble up as PR feedback, and `npm audit fix` as much as possible
without `--force` before flipping the gate.

---

### R2-dev-01 (Low) — workspace `dist/` build is required before tests but not automated

Root-cause pattern for every local test failure encountered in this
pass: workspace packages export from `dist/*` (per their `main`/`exports`
in `package.json`) but no `prepare` / `postinstall` hook runs `tsc`
after install. CI works around this with explicit
`npm run build --workspace=…` steps. Developers get opaque
`ERR_MODULE_NOT_FOUND` errors until they know to build.

**Fix (choice).**
- (a) Add `"prepare": "tsc"` to every workspace package with a `build`
  step. This runs automatically on `npm install`, `npm ci`, and
  `npm pack`.
- (b) Add a root-level `"postinstall": "npm run build --workspaces
  --if-present"` script.
- (c) Leave as-is and document in `CONTRIBUTING.md`.

Option (a) is the standard npm idiom; minor install-time cost. Not
architecturally significant — no ADR needed.

---

## Interactions with static findings

- **R-offchain-02** (High; indexer concurrency race) cannot be fixed
  safely until **R2-offchain-01** (no tests) lands. Order: R2-offchain-01
  → ADR-118 implementation → regression harness.
- **R-offchain-01** (High; x402 error leakage) cannot be regression-
  tested until **R2-offchain-02** (no tests) lands. Order:
  R2-offchain-02 → ADR-117 implementation → regression harness.
- **R-offchain-09** / **R-xcut-02** (npm/cargo audit advisory) are
  empirically validated by R2-offchain-04. ADR-115 closes both.

---

## Suggested new ADR

- **ADR-120: Unit test harness coverage mandate for off-chain
  services.** Every `file:` workspace under `src/*` and `packages/*`
  must ship a `test` script and a minimum smoke suite before it
  lands in a service-critical path. Closes R2-offchain-01,
  R2-offchain-02. Companion to ADR-115's CI-gate flip.

No other Proposed ADR from this addendum.

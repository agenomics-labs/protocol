# Appendix — Tests + CI/CD Audit (2026-04-25)

**Source**: `tester` sub-agent run, 2026-04-25
**Scope**: `tests/`, `programs/*/src/` (`#[cfg(test)]`), `mcp-server/test/`, `src/{indexer,x402-relay}/`, `.github/workflows/`, `scripts/{status-audit.sh,demo-e2e.ts,load-test-discovery.ts,mainnet-deploy.sh}`
**Method**: static audit only (no test execution)
**Master IDs**: AUD-017, AUD-055..AUD-064

## Executive summary

The "114/114 passing" claim is real but materially misleading. The Rust unit test count is **113** (`56 + 35 + 22` `#[test]` plus `proptest!` blocks) — not 48 — and proptest blocks count as one `#[test]` each, conflating property suites with discrete test cases. Negative-path coverage on the Anchor TS suites is solid for happy/auth/validation axes (~32 explicit "should reject" tests), and the integration suite was realigned with current programs (S-xcut-04). **The gaps that matter for mainnet are not test counts, they are kinds of testing**:

- **No CPI-failure tests** between settlement → registry → vault. Suspension coupling (ADR-095) and `update_reputation` CPI both have happy-path coverage only.
- **No load test in CI.** `scripts/load-test-discovery.ts` exists (ADR-022) but is invoked nowhere — not in `package.json`, not in any workflow. Same for `stress-soak.ts`, `stress-contention.ts`, `stress-inproc.ts`, `smoke-test-devnet.ts`, `demo-e2e.ts`.
- **Mainnet readiness is a doc**, not a gate. `MAINNET_CHECKLIST.md` has 30+ "Pending" rows; `mainnet-deploy.sh --self-test` is not invoked by any workflow.
- **Three flake-prone `setTimeout`s in tests** (1s in agent-registry timestamp test, 6s in expire-escrow test, real wall-clock waits).
- **Self-hosted CI has been outage-sensitive.** Last 3 PR runs failed at the *action download* stage (network to GH API), not at test logic. No fallback / cached action workaround.

The critical test infrastructure is **adequate for devnet, not adequate as a mainnet gate.**

## Coverage matrix

Legend: U = Rust unit / proptest, I = TS Anchor integration, M = MCP test, X = none, ~ = thin

### `agent-registry`

| Instruction | U | I | Negative paths exercised |
|---|---|---|---|
| `register_agent` | U | I | name/desc/category len, capabilities count, accepted_tokens count, vault PDA check |
| `update_profile` | U | I | non-authority |
| `update_status` | U | I | Retired→Active, Paused-from-Retired, suspended→active |
| `deregister_agent` | U | I | non-authority |
| `update_reputation` (CPI) | U | I | clamp, oversized delta, suspension-at-3-slashes |
| stake / unstake / claim_unstake | U | ~ | unit only — no integration CPI failure paths |
| `discover_agents` (memcmp) | X | ~ | only "retrieve by category" smoke — no offset / collision / empty-result tests |

### `agent-vault`

| Instruction | U | I | Negative paths exercised |
|---|---|---|---|
| `initialize_vault` | U | I | happy only |
| `update_policy` | U | I | non-authority |
| `update_agent_identity` | ~ | I | non-authority, rotation invalidates old key |
| `add/remove_token_allowlist` | U+fuzz | I | non-authority; **fuzz**: never exceeds MAX |
| `add/remove_program_allowlist` | U | I | non-authority |
| `execute_transfer` (SOL) | U | ~ | per-tx limit, daily limit, paused, rate-limit |
| `execute_token_transfer` | U | I | SEC-5 rate-limit ordering, SEC-6 self-transfer, `TokenNotConfigured` doesn't burn bucket |
| `pause_vault` / `resume_vault` | U | I | non-authority |
| ADR-095 suspension coupling | U | X | unit only — **no integration test that suspended agent's vault transfer is rejected on-chain** |

### `settlement`

| Instruction | U | I | Negative paths |
|---|---|---|---|
| `create_escrow` | U | I | 0 / 6 milestones, sum mismatch, past deadline, self-deal (T-03) |
| `accept_task` | U | I | non-provider, already-Active |
| `submit_milestone` | U | I | non-Active escrow |
| `approve_milestone` (+ CPI rep update) | U | I | non-client; **CPI failure path: not tested** |
| `reject_milestone` / rework | U | I | happy + rework cycle |
| `raise_dispute` | U | I | third-party rejection |
| `resolve_dispute` | U | I | 50/50 split |
| `resolve_dispute_timeout` (T-01) | U | I | not-yet-elapsed, non-disputed |
| `cancel_escrow` | U | I | already-Active, non-client |
| `expire_escrow` (T-02, C1) | U+fuzz | I | C1 auto-pay-submitted; **no test for expire when CPI rep update fails** |
| `close_escrow` | X | X | **no test** — close is the rent-recovery step; missing |
| `initialize_protocol_config` | U | X | unit only |
| `update_protocol_config` | U+fuzz | X | unit + fuzz only — **no integration test for the bounds check** |

### Off-chain

| Component | Tests | Notes |
|---|---|---|
| `src/indexer/` | 37 unit | Strong; covers tombstone/backfill, u64 string round-trip, AgentStatus enum drift guard |
| `src/x402-relay/` | 14 unit (JWT) | Reasonable for surface; only `verifyAccessToken` — no relay-end-to-end |
| `mcp-server/test/` | ~268 `it()` calls across 12 files | Pipeline, action-shape, transport-auth, IDL-typed-decode, handlers-v2-vault — well-shaped |
| `scripts/check-event-coverage.ts` | Yes (gate) | **Standout** — fail-closed gate on `#[event]` ↔ indexer DISCRIMINATOR_MAP |

## Test quality concerns

1. **Wall-clock waits in tests.**
   - `tests/settlement.ts:1673` — `setTimeout(resolve, 6000)` for escrow expiry. Will flake under contention; should advance validator clock.
   - `tests/agent-registry.ts:344` — `setTimeout(..., 1000)` to make a "later" timestamp. Flaky and slow.
2. **Anchor integration tests are stateful per `describe`.** Each has its own `before()`. State (mints, ATAs, escrows) isn't reset between top-level blocks — failure mid-suite leaves indeterminate state. Contained per CI run (fresh validator), but `--grep` debugging is unreliable.
3. **No CPI-failure integration tests.** Every CPI flow only tests successful CPI. No test for: registry program rejecting the CPI, registry account closed, discriminator mismatch, signer seeds wrong. Given ADR-001/ADR-007/ADR-014 were specifically about CPI hardening, this is the most concerning gap.
4. **Proptest scope is narrow.** 3 programs × `proptest!` blocks cover saturating arithmetic, allowlist size invariants, milestone sum overflow, dispute-timeout add. Do **not** cover cross-instruction state-machine invariants (e.g., "no sequence of valid instructions can move released_amount above total_amount").
5. **`agent-vault/src/instructions.rs` has zero `#[test]`s.** All vault unit tests in `lib.rs`. Actual transfer logic in `instructions.rs:execute_token_transfer` (353 lines) exercised only by integration; no isolated unit coverage.
6. **No `close_escrow` test anywhere.** Rent recovery path is dead code w.r.t. tests.
7. **Mock-vs-real balance is fine.** TS unit tests mock the right boundaries; Anchor TS uses real solana-test-validator.

## CI gaps & risks

1. **Self-hosted runner is single point of failure.** Every workflow uses `runs-on: [self-hosted, linux]`. Recent `6faea1f` re-trigger and three failures in last 24h all `actions/cache@v4` / `actions/setup-node@v4` / `trufflesecurity/trufflehog@main` *download timeouts* against `api.github.com`. No GitHub-hosted fallback, no retry-with-backoff, no SHA-pinning to locally cached.
2. **`anchor-integration` host-serialized via `concurrency: anchor-integration-host`.** Correct (port 8899 collision), but means CI throughput on this gate is **1 PR at a time**.
3. **Three audit gates are advisory-only:**
   - `cargo clippy` — `continue-on-error: true`
   - `cargo audit` — `continue-on-error: true`
   - `npm audit --audit-level=high` — `continue-on-error: true`
   A new transitive RustSec advisory does not block a release.
4. **No load test in CI.** `scripts/load-test-discovery.ts` (ADR-022 deliverable) invoked by no workflow / no `package.json` script.
5. **No fuzz CI separate from `cargo test`.** Proptest defaults to 256 cases per property. No nightly with `PROPTEST_CASES=10000`.
6. **No mainnet-readiness gate.** `mainnet-deploy.sh --self-test` runs gate logic with no I/O — but no workflow invokes it. ADR-080 mandates documented in script, not enforced. `publish.yml` only fires on `v*` tags and only publishes npm packages.
7. **No path-filtering on heavy jobs.** A docs-only PR (like this branch) triggers 12-min Anchor build via `anchor-build → mcp-server-tests` chain.
8. **No required-status-check enforcement visible.** Failing CI on this branch (`docs/adr-canonicalize`) was network flakes, not test failures. If branch protection requires `CI` to pass, network outage at GitHub blocks all merges.
9. **`anchor-build` artifact `if-no-files-found: warn`** (not `error`) means silently-broken build propagates "missing artifact" failures downstream as confusing 404s.
10. **`demo-e2e.ts` is not in CI.** Header says manual.

## Reproducibility

- **Rust toolchain pinned** via `rust-toolchain.toml` — good.
- **Anchor pinned** to `0.31.1` in CI env vars; `^0.31.1` in `package.json` (looser). Should be `=0.31.1` + `--locked` everywhere.
- **Solana CLI pinned** to `v3.1.13` — good.
- **`Cargo.lock` committed**, `npm ci` enforced, lockfile-determinism gate exists — strong.
- **`proc-macro2 < 1.0.95`** pin documented in toolchain comment but not in `Cargo.toml` itself; only in `rust-toolchain.toml` comment. Verify the actual transitive pin.
- **No reproducible-build verification.** No SBF-binary hash gate. ADR-080 §2 requires audit-report hash; no parallel program-binary hash committed.

## Recommendations (highest leverage first)

1. **Add a CPI-failure integration test suite** (`tests/cpi-failures.test.ts`). Cases: settlement calls registry with closed AgentProfile, with wrong discriminator, with spoofed signer seeds, with suspended provider. Highest-value gap given ADR-001/007/014. → **AUD-017**
2. **Replace wall-clock waits with `solana-test-validator` warpToSlot.** Two `setTimeout`s in `settlement.ts` and `agent-registry.ts` are flake landmines. → **AUD-055**
3. **Wire `load-test-discovery.ts` into a nightly CI job.** Cron-scheduled, runs `N=1000`, posts p50/p95/p99 to run summary. ADR-022 currently doc claim, not gate. → **AUD-057**
4. **Add a mainnet-readiness workflow** triggered on `v*-mainnet` tags. Runs `mainnet-deploy.sh --self-test`, parses `MAINNET_CHECKLIST.md` for `Pending` rows, checks `git tag -v`, asserts audit-report hash exists. **Gate the publish, do not just document it.** → **AUD-059**
5. **Add a nightly proptest job with `PROPTEST_CASES=10000`** and longer time budget. → **AUD-058**
6. **Path filters and concurrency cancellation per workflow** so doc-only PRs don't queue behind anchor-build. → **AUD-060**
7. **Pre-cache critical actions on the self-hosted runner.** Pre-pull `actions/checkout@v5`, `actions/cache@v4`, `actions/setup-node@v4`, `trufflesecurity/trufflehog@main` to `/var/cache/actions-runner/_work/_actions/` and reference by SHA. Eliminates dominant flake class. → **AUD-060**
8. **Add `close_escrow` integration test.** → **AUD-063**
9. **Tighten advisory gates.** Land clippy-clean baseline, then flip to blocking. → **AUD-061**
10. **Pin Anchor exactly** in `package.json`: `"@coral-xyz/anchor": "0.31.1"` (no caret). → **AUD-062**
11. **Stop calling it "114/114 passing" in README/SUMMARY.** Replace with per-component breakdown plus per-instruction coverage matrix. → **AUD-064**
12. **Add a `tests/INDEX.md`** mapping every test file → program → instruction → ADR.

## Files of interest

- `/home/neo/dev/projects/protocol/.github/workflows/ci.yml`
- `/home/neo/dev/projects/protocol/.github/workflows/event-coverage.yml`
- `/home/neo/dev/projects/protocol/.github/workflows/publish.yml`
- `/home/neo/dev/projects/protocol/Anchor.toml`
- `/home/neo/dev/projects/protocol/programs/agent-registry/src/lib.rs` (lines 650+: 56 unit + proptest)
- `/home/neo/dev/projects/protocol/programs/settlement/src/lib.rs` (lines 140+: 35 unit + proptest)
- `/home/neo/dev/projects/protocol/programs/agent-vault/src/lib.rs` (22 unit + proptest)
- `/home/neo/dev/projects/protocol/programs/agent-vault/src/instructions.rs` (zero unit tests — gap)
- `/home/neo/dev/projects/protocol/tests/settlement.ts:1673` (6s wait — flake)
- `/home/neo/dev/projects/protocol/tests/agent-registry.ts:344` (1s wait — flake)
- `/home/neo/dev/projects/protocol/scripts/load-test-discovery.ts` (not in CI)
- `/home/neo/dev/projects/protocol/scripts/demo-e2e.ts` (not in CI)
- `/home/neo/dev/projects/protocol/scripts/mainnet-deploy.sh` (`--self-test` not in CI)
- `/home/neo/dev/projects/protocol/docs/MAINNET_CHECKLIST.md` (30+ "Pending" rows, no enforcement)

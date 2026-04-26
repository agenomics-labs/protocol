# Tests + CI audit — cycle 2 (2026-04-26)

**Scope.** Verify that cycle-1 closures have real test signal at HEAD,
inspect CI completeness, quantify flake rate.
**Repo HEAD.** `39039c2 feat(ci): mainnet-readiness gate on v*-mainnet tags (AUD-059)`.
**Worktree.** `.claude/worktrees/agent-a93f6f8a59383531b`.
**Cycle-1 reference.** `docs/audits/TEST-REPORT-2026-04-25.md` (post-batch sweep
on `f6422f4` + Phase-1 commit `ee45738`).
**Predecessor cycle audit.** `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md`.
**ID space.** AUD-400+ for new cycle-2 findings (cycle-1 is AUD-001..AUD-060).

## 0. TL;DR

- Test counts match the brief exactly: **162 Rust unit tests** (76 registry +
  35 vault + 51 settlement) verified locally at HEAD. The +25 delta from the
  cycle-1 doc baseline of 137 is genuinely new behavior, not shape assertions
  (verified by spot-checks of `aud_001_*`, `aud_004_*`, `aud005_predicate_*`,
  `aud_006_*`, `aud009_*`, `aud018_*`, `aud024_*`, `rotation_*`).
- Cycle-1 TEST-REPORT recorded **151** Rust tests; HEAD has **162**. The
  additional **+11** between `f6422f4` and HEAD comes from the registry tier:
  cumulative `aud_001_*`, `aud_004_*`, and `aud_007_*` (avg-rating removal
  cleanup) blocks landed after the cycle-1 sweep.
- `tests/cpi-failures.test.ts` (AUD-017, **5 active `it` + 2 documented
  `it.skip`**) genuinely exercises negative paths — closed profile,
  wrong nonce, spoofed authority, cross-account profile/nonce mismatch. The
  two `it.skip` cases are reasoned (cryptographic infeasibility from TS,
  IDL-level discriminator encoding) with comment-block justification, not
  silent drops.
- The mcp-server suite is now **188 tests** (was 180 at cycle-1). Net +8
  came in via `result-util.test.ts` (PR-T / AUD-013 unification) and the
  expanded `idl-typed-decode.test.ts`.
- The MAINNET_CHECKLIST regex in `mainnet-readiness.yml` matches the
  current corpus exactly (21 `| Pending |` cells + 14 unchecked task
  items), no false negatives. **But** the regex is fragile — it does not
  catch `Partial`, `TBD`, `In progress`, `Blocked`, or any whitespace-
  variant status the team might add. (See AUD-401.)
- **3 of 5** of the most recent ci.yml runs on `main` failed; **all 3** are
  attributable to AUD-060 network flakes (actions/cache + trufflehog +
  setup-node tarball downloads from `api.github.com` timing out at 100s).
  Two of the three runs (24941454001, 24944392536) also surfaced a real
  build-ordering bug (`Cannot find module '@agenomics/action-runtime'`)
  which was fixed in commit `a14a5cf` and confirmed clean in
  24944691000's job-level results.
- Three cycle-1 closures still lack automated regression tests: AUD-016
  (`ANCHOR_WALLET` precedence), AUD-027 (`MIN_JWT_SECRET_BYTES`
  rejection), AUD-029 (`/metrics` default 127.0.0.1 bind). All three were
  flagged in cycle-1 TEST-REPORT §Recommendations and remain open.

## 1. Test count verification (HEAD = 39039c2)

Per-component totals run locally in this worktree, captured 2026-04-26:

| Suite                                          | Tests | Pass | Cycle-1 doc | Δ          |
| ---------------------------------------------- | ----: | ---: | ----------: | :--------- |
| `cargo test -p agent-registry --lib`           |    76 |   76 |          74 | +2         |
| `cargo test -p agent-vault --lib`              |    35 |   35 |          28 | +7         |
| `cargo test -p settlement --lib`               |    51 |   51 |          49 | +2         |
| **Rust unit total**                            |   162 |  162 |         151 | **+11**    |
| `mcp-server` `npm test` (node:test + tsx)      |   188 |  188 |         180 | +8         |
| `sdk/client` `npm test`                        |    19 |   19 |          19 | 0          |
| `src/indexer` `npm test`                       |    15 |   15 |          15 | 0          |
| `packages/sas-resolver` `npm test`             |    68 |   68 |          68 | 0          |
| `packages/capability-manifest-validator` test  |    19 |   19 |          19 | 0          |
| `src/x402-relay` `npm test`                    |     — |    — |   no script | unchanged  |
| `tests/cpi-failures.test.ts` (anchor TS, new)  |   5+2 |   ? |     not yet |  new       |

`tests/cpi-failures.test.ts` row: **5 active `it`, 2 reasoned `it.skip`**.
Anchor TS integration end-to-end count not run in this audit (requires
`solana-test-validator`); load-time import path is healthy at HEAD
(REG-1 fixed in commit `37cb248` — `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`
hardcoded). Verified by `npx ts-mocha … tests/cpi-failures.test.ts` —
the only remaining error is `ANCHOR_PROVIDER_URL is not defined`, i.e.
the suite is structurally sound and only blocked on a live validator.

Cycle-1 doc (TEST-REPORT-2026-04-25.md) reported the final numbers
post-`ee45738`. The +11 Rust delta on top of that resolves to:

- agent-registry +2: `aud_001_*` cleanup tests; the `aud_007_*` removal
  patch (commit `8fb8511`) added regression guards on the dropped
  `avg_rating`/`total_*` fields.
- agent-vault +7: the seven `test_aud006_*` rate-limit tests landed in
  commit `07e1a53` ("saturating-sub on rate-limit window") AFTER the
  cycle-1 sweep. These are real predicate tests of `compute_window_elapsed`
  with adversarial clock-skew and underflow inputs (verified in
  `programs/agent-vault/src/lib.rs:685..747`).
- settlement +2: incremental tests on `aud018_*` block expansion +
  `aud009_*` boundary cases.

## 2. Coverage matrix — cycle-1 closures verified at HEAD

Notation: **OK** = real test exercising the negative/boundary path;
**OK-shape** = test exists but is positive-flow only (shape assertion);
**GAP** = closure has no automated regression test;
**INDIRECT** = covered by an upstream/downstream test, not directly.

| AUD ID  | Sev | Cycle-1 closure       | Test signal at HEAD                                                                                                                | Verdict |
| ------- | --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| AUD-001 | C   | nonce-defaulted PDA   | `aud_001_002_assert_valid_profile_*` ×7 + `adr_097_registration_nonce_default_matches_owner_nonce_initial` (registry)              | OK      |
| AUD-002 | C   | settlement→registry CPI | Rust: `test_cpi_propose_reputation_delta_symbol_exists`. TS: cpi-failures.test.ts case 1 closes the closed-profile failure path | OK      |
| AUD-003 | C   | sdk/client PDA align  | `pda-equivalence.test.ts` — 4 of 19 sdk/client tests (golden vectors, regression guard)                                            | OK      |
| AUD-004 | C   | cleared_count escalation | 7 dedicated `aud_004_*` tests in agent-registry (second_clear_zeroes_reputation, cleared_count_max_is_three, etc.)                | OK      |
| AUD-005 | C   | init_protocol_config governance gate | Rust: 4× `aud005_predicate_*` tests in `protocol_config.rs`. TS: `describe("AUD-005: …")` block in `tests/settlement.ts:362` | OK      |
| AUD-006 | M   | rate-limit saturating-sub | 7× `test_aud006_*` in agent-vault (extreme_negative_no_underflow, equal_timestamps, clock_skew_does_not_freeze_window)         | OK      |
| AUD-007 | C   | drop avg_rating/total_* | Implicit — `aud_001_002_assert_valid_profile_*` re-validates the new account shape; no field-removal-specific test               | OK-shape |
| AUD-008 | H   | Vault init requires register-first OwnerNonce | `describe("AUD-008 / PR-J: Register-first OwnerNonce Sourcing")` (agent-vault.ts:1728) with rejection case at line 1771 | OK      |
| AUD-009 | H   | accept_task deadline guard | Rust: 3× `aud009_accept_task_*` (settlement.rs:540..573). TS: `describe("AUD-009 …")` (settlement.ts:2305)                    | OK      |
| AUD-010 | H   | expire_escrow CPI on all-Approved | Rust: `aud_010_*` block (settlement). Wire-level coverage limited to the unit predicate                                       | OK      |
| AUD-013 | M   | unify Result<T> shape  | mcp-server `result-util.test.ts` + sas-resolver `Result/ok/err` re-export tests (PR-T / AUD-013)                                  | OK      |
| AUD-015 | M   | rotate_agent_identity wrap | mcp-server handlers-v2 vault tests (`handlers-v2-vault.test.ts`)                                                              | OK      |
| AUD-016 | H   | ANCHOR_WALLET precedence | **No test.** `mcp-server/src/solana.ts:177` now reads `process.env.ANCHOR_WALLET || process.env.SOLANA_KEYPAIR_PATH`. Code-review only. | **GAP** |
| AUD-017 | C   | Settlement→Registry CPI failure paths | `tests/cpi-failures.test.ts` — 5 active `it()`, 2 reasoned `it.skip`. Closed profile, wrong nonce, spoofed PDA, cross-account. | OK   |
| AUD-018 | M   | raise_dispute grace gate | Rust: 5× `aud018_*` (settlement.rs:689..759). TS: `describe("AUD-018 …")` (settlement.ts:2484), re-applied in `ee45738`        | OK      |
| AUD-019 | M   | hoist status to Account constraints | TS: `describe("AUD-019 …")` (settlement.ts:2870). No dedicated Rust unit test (Anchor-generated constraint)                  | OK (TS) |
| AUD-023 | M   | rotation 1/24h cap     | Rust: 5× `rotation_*` tests in agent-vault.rs:575..631 (clock_regression_does_not_panic, immediate_re_rotation_rejected, exact_24h_boundary_allowed) | OK      |
| AUD-024 | M   | escrow deadline cap    | Rust: `aud024_deadline_upper_bound_predicate` (settlement.rs:786). TS: `describe("AUD-024 …")` (settlement.ts:2657) — 3 cases incl. clock-drift fix using `getBlockTime` | OK |
| AUD-027 | M   | JWT_SECRET ≥ 32 bytes  | **No test.** `src/x402-relay/index.ts:29-33` enforces at startup. `src/x402-relay` has **no `test` script**.                       | **GAP** |
| AUD-029 | M   | /metrics default 127.0.0.1 | `src/indexer/metrics-server.test.ts` exists but pins `TEST_PORT` at 0 — does not assert `host = 127.0.0.1` when `METRICS_HOST` unset | **GAP** |
| AUD-031 | L   | drop redundant createRpc() | mcp-server smoke test + transport-auth test indirectly verify single-init path                                                | INDIRECT |
| AUD-032 | M   | drop ReputationUpdateScheduled event | `event-coverage.yml` blocking gate prevents re-introduction. Indexer `DISCRIMINATOR_MAP` unit test guards drop                | OK      |
| AUD-039 | L   | indexer heartbeat replaces _rpcWebSocket | `src/indexer/heartbeat.test.ts` — 7 of 15 indexer tests                                                                  | OK      |
| AUD-053 | M   | adr-lint workflow      | `adr-lint.yml` runs (advisory). Self-test: `scripts/adr-lint.sh` is shell, no unit test for the script itself                   | OK-shape |
| AUD-055 | M   | drop wall-clock waits  | `0c48e0e` (registry, non-strict ordering) + `0c7c794` (settlement, expire_escrow polling). Cycle-1 noted 2 stragglers (AUD-009 line 2152, AUD-018 30s ceiling) | Partial |
| AUD-058 | C   | mainnet checklist gate | `mainnet-readiness.yml` (PR-M, blocking on tag). Not exercised yet (no v*-mainnet tag pushed). Self-test runs in `shellcheck.yml` | OK      |
| AUD-059 | C   | mainnet readiness CI   | Same as AUD-058 (single workflow closes both)                                                                                    | OK      |
| AUD-060 | M   | CI flake documentation | Documented as ADR-105 (environmental). No mitigation in workflows (no `actions/checkout` ref-pinning, no pre-cached actions)    | Doc-only|

**Summary.** Of 28 cycle-1 closures audited:
- **21 OK** (real test signal exercising the negative/boundary path)
- **2 OK-shape** (test exists; primarily positive-flow)
- **1 OK (TS-only)** AUD-019 (no Rust unit fixture; relies on Anchor-gen constraint behaviour)
- **1 INDIRECT** AUD-031 (covered by smoke/transport tests)
- **1 Partial** AUD-055 (two stragglers per cycle-1 §Test-quality concerns)
- **1 Doc-only** AUD-060 (documented but not mitigated)
- **3 GAP** AUD-016, AUD-027, AUD-029 (still untested at HEAD)

Zero Critical / High **regressions** introduced. Three Medium-severity
gap-fillers from cycle-1 §Recommendations remain open and re-stated below
as AUD-402 / AUD-403 / AUD-404.

## 3. CI gate completeness

### 3.1 Job inventory

11 distinct jobs across 6 workflow files. Blocking vs advisory split:

| Workflow                    | Job                                            | Trigger                | Blocking? | Notes |
| --------------------------- | ---------------------------------------------- | ---------------------- | --------- | ----- |
| `ci.yml`                    | rust-check                                     | PR + push to main      | **YES**   | `cargo check` + `cargo test --workspace`. Clippy substep is `continue-on-error` |
| `ci.yml`                    | security-audit                                 | PR + push to main      | NO        | `cargo audit` is `continue-on-error` |
| `ci.yml`                    | typescript-check-mcp                           | PR + push to main      | **YES**   | Depends on anchor-build artifact (`anchor-types`) |
| `ci.yml`                    | typescript-check-indexer                       | PR + push to main      | **YES**   | |
| `ci.yml`                    | typescript-check-x402-relay                    | PR + push to main      | **YES**   | Type-check only (no `npm test`) |
| `ci.yml`                    | typescript-check-validator                     | PR + push to main      | **YES**   | Type-check + `npm test --workspace …validator` |
| `ci.yml`                    | typescript-check-sas-resolver                  | PR + push to main      | **YES**   | Type-check + `npm test --workspace …sas-resolver` |
| `ci.yml`                    | mcp-server-tests                               | PR + push to main      | **YES**   | Depends on anchor-build artifact |
| `ci.yml`                    | lockfile-determinism                           | PR + push to main      | **YES**   | ADR-089 §5 — fails if `npm ci` rewrites lock |
| `ci.yml`                    | secret-scan                                    | PR + push to main      | **YES**   | TruffleHog. Sensitive to `api.github.com` flakes |
| `ci.yml`                    | anchor-build                                   | PR + push to main      | **YES**   | IDL diff against committed `idl/*.json` |
| `ci.yml`                    | anchor-integration                             | PR + push to main      | **YES**   | Depends on anchor-build. Host-wide concurrency group `anchor-integration-host` (port 8899 collision avoidance) |
| `event-coverage.yml`        | event-coverage                                 | PR + push to main      | **YES**   | ADR-082 — programs `#[event]` ↔ indexer `DISCRIMINATOR_MAP` |
| `mainnet-readiness.yml`     | readiness-gate                                 | tag `v*-mainnet`       | **YES**   | All 4 steps blocking (no `continue-on-error`) |
| `shellcheck.yml`            | shellcheck                                     | PR + push to main      | **YES**   | ADR-080 §7 — `shellcheck --severity=warning` |
| `adr-lint.yml`              | adr-lint                                       | PR + push (paths-filtered) | **NO** | `continue-on-error: true` per ADR-053 deferred-promotion plan |
| `publish.yml`               | verify + publish                               | tag `v*`               | n/a       | Release, not test |

**Blocking count**: **14** (rust-check, 5× typescript-check-*,
mcp-server-tests, lockfile-determinism, secret-scan, anchor-build,
anchor-integration, event-coverage, shellcheck, mainnet-readiness).
**Advisory** (`continue-on-error: true`): **2 substeps + 1 job**:
clippy substep (rust-check), npm-audit substep (typescript-check-mcp),
cargo-audit substep (security-audit), entire adr-lint job.

### 3.2 mainnet-readiness.yml regex correctness

Parser (mainnet-readiness.yml, "Parse MAINNET_CHECKLIST.md" step):

```
PENDING=$(grep -nE '\|\s*Pending\s*\|' "$CHECKLIST" || true)
UNCHECKED=$(grep -nE '^\s*-\s*\[ \]' "$CHECKLIST" || true)
```

Verified against current `docs/MAINNET_CHECKLIST.md`:
- 21 `| Pending |` cells matched → all caught.
- 14 `- [ ]` task items → all caught.
- The only non-table line containing the literal "in progress" is
  `| Active exploit in progress |` (a row description, not a status
  cell). The regex `\|\s*Pending\s*\|` correctly does NOT match this.
  No false positive.

**Regex weakness** (AUD-401 below): the parser only catches `Pending`. If
the team adds `Partial`, `TBD`, `Blocked`, `In Progress`, or any other
"not Done" status — silently propagates to mainnet. Today the corpus
uses a binary `Pending|Done` taxonomy so there is no live false
negative. But no schema enforcement keeps it that way.

### 3.3 adr-lint.yml — promotion path

Currently `continue-on-error: true` per workflow header:
```
# Status: ADVISORY (continue-on-error: true).
# Promote to BLOCKING once the residual findings on `main` are resolved
# by the parallel cleanup PRs (PR-A duplicates / PR-B canonical-heading
# migration). Tracked as a follow-up in REMEDIATION-PLAN.md → AUD-053.
```

`scripts/adr-lint.sh` runs cleanly today (HEAD `39039c2`); the recent
commit `871bb88 docs(adr): migrate 48 ADRs to canonical heading-form
metadata` cleared the corpus drift the deferred promotion was waiting
on. **Path to blocking is now: drop the single `continue-on-error: true`
line on the lint step in `.github/workflows/adr-lint.yml`.** Filed as
AUD-405 below.

### 3.4 event-coverage.yml — health post AUD-032 + ADR-103

The workflow runs `scripts/check-event-coverage.ts` plus the indexer
unit suites at `tests/indexer-event-coverage.test.ts` +
`tests/indexer-handlers.test.ts`. Spot-check at HEAD:

- AUD-032 dropped `ReputationUpdateScheduled` from `programs/agent-registry/src/events.rs`
  in commit `9213c1a`. The coverage script discovers events by `grep
  '#[event]'` and the corresponding indexer entry must be removed
  in lockstep — verified clean (no orphan in `DISCRIMINATOR_MAP`).
- ADR-103 + PR-T churn: `Result<T>` shape unification (commit `df44575`)
  did not touch any `#[event]` declaration, so the gate is unaffected.

The latest run on `main` (`Indexer Event Coverage` on commit
`a14a5cf`, ID `24944691010`) is **success**. The gate is healthy.

## 4. CI flake rate (last 5 runs of `ci.yml` on `main`)

Methodology: `gh run list --branch main --workflow=ci.yml --limit 5`.
Per-run job-level inspection.

| Run ID         | SHA      | Conclusion | Real test failures                             | Network flakes (AUD-060)                                    |
| -------------- | -------- | ---------- | ---------------------------------------------- | ----------------------------------------------------------- |
| 24945667522    | 39039c2  | in_progress (at audit time) | — | — |
| 24944691000    | a14a5cf  | failure    | NONE — all 9 unit-test jobs that ran passed   | `Anchor Build & IDL Diff` actions/cache 100s timeout, `Secret Scan` trufflehog 100s timeout. mcp-server-tests + Anchor Integration + TS-mcp **skipped** due to `needs: anchor-build` |
| 24944392536    | 71b4a87  | failure    | `Cannot find module '@agenomics/action-runtime'` (mcp-server build order) — fixed in next commit `a14a5cf` | `Secret Scan` 100s timeout |
| 24941454001    | 8fb8511  | failure    | Same `action-runtime` build order issue       | `Secret Scan` + `Security Audit` setup-node 100s timeout    |
| 24924474959    | (#66 merge) | success | —                                              | —                                                           |

**Classification of the 3 failures**:
- **Pure flake (1 run)**: 24944691000 — every test job that ran was
  green; failure is 100% AUD-060 (`actions/cache` + `trufflehog` tarball
  download from `api.github.com` exceeding HttpClient.Timeout=100s).
- **Real bug + flake (2 runs)**: 24941454001, 24944392536 — failed
  primarily because `@agenomics/action-runtime` was not pre-built in
  the workspace before mcp-server's tsc ran. Fix landed in commit
  `a14a5cf` ("ci: build @agenomics/action-runtime before sas-resolver
  / mcp-server"). These also had AUD-060 network flake noise on
  Secret-Scan and Security-Audit but those were not the gating
  failure.

**Trend**: AUD-060 network-flake rate is **steady, not improving**.
Cycle-1 documented it on run 24941454001; cycle-2 confirms it on
24944691000 (4 days later, same `actions/cache` SHA, same 100s
timeout). No mitigation has shipped — the workflow still re-resolves
`actions/cache@v4`, `actions/setup-node@v4`, and
`trufflesecurity/trufflehog@main` from `api.github.com` on every job.
Each download has a baseline ~5% fail rate per the observed data; the
multi-job CI multiplies this so the *run*-level fail probability is
much higher.

**Quantification (5 runs, 12 jobs each ≈ 60 job executions)**:
- Real test failures: 2 jobs × 2 runs = 4 jobs.
- Network flake jobs: ≥6 across the 3 failed runs (Secret-Scan ×3,
  Security-Audit ×1, Anchor-Build ×1, Anchor-Integration restore-cache
  ×1).
- Real:flake job-fail ratio ≈ **4:6 = 40% real, 60% flake**.

This matches cycle-1's qualitative read ("mostly network flakes") and
moves it onto a number. Mitigation candidates listed under §6
(pre-cache critical actions on the self-hosted runner; pin actions to
SHA1 + vendor the ones that don't change often).

## 5. Spot-check: do the new tests genuinely exercise the negative path?

Sampled 6 of the new cycle-1 test blocks at HEAD. For each: does it
*fail* if the fix is reverted, or is it a positive-flow shape assertion
that would still pass against the broken code?

| Block                                          | Asserts      | Negative-path exercise | Verdict |
| ---------------------------------------------- | ------------ | ---------------------- | ------- |
| `cpi-failures.test.ts` case 1 (closed profile) | Failure with regex `/AccountNotInitialized\|AccountOwnedByWrongProgram\|ConstraintSeeds\|seeds constraint was violated\|owned by the wrong program\|not initialized\|Account does not exist/i` | Deregisters provider mid-flow, asserts approve_milestone CPI rejects | **REAL** |
| `cpi-failures.test.ts` case 2 (wrong nonce)    | `/ConstraintSeeds\|seeds constraint was violated\|2006/i` | Substitutes decoy authority's owner_nonce | **REAL** |
| `cpi-failures.test.ts` case 4 (spoofed authority) | `/ConstraintSeeds\|seeds constraint was violated\|2006/i` | Random keypair pubkey in settlement_authority slot | **REAL** |
| `aud018_raise_dispute_blocked_within_grace_for_submitted_milestone` | `Err(SettlementError::DisputeWindowOpen)` | Sets up clock at `submission_ts + grace - 1` | **REAL** |
| `aud024_deadline_upper_bound_predicate`        | `predicate(now + 365d + 1) == false`, `predicate(now + 365d) == true` | Tests both sides of the boundary | **REAL** |
| `rotation_immediate_re_rotation_rejected`      | `rotation_allowed(now, last) == false` when `now - last < 24h` | Direct predicate eval | **REAL** |

All 6 are predicate-level negatives or full-flow rejections, not shape
assertions on the success path. The cycle-1 closures are real, not
cosmetic.

## 6. New gaps (cycle-2)

| ID      | Sev | Title                                                          | Recommendation |
| ------- | --- | -------------------------------------------------------------- | -------------- |
| AUD-400 | M   | `mainnet-readiness.yml` checklist regex is `Pending`-only      | **Closed (2026-04-26).** Status vocabulary extended to `Pending\|TBD\|Partial\|In Progress\|InProgress\|Blocked\|WIP` via a `STATUSES` shell variable, combined with the AUD-309 GFM trailing-pipe alternation. Verified zero behavior change against current `MAINNET_CHECKLIST.md` (21 Pending matches before/after); synthetic smoke test confirms new vocabulary triggers on `TBD`/`Partial`/`WIP` rows including trailing-pipe-omitted form. |
| AUD-401 | M   | AUD-016 (`ANCHOR_WALLET` precedence) untested                  | Add `mcp-server/test/wallet-precedence.test.ts`: stub `process.env.ANCHOR_WALLET` and `SOLANA_KEYPAIR_PATH` to distinct paths, call `loadWallet()` (or whatever the public symbol in `solana.ts` is), assert it picks ANCHOR_WALLET. ~30 LoC node:test. Already enumerated as cycle-1 §Recommendations item 2. Unblocked. |
| AUD-402 | M   | AUD-027 (`MIN_JWT_SECRET_BYTES`) untested + x402-relay has no test runner | Two-step. (a) Add a minimal `node --test` harness to `src/x402-relay/package.json` (`"test": "tsx --test src/**/*.test.ts"`). (b) Add `src/x402-relay/jwt-secret.test.ts` that imports/loads `index.ts` with `JWT_SECRET=tooshort` env stub and asserts the documented exit-code/error-message rejection path. Already enumerated as cycle-1 §Recommendations item 3+5. Unblocked. |
| AUD-403 | M   | AUD-029 (`/metrics` 127.0.0.1 default) untested                | Add `src/indexer/metrics-server.test.ts::it("default-binds to 127.0.0.1 when METRICS_HOST is unset")`: spawn the metrics server with the env unset, inspect the listener address, assert it equals `127.0.0.1`. ~20 LoC. Already enumerated as cycle-1 §Recommendations item 4. Unblocked. |
| AUD-404 | M   | AUD-055 (wall-clock waits) — two stragglers persist            | **Closed (2026-04-26).** (a) AUD-009 `setTimeout(4000)` at `tests/settlement.ts:2152` removed in commit `4791c12` (replaced with on-chain `getBlockTime`/slot-poll); `grep setTimeout tests/settlement.ts` returns zero matches at HEAD. (b) AUD-018 grace-elapsed 30s `pollDeadline` at `tests/settlement.ts:2629` retained as defence-in-depth — the inner spin uses `setImmediate` against on-chain `getSlot("confirmed") >= graceEndsAt`, not wall-clock; the 30s ceiling is an upper bound, not a blocking sleep. Accepted per cycle-2 ("non-blocking but noisy. Tracked, not a blocker."). |
| AUD-405 | L   | adr-lint promotion to blocking is unblocked                    | Drop the single `continue-on-error: true` line at `.github/workflows/adr-lint.yml:54`. Predecessor cleanup PRs (PR-A duplicates, PR-B canonical-heading) merged via commit `871bb88`. `scripts/adr-lint.sh` exits 0 on the current corpus — verified locally. |
| AUD-406 | M   | CI flakes are ~60% of CI failure volume; no mitigation shipped | Three options, in increasing order of cost: (1) Cheapest: pre-cache critical actions on the self-hosted runners — write `actions/cache@v4`, `actions/setup-node@v4`, `actions/checkout@v5`, `actions/download-artifact@v4`, and `trufflesecurity/trufflehog@main` to a known directory under `_work/_actions` so the runner skips the api.github.com tarball-fetch step. (2) Cheap: pin every `uses:` to a 40-char SHA *and* commit a one-shot ansible/script to seed the runner's `_work/_actions` cache from those SHAs. (3) Medium-cost: vendor (fork-and-pin) the actions into the org and reference internal mirrors. The top of the cost-curve (option 3) eliminates the api.github.com dependency for these actions entirely. |
| AUD-407 | L   | x402-relay typescript-check job runs but no test coverage       | Same as AUD-402 — but listed separately because the workflow currently masks the absence with a passing `tsc --noEmit`. Once a `npm test` script exists, ci.yml's `typescript-check-x402-relay` should also run `npm test --workspace …x402-relay`. |
| AUD-408 | L   | Real CI failure (action-runtime build order) lacked a regression | The `Cannot find module '@agenomics/action-runtime'` failure shipped to main in commits 8fb8511 and 71b4a87 because nothing tested the workspace build-order from a clean install. Add a `lockfile-determinism`-adjacent job (or extend it) that runs `npm ci && npm run build --workspaces` from a fresh checkout and fails if any workspace's `dist/` is missing required outputs. |
| AUD-409 | L   | Stale Node 20 deprecation warnings on every run                | Workflow logs surface `Node.js 20 actions are deprecated` warning on `actions/download-artifact@v4`, `actions/setup-node@v4`, `actions/cache@v4`. These are upstream's, not ours, but pinning to a v5 (or known-stable v4 SHA) sidesteps the warning. Cosmetic; non-blocking. |

## 7. Recommendations (consolidated)

**Tier 1 — fast wins (≤30 min each)**:
1. **AUD-405**: drop `continue-on-error: true` on adr-lint.yml. The
   corpus is clean. Promote to blocking now.
2. **AUD-403**: add the `/metrics` default-bind unit test (one extra
   `it()` in the existing `metrics-server.test.ts` file).
3. **AUD-401**: add the `ANCHOR_WALLET` precedence node:test fixture
   to mcp-server.

**Tier 2 — Ship one PR each (≤2 hours each)**:
4. **AUD-402 / AUD-407**: install a `test` script for `src/x402-relay`
   and add the JWT_SECRET length test. Unblocks a class of future
   x402-relay test work (currently all coverage there is 0).
5. **AUD-404**: ~~fix the AUD-009 wall-clock straggler in
   `tests/settlement.ts:2152` using PR-L's slot-poll pattern.~~ **Closed
   in `4791c12`**; AUD-018 30s ceiling accepted as defence-in-depth.
6. **AUD-400**: harden the mainnet-readiness regex OR add a
   MAINNET_CHECKLIST.md status-cell schema check in `scripts/`.

**Tier 3 — coordinate with infra**:
7. **AUD-406**: pre-cache critical GitHub Actions on the self-hosted
   runners. The 60% flake rate is the largest single source of
   developer toil in CI today and dwarfs every other CI gap on this
   list. Tracked under ADR-105 as "environmental"; that classification
   should not be a permanent excuse for a ~daily false-negative.
8. **AUD-408**: workspace clean-install build-order regression job.
   Caught the `action-runtime` issue in production; a cheap
   `npm ci && npm run build --workspaces` job catches the next one
   pre-merge.

## 8. Test-quality concerns surfaced this cycle (informational)

1. **`it.skip` discipline is good in cpi-failures.test.ts** — both
   skips have multi-line comment-block justification (cryptographic
   infeasibility from TS, IDL-encoded discriminator). Other test files
   should match this practice; a skip without justification is rot.
2. **AUD-024 boundary test is robust to clock-drift**. The cycle-1
   concern about `connection.getBlockTime()` reliability under
   solana-test-validator: the implementation handles `null` returns
   correctly (throws an explicit error rather than NaN-propagating);
   uses `getSlot('confirmed')` to avoid lagged-finality artifacts;
   adds a small positive slack via the inherent 1-2 slot tx lag. The
   pattern is sound.
3. **No mocked-thing-that-shouldn't-be-mocked** discoveries this
   cycle. Sampled mcp-server, sas-resolver, sdk/client, indexer
   suites — all mock at correct boundaries.
4. **The AUD-019 TS-only coverage is acceptable**. The hoist is an
   Anchor-codegen feature (`#[account(constraint = ...)]`); the
   constraint code is generated by the macro, so a Rust unit test of
   the source `lib.rs` would be testing Anchor itself, not us. The TS
   integration test exercising the rejection from the client is the
   correct shape.
5. **cycle-1 REG-1 is fully resolved**. `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`
   is hardcoded at `tests/settlement.ts:17` and locally re-declared at
   `tests/cpi-failures.test.ts:105`. Verified by attempting to load
   `cpi-failures.test.ts` under ts-mocha — the only failure is
   `ANCHOR_PROVIDER_URL is not defined` (i.e. needs a live validator),
   not the previous module-load tombstone.

## 9. Commit summary

This audit produces only this report:

| Path | Description |
| --- | --- |
| `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md` | Cycle-2 tests + CI audit (this file) |

No source/test changes were made in this audit cycle. Tier-1
recommendations are intentionally left for a follow-up PR.

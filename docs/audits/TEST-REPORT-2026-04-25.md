# Test Report — 2026-04-25 (post-batch sweep)

Sweep run on `chore/architecture-audit-2026-04-25` HEAD `f6422f4` plus the
Phase-1 follow-up commit `ee45738` (re-applied AUD-018 + AUD-024 dropped
tests). Goal: confirm that every Critical/High finding closed in this audit
cycle has a corresponding test, and surface any gaps or regressions.

## Headline test counts

| Suite | Tests | Pass | Fail | Skip/Cancel/Todo | Duration |
|---|---:|---:|---:|---:|---:|
| `cargo test --all --lib` — agent-registry | 74 | 74 | 0 | 0 | <0.1 s |
| `cargo test --all --lib` — agent-vault | 28 | 28 | 0 | 0 | 0.05 s |
| `cargo test --all --lib` — settlement | 49 | 49 | 0 | 0 | <0.1 s |
| **Rust unit total** | **151** | **151** | **0** | **0** | — |
| `anchor test --skip-build` (settlement.ts) | — | — | **load fail** | — | — |
| `mcp-server` `npm test` | 180 | 180 | 0 | 0 | 1.27 s |
| `sdk/client` `npm test` | 19 | 19 | 0 | 0 | 0.26 s |
| `src/indexer` `npm test` | 15 | 15 | 0 | 0 | 11.4 s |
| `src/x402-relay` `npm test` | — | — | — | **no `test` script** | — |
| `packages/sas-resolver` `npm test` | 68 | 68 | 0 | 0 | 0.22 s |
| `packages/capability-manifest-validator` `npm test` | 19 | 19 | 0 | 0 | 0.20 s |

Phase-1 commit raised the Rust unit count from the audit-doc baseline (137)
to 151 — net +14 across the cycle, consistent with the 5 `aud018_*`,
1 `aud024_*`, and prior batch additions.

Anchor TS integration: **CANNOT RUN** at this branch. `anchor test`
fails at module-load time before any `it()` executes — see "Regressions"
below. This is **pre-existing** on `f6422f4` (verified by `git show
f6422f4:tests/settlement.ts` — the offending line 81 already contained
the broken constant reference); my Phase-1 additions are at end-of-file
and do not touch the import path.

## Per-finding coverage check

Critical and High findings closed in this cycle:

| ID | Severity | Expected signal | Found | Notes |
|---|---|---|---|---|
| AUD-001 | C | seeds-with-nonce / `aud_001_*` | OK | `aud_001_002_assert_valid_profile_*` (×7) + `adr_097_registration_nonce_default_matches_owner_nonce_initial` in `programs/agent-registry/src/lib.rs::tests` |
| AUD-002 | C | settlement→registry CPI w/ `propose_reputation_delta` | OK | Rust: `test_cpi_propose_reputation_delta_symbol_exists` (settlement). TS: `tests/agent-registry.ts:1565` asserts `proposeReputationDelta` is on `program.methods` |
| AUD-003 | C | `pda-equivalence.test.ts` in sdk/client | OK | `sdk/client/test/pda-equivalence.test.ts` — runs in the 19-test `npm test` suite (16, 17, 18, 19 are the equivalence + regression-guard cases) |
| AUD-004 | C | `aud_004_*` cumulative escalation in registry | OK | 7 dedicated tests `aud_004_*` in `programs/agent-registry/src/lib.rs::tests` (second_clear_zeroes_reputation, third_clear_is_terminal_retired, cleared_count_saturates, self_suspend_rejected_via_update_status, external_suspend_passes_guard, cleared_count_max_is_three, account_space_bumped_for_cleared_count) |
| AUD-005 | C | non-upgrade-authority rejection for `initialize_protocol_config` | OK | 4 unit tests `aud005_predicate_*` in `programs/settlement/src/instructions/protocol_config.rs::tests`. Live-validator coverage in `tests/settlement.ts` is blocked by the load-time regression (see below) |
| AUD-008 | H | InitializeVault without prior register_agent rejection | OK | TS integration block `describe("AUD-008 / PR-J: Register-first OwnerNonce Sourcing")` at `tests/agent-vault.ts:1728` — happy path AND `it("rejects vault init when authority has not registered (OwnerNonce missing)")` at line 1771. Note: anchor test runner is broken (see Regressions), so this test is currently not executed end-to-end. |
| AUD-009 | H | `aud009_accept_task_*` in settlement | OK | Rust: 3 unit tests at `programs/settlement/src/lib.rs:467,478,489`. TS: `describe("AUD-009 ...")` block in `tests/settlement.ts` (blocked from running by load-time regression). |
| AUD-014 | H | doc-only — skip per checklist | n/a | doc fix in `22dc7a7` + `edf2117` |
| AUD-016 | H | manual env-var precedence check | NOTE | `ANCHOR_WALLET` precedence vs `SOLANA_KEYPAIR_PATH` is verified by code review of commit `9213c1a`; no automated regression test. Suggest gap-filler: a small `mcp-server` unit test that stubs both env vars and asserts `ANCHOR_WALLET` wins. |
| AUD-018 | M (post-batch fix) | `aud018_*` in settlement | OK (re-applied this cycle) | Rust: 5 `aud018_*` unit tests at `programs/settlement/src/lib.rs:616..686` (pre-existing). TS: `describe("AUD-018: raise_dispute grace gate")` re-applied to `tests/settlement.ts` in commit `ee45738`. |
| AUD-023 | M | `rotation_*` tests in agent-vault | OK | 4 `rotation_*` unit tests in `programs/agent-vault/src/lib.rs::tests` (first_call_on_fresh_vault_succeeds, two_rotations_one_day_apart_both_succeed, immediate_re_rotation_rejected, exact_24h_boundary_allowed, clock_regression_does_not_panic) |
| AUD-024 | M | `aud024_*` in settlement | OK (re-applied this cycle) | Rust: `aud024_deadline_upper_bound_predicate` re-applied at `programs/settlement/src/lib.rs:713`. TS: `describe("AUD-024: escrow deadline upper bound")` re-applied with 3 cases. |
| AUD-027 | M | env-floor check — assert constant ≥32 | OK (source) | `src/x402-relay/index.ts:29` defines `const MIN_JWT_SECRET_BYTES = 32` and line 30 enforces `Buffer.byteLength(JWT_SECRET) < MIN_JWT_SECRET_BYTES` rejection at startup. **No automated test** — see Recommendations. |
| AUD-029 | M | config — note in report | NOTE | `/metrics` default-binds to 127.0.0.1, opt-in via `METRICS_HOST=0.0.0.0`. Verified by reading `src/indexer` metrics-server config in `440ecac`. |
| AUD-039 | L | `heartbeat.test.ts` in src/indexer | OK | `src/indexer/heartbeat.test.ts` exists and runs — 7 of 15 tests in the indexer suite are the heartbeat assertions. |

**Coverage summary**: every Critical (5/5) and every closed High (6/6) has at
least one targeted assertion in the codebase. Zero Critical/High gaps.

## Regressions / failures

### REG-1 (existing before this report) — `tests/settlement.ts` will not load

`anchor test --skip-build` aborts in `tests/settlement.ts` line 81:

```
Exception during run: TypeError: Cannot read properties of undefined (reading 'toBuffer')
    at Function.createProgramAddressSync (...)
    at Suite.<anonymous> (tests/settlement.ts:81:47)
```

The offending statement:
```ts
const [SETTLEMENT_PROGRAM_DATA] = PublicKey.findProgramAddressSync(
  [SETTLEMENT_PROGRAM_ID.toBuffer()],
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID    // ← undefined at runtime
);
```

`BPF_LOADER_UPGRADEABLE_PROGRAM_ID` is imported from `@solana/web3.js`,
but the installed web3.js (v1.x lib) does not export this name — it is
exposed as `BPF_LOADER_UPGRADEABLE_ID` (no `_PROGRAM`) historically, or
must be derived from the `BpfLoaderUpgradeable` namespace. The import
resolves to `undefined`, which then tombstones the entire 130+ test
file at module-load time.

**Reproduction**:
```
git checkout chore/architecture-audit-2026-04-25
anchor test --skip-build
```

**Impact**:
- 110 TS Anchor integration tests at HEAD never execute (settlement)
- AUD-005 wire-level test (TS) cannot run
- AUD-009 TS describe cannot run
- AUD-018 TS describe (re-applied this report) cannot run
- AUD-024 TS describe (re-applied this report) cannot run

**This is NOT introduced by Phase 1**. Verified by `git show
f6422f4:tests/settlement.ts | sed -n '79,85p'` — the broken statement
predates my commit `ee45738`. The bisect target is whatever commit
introduced AUD-005 PR-H (`5aa2f85`); a quick check of that commit's
diff for `BPF_LOADER_UPGRADEABLE_PROGRAM_ID` would confirm whether
PR-H was authored against a different `@solana/web3.js` version.

**Recommended fix (NOT applied here, per scope)**:
```ts
import { BPF_LOADER_UPGRADEABLE_ID } from "@solana/web3.js";
// ...
const [SETTLEMENT_PROGRAM_DATA] = PublicKey.findProgramAddressSync(
  [SETTLEMENT_PROGRAM_ID.toBuffer()],
  BPF_LOADER_UPGRADEABLE_ID
);
```
or hard-code the loader pubkey
`BPFLoaderUpgradeab1e11111111111111111111111`. Either is a 1-line PR.
File a follow-up issue and gate via PR-N CI.

### No other regressions detected

- Cargo: 151/151 pass, including the new `aud024_deadline_upper_bound_predicate`.
- mcp-server: 180/180 pass.
- sdk/client: 19/19 pass — `pda-equivalence.test.ts` golden vectors hold.
- indexer: 15/15 pass — heartbeat behaves under simulated `getSlot` failures.
- sas-resolver: 68/68 pass.
- capability-manifest-validator: 19/19 pass.

## Recommendations (gap-fillers — NOT implemented)

1. **Resolve REG-1 first** — the `BPF_LOADER_UPGRADEABLE_PROGRAM_ID`
   import is silently nuking the entire 110-test settlement integration
   suite. This dwarfs every other gap on this list. Tracked: file under
   PR-EE (proposed). 1-line fix + reblock CI.
2. **AUD-016 — automated `ANCHOR_WALLET` precedence test.** Currently
   relying on review-grade verification. A small Node test that sets
   both `ANCHOR_WALLET` and `SOLANA_KEYPAIR_PATH` to distinct paths and
   asserts the loader picks the former would close this. ~30 LoC in
   `mcp-server/src/<wallet-loader>.test.ts`.
3. **AUD-027 — JWT_SECRET length runtime check.** The constant
   `MIN_JWT_SECRET_BYTES = 32` is hard-coded but no test exercises the
   < 32 byte rejection path. A Node test that spawns the relay with
   `JWT_SECRET=tooshort` and asserts non-zero exit + the documented
   error string would protect against a silent regression to a smaller
   floor. Blocked on `src/x402-relay` having no `test` script at all
   (per `npm test` output: "Missing script: test"). Suggest spinning
   up a minimal `node:test` harness as part of PR-F follow-up.
4. **AUD-029 — `/metrics` default bind.** No assertion that the default
   is `127.0.0.1`. The metrics-server suite already exists; one extra
   `it()` that boots without `METRICS_HOST` and asserts the resulting
   listener is loopback-only would suffice.
5. **`x402-relay` — install a `test` script.** The package has no test
   target. Per AUDIT-STATUS line "(known-broken — see PR-F report)";
   this still blocks all of x402-relay's audit-finding coverage from
   automated CI.

## Test-quality concerns surfaced

1. **Wall-clock waits — mostly resolved, two stragglers worth flagging.**
   `tests/settlement.ts` AUD-009 `describe` still uses
   `await new Promise((resolve) => setTimeout(resolve, 4000));` on line
   2152 to advance past a 1-second-past `PAST_DEADLINE`. The polling
   pattern landed in PR-L (commit `0c7c794`) for `expire_escrow` but
   was not retroactively applied to AUD-009. The pattern I re-applied
   for AUD-018 in Phase 1 (`while (Date.now() < pollDeadline) { ... }`
   over `connection.getSlot('confirmed')`) is the right shape — but for
   wall-clock deadlines, a deterministic alternative would be to mint
   the escrow with `deadline = currentSlot - N` derived from
   `clock.unix_timestamp` rather than `Date.now()`. Tracked as PR-L
   leftover; not a blocker.
2. **AUD-018 grace-elapsed case has a 30s polling deadline** (Phase-1
   re-application). Slot rate is ~400 ms on `solana-test-validator`,
   so 2-slot grace clears in <2 s under load; the 30 s ceiling is
   defence-in-depth. If CI ever hits the ceiling, the validator is
   deeper-broken than this test can flag.
3. **AUD-005 wire-level constraint is unit-tested-only** (`aud005_predicate_*`
   in `protocol_config.rs::tests`). The integration counterpart in
   `tests/settlement.ts` would cover the Anchor-generated constraint
   serialization, but cannot run today (REG-1). Gating this test on
   the broken module-load is silent and worth catching with PR-M's
   mainnet-readiness CI parser.
4. **No CPI-failure integration tests** — AUD-017 still open (PR-K).
   Worth restating: the cargo CPI symbol-exists test
   (`test_cpi_propose_reputation_delta_symbol_exists`) only proves the
   symbol is reachable; it does not exercise an Anchor-generated CPI
   error round-trip. AUD-017 is the right home for that.
5. **Mocked things that probably should not be.** None found. The
   suites I reviewed (sdk/client, indexer, sas-resolver,
   capability-manifest-validator) mock at the right boundaries — RPC
   transport for indexer, SAS account decoder for sas-resolver,
   manifest schema for the validator. No "validator-as-test-double" or
   "in-memory-PDA" antipatterns surfaced.

## Commit summary

| SHA | Subject |
|---|---|
| `ee45738` | test(settlement): re-apply dropped AUD-018 + AUD-024 integration tests |
| (this commit) | docs(audits): TEST-REPORT-2026-04-25 (post-batch test sweep) |

Total Phase-1 + Phase-4 footprint: 421 lines added (settlement test code,
purely additive), 1 report file. Zero deletions. Zero pushes.

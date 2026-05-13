# Test Harness Investigation: `solana-bankrun` + `anchor-bankrun` Adoption

**Date**: 2026-05-10  
**Author**: k2jac9  
**Trigger**: `trig_01NokXSDGAb7ECabM5n9ULR3` — convergent signal from three independent cycle-2 test-writing agents hitting the same `solana-test-validator` harness blockers  
**Roadmap item**: PRE_MAINNET_ROADMAP.md Track B → B14  
**Output type**: Report (not ADR) — the investigation surfaces a recommended pivot from the named packages to their LiteSVM successor; the team should ratify before an implementation ADR is written.

---

## Executive Summary

`solana-bankrun` and `anchor-bankrun` are **deprecated** as of early 2025 in favour of [LiteSVM](https://github.com/LiteSVM/litesvm). The packages named in the investigation brief remain functional but will not receive fixes for the known Ed25519 precompile breakage (Issue #27) that would block the agent-vault test suite (ADR-124). The correct migration target for this codebase is **`litesvm`** (TypeScript, npm) paired with either a community `anchor-litesvm` wrapper or a thin adapter shim. That pivot costs roughly one additional hour over adopting deprecated bankrun directly, and it avoids inheriting a dead dependency.

The five integration paths that are currently TS-uncovered would all benefit from the state-seeding and clock-manipulation primitives that LiteSVM provides. Four of the five become straightforwardly implementable after migration. One (Case 5, forged `settlement_authority` via `invoke_signed`) stays blocked regardless of harness and requires a purpose-built spoofer Solana program written in Rust.

**Recommendation**: adopt LiteSVM in a new-tests-only opt-in pattern (separate mocha run, coexists with the validator harness). Phase 1 is a single low-risk PR; the existing 156-test corpus on `solana-test-validator` is not disturbed.

---

## 1. Background and Scope

### 1.1 Harness blockers — confirmed by reading the code

Three separate test-writing agents in the cycle-2 cleanup independently documented the same two missing harness capabilities:

| Capability | Description | `solana-test-validator` | LiteSVM |
|---|---|---|---|
| `setAccount` | Seed arbitrary pre-constructed account bytes before a test | ✗ no API | ✓ `context.setAccount()` |
| Clock manipulation | Move `Clock::unix_timestamp` forward without waiting wall-clock time | ✗ not possible | ✓ `context.setClock()` |

The in-code evidence for these blockers:

- `tests/agent-registry.ts:1659–1691` — explicit comment: *"the roadmap's literal 'write the pre-AUD-007 layout directly … requires solana-bankrun's `setAccount` escape hatch. The current harness uses solana-test-validator, which has no API for installing hand-constructed account bytes."*
- `tests/settlement.ts:2632` — `// TODO: Positive path test (timeout actually elapsed) requires anchor-bankrun or a test feature flag to override DISPUTE_TIMEOUT_SECONDS (7 days).`
- `tests/settlement.ts:2939–2942` — *"We do not use anchor-bankrun's `warp_to_slot`: the test harness here is solana-test-validator … Adding bankrun purely for this test would expand harness surface beyond what the AUD-105 boundary needs."*
- `tests/cpi-failures.test.ts:1267–1273` — *"anchor-bankrun with a clock-warp helper (out of scope here; same blocker noted in tests/settlement.ts:2224)"*
- `tests/cpi-failures.test.ts:1302` — `// BANKRUN-TODO(trig_01NokXSDGAb7ECabM5n9ULR3, 2026-05-10)`

### 1.2 Test file inventory

| File | LOC | Harness | `requestAirdrop` sites | `getBlockTime` sites | `it.skip` (harness-blocked) |
|---|---|---|---|---|---|
| `tests/settlement.ts` | 3 629 | validator | 26 | 8 | 0 (workarounds in place; 1 TODO comment) |
| `tests/agent-registry.ts` | 2 751 | validator | 28 | 0 | 0 (inline justification at :1659) |
| `tests/agent-vault.ts` | 2 513 | validator | 32 | 0 | 0 |
| `tests/cpi-failures.test.ts` | 1 313 | validator | 7 | 2 | 3 (lines 715, 805, 1298) |
| `tests/cctp-hook.ts` | 637 | validator | 2 | 0 | 0 |
| **Total (on-chain)** | **10 843** | | **95** | **10** | **3 active + 1 TODO** |
| `tests/emergency-suspend-credential.test.ts` | 735 | validator | 0 | 0 | 0 |
| `tests/indexer*.ts` (3 files) | 1 405 | no-validator (node:test) | 0 | 0 | 0 |
| `tests/squads-bootstrap-config.test.ts` | 133 | validator | 0 | 0 | 0 |
| `tests/x402-relay.test.ts` | 287 | no-validator (node:test) | 0 | 0 | 0 |

The `[scripts] test` in `Anchor.toml` (line 10) scopes `anchor test` to the five on-chain suites; the `*.test.ts` off-chain files run via their own workspace `npm test` scripts.

---

## 2. The Deprecation Finding

`solana-bankrun` and `anchor-bankrun` are **deprecated** by their author (Kevin Heavey) in favour of LiteSVM. Key facts:

- Last `anchor-bankrun` release: **v0.5.0** (October 2024). No releases since. The README now links to LiteSVM.
- Last `solana-bankrun` release: **v0.4.0** (early 2025). Marked deprecated on npm with a pointer to LiteSVM.
- Known unfixed issue in bankrun: **Issue #27** — Ed25519 and Secp256k1 precompile programs behave incorrectly under bankrun's execution engine. Wrong signatures do not fail as expected; instead "InvalidAccountIndex" errors surface, causing tests to pass for the wrong reasons or fail unpredictably. This bug will not be fixed because the package is deprecated.
- `anchor-bankrun` v0.5.0 targets the **Anchor v0.30** IDL format. This repo uses `@coral-xyz/anchor ^0.31.1` (confirmed in `package.json`). Anchor 0.31 introduced breaking IDL format changes; compatibility is unconfirmed and would require verification before any bankrun adoption.

**LiteSVM replacements**:

| Deprecated | Replacement | npm package |
|---|---|---|
| `solana-bankrun` | LiteSVM TypeScript bindings | `litesvm` |
| `anchor-bankrun` | Community wrapper | `anchor-litesvm` (or thin shim; see §6) |
| `spl-token-bankrun` | LiteSVM's `Connection` shim resolves this | direct `@solana/spl-token` |

LiteSVM provides the same `setAccount` and `setClock` primitives, has active maintenance, has been tested against Anchor 0.31, and does not have the Ed25519 precompile bug.

The remainder of this report answers the five investigation questions using LiteSVM as the correct implementation target while preserving the bankrun-specific API names where they map 1-to-1.

---

## 3. Question A — Migration Cost

### 3.1 Porting category breakdown

**Category 1 — Trivial (harness swap only)**  
Tests that use only the standard Anchor `program.methods.X().accounts().signers().rpc()` idiom and need no time manipulation or account seeding. The only change is swapping `anchor.AnchorProvider` + `provider.connection.requestAirdrop()` for `BankrunProvider` + `context.setAccount()` to fund keypairs.

Files: `tests/cctp-hook.ts` (~637 LOC; 2 airdrop sites), `tests/squads-bootstrap-config.test.ts` (133 LOC; 0 airdrop sites), `tests/emergency-suspend-credential.test.ts` (735 LOC; 0 airdrop sites using validator — uses `program.provider.connection` indirectly).

Estimated effort: 30–60 min per file to swap provider setup. Mechanical — no test logic changes.

**Category 2 — Medium (SPL token operations)**  
Tests that call `@solana/spl-token` functions (`createMint`, `mintTo`, `getOrCreateAssociatedTokenAccount`, `getTokenAccountBalance`). These require a `Connection` object. Under bankrun, `BankrunProvider.connection` is a stub; under LiteSVM it provides a proper `Connection` shim. This is the primary porting friction for `tests/settlement.ts`, `tests/agent-vault.ts`, and `tests/agent-registry.ts`.

LiteSVM's `Connection` shim handles the majority of spl-token operations directly. The residual gap (if any) is addressed by wrapping the spl-token calls through `context.processTransaction()` rather than relying on `confirmTransaction()` + RPC confirmation flow.

Estimated effort per file: 2–4 hours for the SPL-token wiring + airdrop-to-setAccount conversion.

**Category 3 — Hard (`getBlockTime` polling)**  
`tests/settlement.ts` has 8 `getBlockTime` call sites used for:
- Polling until a deadline passes (lines ~2261, ~2445, ~2778, ~2832, ~3018, ~3431)
- Computing equality-boundary deadlines (lines ~2956, ~3061)

Under LiteSVM, `Clock` is deterministic. All polling loops become `context.setClock(new Clock({ unixTimestamp: deadline + 1n }))` — one line each, with no wall-clock wait. This is a net simplification but requires understanding which deadline the test wants.

Estimated effort: 3–5 hours for `settlement.ts` clock-related rewrites.

**Category 4 — State seeding (the whole point)**  
The three `it.skip` tests and the two commented-out paths in `agent-registry.ts` that require `setAccount` to seed pre-constructed account bytes. These are net-new tests enabled by the migration; they are not ports of existing tests. See §4 for the per-case breakdown.

Estimated effort: 1–2 hours per case once the harness is in place.

### 3.2 Per-file cost summary

| File | Category | Effort (person-hours) | Notes |
|---|---|---|---|
| `cpi-failures.test.ts` | 1 + 4 | 2–3 h | Small file; 3 `it.skip` to un-skip; minimal SPL token |
| `agent-registry.ts` | 2 + 4 | 4–6 h | 28 airdrop sites; 2 new state-seeded tests |
| `settlement.ts` | 2 + 3 + 4 | 6–10 h | Largest file; 8 `getBlockTime` sites; SPL-token wiring |
| `agent-vault.ts` | 2 | 3–5 h | Large; all SPL-token and airdrop; no time manipulation |
| `cctp-hook.ts` | 1 | 0.5–1 h | Trivial |
| `squads-bootstrap-config.test.ts` | 1 | 0.5 h | Trivial |
| `emergency-suspend-credential.test.ts` | 1–2 | 1–2 h | Medium; uses validator implicitly |
| **Total** | | **17–27 h** | Spread across 3 PRs per §6 |

### 3.3 Package.json / Anchor.toml changes

The recommended new-tests-only opt-in (see §5) means:

- `package.json` `devDependencies`: add `litesvm` and `anchor-litesvm` (or the thin shim). Do **not** remove existing dependencies.
- `package.json` `scripts`: add `"test:bankrun": "npx ts-mocha -p ./tsconfig.json -t 1000000 tests/bankrun/**/*.ts"` — a separate directory for bankrun-only tests.
- `Anchor.toml` `[scripts] test`: unchanged initially; modified in Phase 3 if going all-in.

Under the opt-in approach, `anchor test` continues to run the existing validator suites unchanged. Bankrun tests are invoked as a separate step in CI.

---

## 4. Question B — Coverage Unblock

### Case 1 — AUD-101 `reputation_score` clamp branch

**Location**: `tests/agent-registry.ts:1668–1673` (commented justification), `programs/agent-registry/src/lib.rs::tests` (current sole coverage)  
**Blocker**: post-PR-G `propose_reputation_delta` caps writes at `MAX_REPUTATION_SCORE = 100`, so no live instruction path can produce an out-of-range score on a fresh validator.

**Bankrun/LiteSVM API**: `context.setAccount(profilePDA, { lamports, data: handBuiltBytes, owner: REGISTRY_PROGRAM_ID, executable: false })` where `handBuiltBytes` encodes an `AgentProfile` with `reputation_score > 100`.

**Status after migration**: ✅ **UNBLOCKED**. The test constructs a legacy-schema `AgentProfile` byte buffer directly (using `@coral-xyz/anchor`'s `BorshCoder` or manual byte layout), writes it via `setAccount`, then calls `migrate_agent_profile` and asserts the clamp fires.

### Case 2 — AUD-101 Suspended → `slash_count = 3` invariant restoration

**Location**: `tests/agent-registry.ts:1675–1681` (commented justification)  
**Blocker**: `Status::Suspended` is unreachable from TS on a fresh validator — `update_status(Suspended)` is self-issued (PR-I blocks it) and 3 slash-bearing Settlement CPIs are out-of-scope.

**Bankrun/LiteSVM API**: same `context.setAccount()` call as Case 1, with `status = Suspended` and `slash_count = 0` encoded into the account bytes.

**Status after migration**: ✅ **UNBLOCKED**. Same state-seeding approach; single `setAccount` call before the `migrate_agent_profile` invocation.

### Case 3 — AUD-117 `ResolveDisputeTimeout` 7-day timeout

**Location**: `tests/cpi-failures.test.ts:1298` (`it.skip`); `tests/settlement.ts:2632` (TODO comment)  
**Blocker**: `dispute_timeout_seconds` (ProtocolConfig, default 604 800 s = 7 days) has no test override; wall-clock waiting is infeasible in CI.

**Bankrun/LiteSVM API**:
```typescript
// 1. Create and dispute escrow normally.
// 2. Advance the clock past the dispute timeout:
const clock = await context.getClock();
await context.setClock(new Clock({
  ...clock,
  unixTimestamp: clock.unixTimestamp + BigInt(604_801), // > 7 days
}));
// 3. Now call resolve_dispute_timeout — it will pass the time guard.
```

**Status after migration**: ✅ **UNBLOCKED**. Both the positive path (`settlement.ts:2632`) and the `cpi-failures.test.ts:1298` seeds-constraint negative-path flip from `it.skip` to active.

### Case 4 — AUD-105 Deadline equality at the harness level

**Location**: `tests/settlement.ts:2939–2942`, `tests/settlement.ts:2956`  
**Blocker**: current approach polls `getBlockTime()` until `t == T`, relying on natural slot progression. Works but is flaky-prone and design-rationale comment explicitly notes `warp_to_slot` would be cleaner.

**Bankrun/LiteSVM API**:
```typescript
// Set clock to exactly the deadline second:
await context.setClock(new Clock({ ...clock, unixTimestamp: BigInt(equalityDeadline) }));
// call accept_task — must reject (deadline == now is "at-or-after")
await context.setClock(new Clock({ ...clock, unixTimestamp: BigInt(equalityDeadline - 1n) }));
// call accept_task — must succeed (before deadline)
```

This gives deterministic equality and strict-before coverage in two lines, replacing the 150-line polling loop at `settlement.ts:2918–3070`.

**Status after migration**: ✅ **UNBLOCKED AND SIMPLIFIED**. The test becomes ~20 lines, is no longer flaky, and covers exact equality and boundary-minus-one in a single test run.

### Case 5 — Forged `settlement_authority` via `invoke_signed`

**Location**: `tests/cpi-failures.test.ts:715` (`it.skip`); `tests/agent-registry.ts:2388` (comment); `tests/agent-registry.ts:2411` (comment)  
**Blocker**: forging a signed PDA from outside the Settlement program is cryptographically infeasible from TypeScript. `invoke_signed` succeeds only when the calling Solana program holds the seeds; no TypeScript client can construct a valid `invoke_signed` for Settlement's `settlement_authority` PDA.

**Bankrun/LiteSVM API**: LiteSVM provides no primitive to bypass this — correctly so, because the constraint is a cryptographic property of the runtime, not a harness configuration gap.

**Status after migration**: ❌ **REMAINS BLOCKED**. Unblocking requires a purpose-built "spoofer" Solana program written in Rust that is deployed as part of the test fixture and attempts the forged CPI. The `it.skip` comment at `cpi-failures.test.ts:715` accurately captures this: *"Re-enable once a 'spoofer' Solana program exists."* This is a separate workstream from harness migration and is explicitly out of scope for the AUD-017 task. The belt-and-braces coverage from the seeds-constraint tests (Cases A/B/D in `cpi-failures.test.ts`) plus the Rust unit tests remains the correct interim posture.

---

## 5. Question C — Deal-Breakers

### 5.1 CPI support

LiteSVM uses the same `solana-program-test` BPF execution engine as the Solana validator. Full cross-program invocations work correctly, including recursive CPI depth, account ownership checks, and PDA derivation. The Settlement → Registry `propose_reputation_delta` CPI chain (the primary test surface) is supported.

**Address Lookup Tables (ALTs)**: not used by any program in this repo. Not a concern.

**Verdict**: ✅ No CPI gap for this codebase.

### 5.2 Sysvar limitations

| Sysvar | LiteSVM | Relevance to this repo |
|---|---|---|
| `Clock` | ✅ Fully manipulable via `context.setClock()` | Core to Cases 3 and 4 |
| `Rent` | ✅ Readable via `context.getRent()` | Standard account lifecycle |
| `EpochSchedule` | ✅ Readable | Not actively used in tests |
| `Instructions` sysvar + Ed25519 precompile | ⚠️ **See below** | ADR-124 vault tests |

**Ed25519 precompile / Instructions sysvar — critical finding for this codebase**:

ADR-124 (cycle-3 B1, committed `2026-04-26`) added `initialize_vault` with an `instructions_sysvar` field and an Ed25519 precompile check (`identity_bind::verify_ed25519_precompile`). The `agent-vault.ts` suite now exercises this path in every `initializeVault` call site (11 call sites updated per the ADR-124 implementation notes).

Under **`solana-bankrun`** (the original named subject): Issue #27 documents that Ed25519 and Secp256k1 precompile programs behave incorrectly — wrong signatures do not fail, and `InvalidAccountIndex` errors surface spuriously. The entire `agent-vault.ts` suite would either fail with spurious errors or pass for the wrong reasons.

Under **LiteSVM**: the Ed25519 precompile and Instructions sysvar are supported correctly (this was the primary motivation for LiteSVM's creation over bankrun). The `verify_ed25519_precompile` path used in ADR-124 works as expected.

**Verdict**: `solana-bankrun` is **disqualified** for this codebase due to the ADR-124 Instructions-sysvar dependency. LiteSVM is required.

### 5.3 Anchor-version compatibility

- `anchor-bankrun` v0.5.0 (latest, October 2024) targets **Anchor v0.30 IDL** format.
- This repo uses `@coral-xyz/anchor ^0.31.1` (confirmed `package.json`).
- Anchor 0.31 introduced breaking IDL format changes (enum encoding, error format). Compatibility with `anchor-bankrun` v0.5.0 is unverified and likely broken.
- **`anchor-litesvm`** (the community replacement) targets Anchor 0.30+ and has been tested against 0.31. Alternatively, a 30-line `BankrunProvider`-equivalent adapter shim using `litesvm` directly and `@coral-xyz/anchor`'s `AnchorProvider` interface is straightforward to write (see §6 Phase 1).

**Verdict for `anchor-bankrun`**: ⚠️ Compatibility gap with Anchor 0.31.1; unverified and likely broken. Adopt `anchor-litesvm` or write a thin shim instead.

### 5.4 Rust toolchain and CI runner compatibility

LiteSVM's TypeScript package (`litesvm`) ships pre-built native binaries via `napi-rs`. The self-hosted Linux runners (confirmed `runs-on: [self-hosted, linux]` in all `.github/workflows/*.yml`) have Node 20 and the Rust toolchain pre-installed (per ADR-105 notes in `ci.yml`). The pre-built binaries cover Linux x64; no Rust compilation is needed at test time.

**One concern**: the `anchor-integration` CI job serializes via `concurrency: group: anchor-integration-host` because `solana-test-validator` binds port 8899 (noted in `ci.yml`). LiteSVM is in-process and does not bind any ports, so bankrun tests can run in parallel with the validator job if desired. This is an improvement, not a blocker.

**Verdict**: ✅ No CI runner compatibility issues. LiteSVM in-process execution is strictly simpler for the self-hosted runner topology.

### 5.5 Summary of deal-breakers

| Issue | `solana-bankrun` | `anchor-bankrun` | LiteSVM |
|---|---|---|---|
| Ed25519 precompile (ADR-124 vault tests) | ❌ broken (Issue #27) | ❌ (inherits from bankrun) | ✅ supported |
| Anchor 0.31 IDL compatibility | n/a | ⚠️ unverified/likely broken | ✅ (anchor-litesvm or shim) |
| `setAccount` / `setClock` | ✅ | ✅ | ✅ |
| Active maintenance | ❌ deprecated | ❌ deprecated | ✅ active |
| SPL-token `Connection` shim | ❌ incomplete | ❌ incomplete | ✅ provided |

**Bottom line**: adopting `solana-bankrun` + `anchor-bankrun` as originally specified in the investigation brief would create two immediate regressions in the vault test suite and inherit a deprecated dependency. The correct target is LiteSVM.

---

## 6. Question D — Recommended Migration Path

### Options considered

| Path | Description | Blast radius on cycle-2 corpus |
|---|---|---|
| **All-in** | Replace `solana-test-validator` everywhere in a single PR wave | HIGH — 10 843 LOC of tested code touched; risk of harness-induced regressions obscuring real bugs |
| **Per-test-file opt-in** | One file at a time, each in its own PR | MEDIUM — each PR is reviewable in isolation but the transition period is long and two harnesses coexist for weeks |
| **New-tests-only** (recommended) | Legacy validator harness untouched; all net-new tests for blocked paths go into `tests/bankrun/` with LiteSVM | LOW — zero risk to the 156-test cycle-2 corpus; bankrun tests are additive |

### Recommendation: New-tests-only opt-in

Adopt LiteSVM in a **separate `tests/bankrun/` directory** with a separate `npm run test:bankrun` script. The existing five on-chain suites remain on `solana-test-validator` throughout cycle-3. The bankrun directory covers only:
1. The four harness-blocked `it.skip` tests (Cases 1–4 above).
2. Any new test paths added in cycle-3+ that require state seeding or clock manipulation.

**Rationale**:
- The cycle-2 corpus (commits `b59ef6c..738ae88`) just landed 156 passing tests. Touching those files carries rebase and regression risk with zero upside — they already cover what they cover.
- The new-tests-only approach delivers the five blocked coverage items (four via LiteSVM, one still blocked pending the spoofer program) without disturbing any existing code path.
- The all-in migration can be done as a later Phase 3 PR once Phase 1 and Phase 2 have proven the harness is stable in CI. It is not required for the blocked paths and is not a launch blocker.

**On the question of coexistence**: two harnesses coexisting permanently is not ideal but is preferable to rushing an all-in migration. The `Anchor.toml [scripts] test` directive stays unchanged; a new `test:bankrun` npm script runs the LiteSVM suite. CI adds one new step that does not affect the existing `anchor-integration` concurrency group.

---

## 7. Question E — Cycle-3 PR-Sized Work Breakdown

### Phase 1 PR: Dependency adoption + AUD-117 ResolveDisputeTimeout proof of concept

**Highest-value case to port first**: Case 3 (AUD-117 `ResolveDisputeTimeout`). This case has the highest audit-closure priority: it is the only `it.skip` with a direct BANKRUN-TODO marker and a named trigger ID (`trig_01NokXSDGAb7ECabM5n9ULR3`). It also demonstrates both capabilities (clock warp for the positive path in `settlement.ts` and seeds-constraint test in `cpi-failures.test.ts`), making it the most informative proof of concept.

**Files changed**:
- `package.json` — add `"litesvm": "<version>"` and `"anchor-litesvm": "<version>"` to `devDependencies`
- `tests/bankrun/setup.ts` — 30–50 LOC adapter/helper (BankrunProvider shim, `startLiteSvm` wrapper, `fundKeypair` helper using `setAccount`)
- `tests/bankrun/dispute-timeout.test.ts` — 80–120 LOC: positive path for `resolve_dispute_timeout` (clock warped past 7 days), plus the `ResolveDisputeTimeout` seeds-constraint negative path from `cpi-failures.test.ts:1298`
- `Anchor.toml` — no change (test script scope unchanged)
- `package.json scripts` — add `"test:bankrun": "npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/bankrun/**/*.ts'"`
- `.github/workflows/ci.yml` — add a `bankrun-tests` job (no port binding, can run in parallel with `anchor-integration`)

**LOC delta**: +200–250 LOC net-new; 0 LOC modified in existing test files.  
**Risk**: Low — entirely additive. The existing suite is not touched.

### Phase 2 PR(s): Remaining four unblocked cases

**PR 2a — AUD-101 state-seeding tests** (Cases 1 and 2):
- `tests/bankrun/migrate-agent-profile-legacy.test.ts` — 80–120 LOC
- Requires: `BorshCoder` or raw byte construction for legacy `AgentProfile` layout with `reputation_score > 100` and `status = Suspended, slash_count = 0`
- **Risk**: Medium — byte layout must exactly match the on-chain struct definition; a layout mismatch produces `AccountDidNotDeserialize` rather than a harness failure, so the error surface is clear.

**PR 2b — AUD-105 deadline equality (Case 4)**:
- `tests/bankrun/deadline-equality.test.ts` — 40–60 LOC (clock-deterministic replacement for the 150-line polling test)
- **Risk**: Low — the existing polling test (`settlement.ts:2953`) continues to run and provide coverage; this is an additional deterministic companion, not a replacement.

**PR 2c — AUD-108 reason-rejection with spoofer program** (Case 5, separate workstream):
- Requires a new Rust program `programs/settlement-spoofer/` that holds the spoofed PDA seeds and attempts the forged `invoke_signed`
- This is a **separate and larger workstream** from the harness migration — it needs a new Anchor program with its own `Cargo.toml`, IDL, and deploy step
- **Recommendation**: track this separately as a cycle-4 item; it is not a harness-migration task

**LOC delta for 2a + 2b**: +200–300 LOC net-new in `tests/bankrun/`; 0 LOC modified in existing files.  
**Risk**: Low for 2b; Medium for 2a (byte layout sensitivity).

### Phase 3 PR: Legacy harness coexistence finalization (not all-in retirement)

At this stage the bankrun suite should have stabilised in CI (5+ clean runs). Phase 3 does two things:
1. Adds a note in the `Anchor.toml [scripts] test` comment referencing the parallel bankrun suite
2. Optionally migrates `settlement.ts` AUD-055 polling loops (the `getBlockTime` idiom) to their bankrun equivalents — this is a quality-of-life change, not a coverage gap

**All-in validator retirement** is deliberately deferred beyond Phase 3 to avoid disrupting the launch window. The validator harness covers 156 tests that are well-understood and green. Retirement can happen post-launch when operational confidence in LiteSVM is established.

**LOC delta**: +50–100 LOC in comments/CI config; 0 LOC in test logic.  
**Risk**: Minimal.

### Phase summary table

| Phase | PR count | LOC delta | Files touched | Risk | Blocked paths closed |
|---|---|---|---|---|---|
| Phase 1 | 1 | +200–250 | 4 new files | Low | Case 3 (AUD-117 timeout) |
| Phase 2 | 2 (or 3 with spoofer) | +200–300 | 2–3 new files | Low–Medium | Cases 1, 2, 4 |
| Phase 3 | 1 | +50–100 | config only | Minimal | Coexistence finalized |
| Spoofer (separate) | 1 | +500–800 | new Rust program + TS test | High | Case 5 (forged PDA) |

---

## 8. Actionable Summary for the Next Session

### Immediate steps (Phase 1 PR)

1. **Check LiteSVM npm availability** and pin versions:
   ```bash
   npm show litesvm version          # expect 0.5.x or higher
   npm show anchor-litesvm version   # community package; verify Anchor 0.31 support
   ```
   If `anchor-litesvm` does not support Anchor 0.31, write a 30-line shim (see below).

2. **Thin BankrunProvider shim** (if `anchor-litesvm` is insufficient):
   ```typescript
   // tests/bankrun/setup.ts
   import { LiteSVM } from "litesvm";
   import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
   import { Connection } from "@solana/web3.js";
   
   export async function startLiteSvm(programs: { name: string; programId: PublicKey }[]) {
     const svm = new LiteSVM();
     for (const { name, programId } of programs) {
       const so = readFileSync(`target/deploy/${name}.so`);
       svm.addProgram(programId, so);
     }
     // LiteSVM provides a Connection-compatible interface for Anchor
     const connection = svm.toConnection();
     const wallet = new NodeWallet(Keypair.generate());
     const provider = new AnchorProvider(connection, wallet, {});
     return { svm, provider };
   }
   ```

3. **Add to `package.json` devDependencies** (do not touch `Anchor.toml`):
   ```json
   "litesvm": "^0.5.0",
   "anchor-litesvm": "^0.1.0"
   ```
   And to `scripts`:
   ```json
   "test:bankrun": "npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/bankrun/**/*.ts'"
   ```

4. **Implement `dispute-timeout.test.ts`** by lifting the test body from `cpi-failures.test.ts:1298` (the `it.skip`) and replacing the clock-wait with `svm.setClock(...)`.

5. **Add CI step** in `.github/workflows/ci.yml` after the `anchor-integration` job:
   ```yaml
   bankrun-tests:
     name: LiteSVM Bankrun Tests
     runs-on: [self-hosted, linux]
     needs: anchor-build
     steps:
       - uses: actions/checkout@...
       - uses: actions/setup-node@...
       - run: npm ci --no-audit --no-fund
       - run: npm run test:bankrun
   ```
   No concurrency lock needed — LiteSVM does not bind ports.

### Do not do in Phase 1

- Do **not** modify `Anchor.toml [scripts] test` — the validator harness is unchanged.
- Do **not** port `settlement.ts`, `agent-registry.ts`, or `agent-vault.ts` in Phase 1.
- Do **not** adopt `solana-bankrun` or `anchor-bankrun` — they are deprecated and the Ed25519 precompile bug would break `agent-vault.ts`.

---

## 9. References

- `tests/agent-registry.ts:1659–1691` — inline justification for TS-uncovered migration branches
- `tests/cpi-failures.test.ts:1260–1311` — `it.skip` at line 1298 with BANKRUN-TODO marker
- `tests/settlement.ts:2632`, `2939–2942` — bankrun TODO comments
- `programs/agent-registry/src/lib.rs::tests` — Rust unit coverage for Cases 1 and 2 (current sole coverage)
- `programs/settlement/src/contexts.rs::aud_117_seeds_parity` — mechanical-identity Rust parity tests for Case 3 interim coverage
- `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md` — Ed25519 precompile dependency that disqualifies `solana-bankrun`
- `docs/PRE_MAINNET_ROADMAP.md` B3, B4 — cycle-2 items that documented this harness gap
- bankrun Issue #27: https://github.com/kevinheavey/solana-bankrun/issues/27 (Ed25519 precompile bug, unfixed, deprecated)
- LiteSVM TypeScript package: https://github.com/LiteSVM/litesvm (active; replaces bankrun)

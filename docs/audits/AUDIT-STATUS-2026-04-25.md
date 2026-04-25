# Audit Status — 2026-04-25

**One-page summary** of the Architecture Audit cycle started 2026-04-25. Detailed findings live in `ARCHITECTURE-AUDIT-2026-04-25.md`; ADR cross-cuts in `ADR-DRIFT-MATRIX.md`; sequencing in `REMEDIATION-PLAN.md`; locked design picks in `DESIGN-DECISIONS-2026-04-25.md`.

## Headline

- **Started**: 2026-04-25 with 4 parallel sub-audits (on-chain, off-chain TS, ADR governance, tests/CI).
- **Findings inventoried**: 75 with stable `AUD-NNN` IDs.
- **Closed in this cycle**: **25** (5 Critical / 6 High / 3 Medium / 5 Low / 1 Info / 5 Architecture).
- **All 5 Critical findings are Fixed**.
- **Branch**: `chore/architecture-audit-2026-04-25` (22 commits, never pushed).
- **Tests at HEAD**: 137 Rust unit, 110 TS Anchor integration, 180 MCP server, 19 SDK client.

## Closed findings

### Critical (5/5 — all closed)

| ID | Title | Commit |
|---|---|---|
| AUD-001 | `ProposeReputationDelta` PDA missing nonce seed | `0a02850` |
| AUD-002 | Settlement→Registry CPI uses unbounded legacy `update_reputation` | `0a02850` (legacy removed) |
| AUD-003 | SDK PDA derivation diverges from on-chain | `e262db9` |
| AUD-004 | Reputation laundering via self-Suspended + clear_suspension | `31586e9` |
| AUD-005 | `initialize_protocol_config` permissionless front-run | `5aa2f85` |

### High (6 closed)

| ID | Title | Commit |
|---|---|---|
| AUD-008 | Vault user-supplied `profile_nonce` | `a1c40da` |
| AUD-009 | `accept_task` no deadline check (grief vector) | `4fa7443` |
| AUD-011 | SDK uses `BigInt64Array` for `u64` nonce | `e262db9` |
| AUD-012 | SDK PDA tests assert shape only, not equivalence | `e262db9` |
| AUD-014 | Tool-count contradiction (23/20/24) | `22dc7a7` (+ `edf2117` site-doc follow-up) |
| AUD-016 | `ANCHOR_WALLET` env var ignored | `9213c1a` |

### Medium (3 closed)

| ID | Title | Commit |
|---|---|---|
| AUD-027 | `JWT_SECRET` length not validated | `8255d03` |
| AUD-029 | `/metrics` binds 0.0.0.0 with no auth | `440ecac` |
| AUD-031 | Redundant `createRpc()` call | `3a77002` |

### Low (5 closed; 1 reclassified)

| ID | Title | Commit |
|---|---|---|
| AUD-032 | `ReputationUpdateScheduled` event misnamed | `9213c1a` |
| AUD-039 | Indexer reconnect peeks private API | `f01d841` (heartbeat ping replaces `_rpcWebSocket`) |
| AUD-040 | Dead capability constant | **Wontfix** — verified actually used by 4 settlement actions + a test |
| (more low items pending) | | |

### Architecture / quality (added this batch)

| ID | Title | Commit |
|---|---|---|
| AUD-055 | Wall-clock setTimeout waits in tests | `0c7c794` (settlement.ts), `0c48e0e` (agent-registry.ts) |
| AUD-072 follow-up | `execute_program_call` in SECURITY_AUDIT/AUDIT_SCOPE | `9fb6278` (full subsection rewrite) |

### Architecture / governance (5 closed)

| ID | Title | Commit |
|---|---|---|
| AUD-047 | ADR-098 / ADR-099 duplicate-numbered files | `b117ffa` |
| AUD-048 | ADR-007 / ADR-014 stale-Accepted | `24bc847` |
| AUD-049 | ADR-012/033/048 web3.js v2 overlap | `1891f4a` (annotated) |
| AUD-050 | ADR-031 → ADR-080 unannotated supersession | `1891f4a` |
| AUD-065 | Two parallel reputation paths in production | `0a02850` |
| AUD-072 | SUMMARY documents `execute_program_call` (deleted) | `6941869` |

Plus closed-state-machine invariant (`assert_valid_profile()`) wired across mutation + migration paths in `dab8ec7`.

## Behavioral changes worth flagging

1. **Default reputation deltas re-tuned** for the new `|delta| ≤ 10` policy: `task_completed` 50→10, `dispute_loss` -25→-5, `expiry_undelivered` -10→-3. Governance can retune via `update_protocol_config` post-init.
2. **`clear_suspension` now terminal at the third clear** — agent moves to `Retired` (no infinite loop of halving).
3. **Vault initialization requires prior `register_agent`** — strict register-first; SDK convenience helper queued as PR-JJ.
4. **`/metrics` defaults to `127.0.0.1`** — opt-in to `0.0.0.0` via `METRICS_HOST=0.0.0.0`.
5. **`ANCHOR_WALLET` precedence**: takes priority over `SOLANA_KEYPAIR_PATH` to match Anchor convention.
6. **Schema bump** of `AgentProfile` (1414→1415 bytes for `cleared_count: u8`); migration via `migrate_agent_profile` clamps reputation_score to `[0, 100]` AND fixes Suspended-without-slash-count invariant.
7. **`verify_protocol_invariants` admin ix** added — gated to `ProtocolConfig.authority`, callable post-migration to assert the entire account population satisfies invariants.

## What remains

### High (4 open)

| ID | Title | Effort | Plan-row |
|---|---|---|---|
| AUD-006 | Vault rate-limit signed/unsigned arithmetic | 1h | PR-P |
| AUD-007 | `avg_rating` denominator unbounded; gameable | 2h | PR-Q |
| AUD-009 | `accept_task` no deadline check (grief vector) | 30m | PR-R |
| AUD-010 | `expire_escrow` skips success-path CPI | 3h | PR-S |
| AUD-013 | Three competing `Result<T>` shapes | 1d | PR-T |
| AUD-015 | No MCP tool exposes `update_agent_identity` | 4h | PR-U |
| AUD-017 | No CPI-failure integration tests | 1d | PR-K |

### Medium / Low / Architecture (open)

| ID | Title | Effort |
|---|---|---|
| AUD-018 | `raise_dispute` no grace gate (PR-V) | 2h |
| AUD-019 | Account-level status constraints (PR-?) | 2h |
| AUD-020 | `agent_identity` proof-of-control absent | 2h doc |
| AUD-021 | Empty allowlist = allow-all (PR-W) | 4h |
| AUD-022 | `released_amount` ordering-fragile | 2h |
| AUD-023 | No per-day rotation cap (PR-X) | 2h |
| AUD-024 | No upper bound on escrow deadline (PR-Y) | 1h |
| AUD-025 | SDK fetch helpers `(program.account as any)` | 1d |
| AUD-026 | Two parallel input-validation regimes | 4h |
| AUD-028 | x402 in-memory replay protection (no Redis) | 1d |
| AUD-030 | `initTracing` uses `require()` under ESM | 1h |
| AUD-033..AUD-046 | various Low items | each <2h |
| AUD-051..AUD-064 | Architecture / test-CI gaps | varies |
| AUD-066..AUD-074 | Architecture (most deferred) | varies |

### Doc + CI follow-ups

| PR | Closes | Effort |
|---|---|---|
| PR-DD | Stale "20 tools" + execute_program_call in `docs/index.md`, `api-reference.md`, `getting-started.md`, `integration-guide.md`, `SECURITY_AUDIT.md`, `AUDIT_SCOPE.md` | 30 min |
| PR-K | AUD-017 CPI-failure integration tests | 1d |
| PR-L | AUD-055 replace wall-clock waits in tests | 3h |
| PR-M | AUD-059 mainnet-readiness CI gate (parses `MAINNET_CHECKLIST.md`) | 1d |
| PR-N | AUD-061 + ADR-115 — flip CI security gates to blocking | 2d |
| PR-O | AUD-037, 074, 077 — finish web3.js v2 migration | 2w |
| PR-CC | AUD-053 — extend `status-audit.sh` into a real ADR-lint | 2d |

## What does NOT get fixed in this cycle (Wontfix or deferred)

- **AUD-040** — capability constant is actually used; audit error.
- **AUD-046** — `migrate_agent_profile` zero-pad-only; design constraint per ADR-096.
- **AUD-067** — no `close_vault` instruction; documented limitation.
- **AUD-070** — `settlement_authority` bump unstored; cosmetic CU saving.
- **AUD-071** — no keeper fee on permissionless cron ops; needs separate economic-primitive design.

## Tracking conventions

- Findings closed in this cycle have `[Phase 3 closures]` or `[initial batch]` annotation in the master doc.
- New findings discovered post-this-audit get a date prefix: `AUD-2026-MM-DD-NNN`.
- The audit cycle "closes" when all Critical + High findings are Fixed or have explicit Wontfix decisions, the drift matrix's Categories 1/2/3 are empty, and a successor audit can be opened with a clean baseline.

**Current closure-readiness**: 5/5 Critical Fixed, 5/12 High Fixed. The remaining 7 High are all engineering-only (no design block) and can be batched.

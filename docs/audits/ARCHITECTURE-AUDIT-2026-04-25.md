# Architecture Audit — 2026-04-25

## Metadata

- **Date**: 2026-04-25
- **Branch**: `chore/architecture-audit-2026-04-25`
- **Status**: Open (Phase 1 of 4 complete)
- **Source reports**: 4 parallel sub-audits commissioned 2026-04-25
  - On-chain Anchor programs (security-auditor)
  - Off-chain TypeScript surface (code-analyzer)
  - ADR governance & consistency (researcher) — superseded by Phase 2 full inventory
  - Tests + CI/CD (tester)
- **Phase 2 output** (in progress): `ADR-INVENTORY.md`, `ADR-DRIFT-MATRIX.md`
- **Phase 3 output** (pending): `REMEDIATION-PLAN.md`
- **Appendices**: `appendix-onchain-security.md`, `appendix-offchain-typescript.md`, `appendix-adr-governance.md`, `appendix-tests-ci.md`

## Severity legend

| Code | Meaning |
|---|---|
| **C** | Critical — mainnet ship-blocker; users / funds / governance at risk |
| **H** | High — security or correctness gap with realistic exploit path |
| **M** | Medium — defense-in-depth or DX; low likelihood, real impact |
| **L** | Low — cosmetic / cleanup / minor drift |
| **A** | Architecture — design-level critique, not a bug |

## ID convention

Findings use `AUD-NNN` (this audit batch). Future audits prefix with date: `AUD-2026-MM-DD-NNN`.

## Closed in this audit cycle (2026-04-25)

| ID | Sev | Title | PR | Commit |
|---|---|---|---|---|
| **AUD-003** | C | SDK PDA derivation diverges from on-chain (vault seed order, escrow seed string) | PR-C | `e262db9` |
| **AUD-011** | H | SDK uses `BigInt64Array` for `u64` nonce | PR-C | `e262db9` |
| **AUD-012** | H | SDK PDA tests assert shape only, not equivalence | PR-C | `e262db9` (added 8 golden-vector tests) |
| **AUD-014** | H | Tool-count contradiction (23/20/24) | PR-E | `22dc7a7` |
| **AUD-016** | H | `ANCHOR_WALLET` env var ignored | PR-D | `9213c1a` |
| **AUD-027** | M | `JWT_SECRET` length not validated | PR-F | `8255d03` |
| **AUD-029** | M | `/metrics` binds `0.0.0.0` with no auth | PR-F | `440ecac` |
| **AUD-031** | M | Redundant `createRpc()` in `main()` | PR-F | `3a77002` |
| **AUD-032** | L | `ReputationUpdateScheduled` event misnamed | PR-D | `9213c1a` |
| **AUD-040** | L | Dead capability constant | **Wontfix** | Audit error — constant is used by 4 settlement actions (`submit_milestone`, `approve_milestone`, `dispute_milestone`, `resolve_dispute`) and `test/action-shape.test.ts:128`. Verified by PR-F coder agent. |
| **AUD-047** | I | ADR-098 + ADR-099 duplicate-numbered files | PR-B | `b117ffa` |
| **AUD-048** | A | ADR-007 + ADR-014 stale-Accepted (CPI helper migration) | PR-B | `24bc847` |
| **AUD-049** | A | ADR-012/033/048 web3.js v2 overlap | PR-B (partial — annotated; ADR-087 marked canonical via Revisions log) | `1891f4a` |
| **AUD-050** | A | ADR-031 → ADR-080 unannotated supersession | PR-B | `1891f4a` |
| **AUD-072** | A | SUMMARY documents `execute_program_call` (deleted by ADR-050) | PR-E | `6941869` |

**15 findings closed initially.** Phase 3 (the design-locked critical/high batch) closes the remaining critical findings.

## Phase 3 closures (2026-04-25, after design review)

| ID | Sev | Title | PR | Commit |
|---|---|---|---|---|
| **AUD-001** | C | `ProposeReputationDelta` PDA missing `owner_nonce` seed | PR-G | `0a02850` |
| **AUD-002** | C | Settlement→Registry CPI uses unbounded legacy `update_reputation` | PR-G | `0a02850` (legacy path removed) |
| **AUD-004** | C | Reputation laundering via self-Suspended + clear_suspension | PR-I | `31586e9` (cumulative slash_count + cleared_count escalation) |
| **AUD-005** | C | `initialize_protocol_config` permissionless | PR-H | `5aa2f85` (gated to upgrade authority via `BpfLoaderUpgradeable::ProgramData`) |
| **AUD-008** | H | Vault user-supplied `profile_nonce` | PR-J | `a1c40da` (OwnerNonce account from Registry) |
| **AUD-065** | A | Two parallel reputation paths in production | PR-G | `0a02850` (legacy `update_reputation` removed; single canonical path) |

Plus: closed-state-machine invariant `assert_valid_profile()` enforced post-mutation in every reputation/status writer AND post-migration in `migrate_agent_profile`. Activated in `dab8ec7` after PR-I + PR-G both landed.

**21 findings closed total.** 4 of 5 Critical findings now Fixed (the remaining "C" ID, AUD-003, was closed in the initial batch). All 4 design-blocked criticals + the load-bearing High (AUD-008) merged.

**Behavior changes worth noting**:
- Default reputation deltas adjusted to fit the new `|delta| <= 10` policy: `task_completed` 50 → 10, `dispute_loss` -25 → -5, `expiry_undelivered` -10 → -3 (governance-tunable post-init via `update_protocol_config`).
- `clear_suspension` is now terminal at the third clear (status → Retired), not just costly — agent no longer loops indefinitely.
- Vault initialization now requires prior agent registration (no more "vault before profile").

**Follow-up surfaced by PR-E** (not yet closed): stale "20 tools" mentions in `docs/index.md`, `docs/api-reference.md`, `docs/getting-started.md`, `docs/integration-guide.md`. `docs/SECURITY_AUDIT.md` and `docs/AUDIT_SCOPE.md` still describe `execute_program_call` as live security surface — real correctness drift, queue as PR-DD.

## Cross-cutting themes

1. **Reputation policy is split across two on-chain paths.** The bounded ADR-094 path is wired to no caller; the unbounded legacy path is what Settlement actually invokes. (AUD-001, AUD-002, AUD-068)
2. **SDK ↔ on-chain divergence has no source-of-truth.** `@agenomics/client` derives PDAs independently of `@agenomics/idl` and the MCP server, with predictable consequences. (AUD-003, AUD-011, AUD-012, AUD-076)
3. **Solana web3.js v2 migration is ~4% delivered** despite three ADRs (012, 033, 048) declaring it the path forward. (AUD-037, AUD-077)
4. **Mainnet readiness is documented, not enforced.** `scripts/mainnet-deploy.sh --self-test`, the `MAINNET_CHECKLIST.md`, ADR-080 mandates — none gate a release. (AUD-060, AUD-051)
5. **ADR drift is real and silent.** ADR-007 + ADR-014 describe a CPI pattern that no longer exists; ADR-098 + ADR-099 each have two duplicate files. (AUD-049, AUD-048)
6. **Tests count high but kind narrow.** Negative-path coverage on CPI failure, suspension coupling, close_escrow, and fuzz-at-scale is missing. (AUD-057, AUD-058, AUD-059, AUD-065)

## Index — all findings

| ID | Sev | Title | Location | ADR refs | Status |
|---|---|---|---|---|---|
| **AUD-001** | C | `ProposeReputationDelta` PDA missing `owner_nonce` seed | `programs/agent-registry/src/contexts.rs:307-313` | ADR-094, ADR-097, **ADR-116** | Open |
| **AUD-002** | C | Settlement→Registry CPI uses unbounded legacy `update_reputation` | `programs/settlement/src/instructions/cpi.rs:65-80` | ADR-094 | Open |
| **AUD-003** | C | SDK PDA derivation diverges from on-chain (vault seed order, escrow seed string) | `sdk/client/src/vault.ts:54-58`, `sdk/client/src/settlement.ts:22,66` | ADR-098, **ADR-119** | In-progress (parallel coder) |
| **AUD-004** | C | Reputation-laundering loop via self-`Suspended` + `clear_suspension` | `programs/agent-registry/src/lib.rs:137-151` + `:349-368` | ADR-070 | Open |
| **AUD-005** | C | `initialize_protocol_config` is permissionless (front-runnable governance) | `programs/settlement/src/instructions/protocol_config.rs:16-36`, `contexts.rs:491-505` | ADR-031, ADR-080 | Open |
| **AUD-006** | H | Vault rate-limit window arithmetic mixes signed/unsigned | `programs/agent-vault/src/instructions.rs:280-294`, `:455-468` | none | Open |
| **AUD-007** | H | `avg_rating` denominator unbounded; gameable by ordering | `programs/agent-registry/src/lib.rs:177-188` | ADR-005, **ADR-121** | Fixed in `8fb8511` (ADR-121) |
| **AUD-008** | H | Vault user-supplied `profile_nonce` can permanently brick vault | `programs/agent-vault/src/contexts.rs:141-150`, `:191-200` | ADR-093, ADR-097 | Open |
| **AUD-009** | H | `accept_task` has no deadline check; provider can grief | `programs/settlement/src/instructions/escrow.rs:114-128` | none | Open |
| **AUD-010** | H | `expire_escrow` skips success-path reputation CPI for already-Submitted milestones | `programs/settlement/src/instructions/escrow.rs:172-294`, `:495-508` | ADR-025 | Open |
| **AUD-011** | H | SDK uses `BigInt64Array` for `u64` nonce; silent divergence above `2^63` | `sdk/client/src/registry.ts:65`, `sdk/client/src/index.ts:116` | ADR-119 | In-progress (parallel coder) |
| **AUD-012** | H | SDK PDA tests assert shape only, not on-chain equivalence | `sdk/client/test/index.test.ts:76-108` | ADR-119 | In-progress (parallel coder) |
| **AUD-013** | H | Three competing `Result<T>` shapes in repo; ADR-103 not delivered | `mcp-server/src/types/action.ts`, `sdk/action-runtime/src/index.ts`, `packages/sas-resolver/src/util/result.ts` | ADR-103 | Open |
| **AUD-014** | H | Tool-count contradiction: README=23, SUMMARY=20, code=24 | `README.md:10,54`, `SUMMARY.md:20,134,291`, `mcp-server/src/tools/index.ts:74` | ADR-027, ADR-046 | Open |
| **AUD-015** | H | No MCP tool exposes `update_agent_identity` (ADR-069 inert) | `mcp-server/src/actions/*` (gap) | **ADR-069** | Open |
| **AUD-016** | H | `ANCHOR_WALLET` env var silently ignored by mcp-server | `mcp-server/src/solana.ts:155-177` | none | In-progress (parallel coder) |
| **AUD-017** | H | No CPI-failure integration tests (settlement→registry, vault→registry) | `tests/*.ts` (gap) | ADR-001, ADR-007, ADR-014, ADR-095 | Open |
| **AUD-018** | M | `raise_dispute` has no grace gate; sidesteps ADR-102 grace window | `programs/settlement/src/instructions/dispute.rs:10-25` | ADR-102 | Open |
| **AUD-019** | M | `AcceptTask` / `SubmitMilestone` / `RejectMilestone` lack status constraint at Account level | `programs/settlement/src/contexts.rs:91-93` and peers | ADR-002 | Open |
| **AUD-020** | M | `agent_identity` set without proof-of-control; threat unwarned | `programs/agent-vault/src/instructions.rs:228-344` | ADR-069 | Open |
| **AUD-021** | M | Empty allowlist = allow-all (opt-out security); ADR-073 deferred | `programs/agent-vault/src/state.rs:115-129`, `instructions.rs:404-408` | **ADR-073** | Open |
| **AUD-022** | M | `released_amount` accounting is correct but ordering-fragile | `programs/settlement/src/instructions/escrow.rs:495-502` | ADR-025 | Open |
| **AUD-023** | M | `update_agent_identity` has no per-day rotation cap | `programs/agent-vault/src/instructions.rs:478-493` | ADR-069 | Open |
| **AUD-024** | M | No upper bound on escrow `deadline` | `programs/settlement/src/instructions/escrow.rs:60-61` | none | Open |
| **AUD-025** | M | SDK fetch helpers use `(program.account as any)` everywhere; ADR-088 not delivered for SDK | `sdk/client/src/{vault,registry,settlement}.ts` | ADR-088 | Open |
| **AUD-026** | M | Two parallel input-validation regimes (legacy `requireString` + Zod) coexist | `mcp-server/src/handlers/validation.ts` vs `mcp-server/src/adapters/mcp.ts:55-67` | ADR-058 | Open |
| **AUD-027** | M | `JWT_SECRET` length not validated (no entropy floor) | `src/x402-relay/index.ts:9-22` | ADR-117 | Open |
| **AUD-028** | M | x402 in-memory replay-protection breaks under horizontal scaling | `src/x402-relay/index.ts:298-309` | ADR-017 | Open |
| **AUD-029** | M | `/metrics` binds `0.0.0.0` with no auth — operational signal leak | `mcp-server/src/observability.ts:55-73` | ADR-104, ADR-083 | Open |
| **AUD-030** | M | `initTracing` uses `require()` under ESM; brittle under stricter loaders | `mcp-server/src/observability.ts:88-117` | ADR-091, ADR-104 | Open |
| **AUD-031** | M | `createRpc()` invoked twice in `main()`; dead-redundant | `mcp-server/src/index.ts:153-159, 165` | none | Open |
| **AUD-032** | L | Event `ReputationUpdateScheduled` misnamed (synchronous CPI) | `programs/settlement/src/instructions/cpi.rs:82-86` | ADR-082 | In-progress (parallel coder) |
| **AUD-033** | L | Reputation `score / 2` rounds down (cosmetic) | `programs/agent-registry/src/lib.rs:357` | none | Open |
| **AUD-034** | L | Token allowlist two-tier check is confusing | `programs/agent-vault/src/instructions.rs:375-378, 420` | ADR-073 | Open |
| **AUD-035** | L | Escrow `space` formula uses user-driven `milestones_data.len()` (handler reverts later) | `programs/settlement/src/contexts.rs:62-69` | ADR-040 | Open |
| **AUD-036** | L | `init_if_needed` on `OwnerNonce` carries reinit-attack surface | `programs/agent-registry/src/contexts.rs:21-28` | ADR-097 | Open |
| **AUD-037** | L | Only 1 of 24 mcp-server handlers migrated to v2; ADR-048 overpromises | `mcp-server/src/handlers-v2/vault.ts` (only) vs `mcp-server/src/handlers/*` | ADR-012, ADR-033, ADR-048, ADR-087 | Open |
| **AUD-038** | L | Indexer decodes `i16` reputation delta as unsigned `u16` | `src/indexer/index.ts:459` | ADR-016, ADR-082 | Open |
| **AUD-039** | L | Indexer reconnect peeks at private web3.js field `_rpcWebSocket` | `src/indexer/index.ts:1132` | ADR-016, ADR-118 | Open |
| **AUD-040** | L | Dead capability constant `sign:cross_program:settlement+registry` | `mcp-server/src/index.ts:74` | none | Open |
| **AUD-041** | L | Files in repo root violate CLAUDE.md no-root rule (`agentdb.rvf`, `ruvector.db`, `.swarm/state.json`) | repo root | none | Open |
| **AUD-042** | L | `src/indexer` pinned to `@coral-xyz/anchor:^0.30.0`; workspace policy is `0.31.1` | `src/indexer/package.json:11` | ADR-013 | Open |
| **AUD-043** | L | Nested `node_modules/` in `src/x402-relay` and `src/indexer` (workspace hoist failed) | `src/{x402-relay,indexer}/` | ADR-089 | Open |
| **AUD-044** | L | Manifest precompile lookup limited to current ± 1 instruction | `programs/agent-registry/src/lib.rs:457-462` | ADR-092 | Open |
| **AUD-045** | I | `expire_escrow` permissionless = griefable (accepted Solana economic model) | `programs/settlement/src/instructions/escrow.rs:380-385` | none | Documented |
| **AUD-046** | I | `migrate_agent_profile` zeros only new bytes, not repurposed ones | `programs/agent-registry/src/lib.rs:496-513` | ADR-096 | Documented |
| **AUD-047** | I | ADR collection has duplicate-numbered files | `docs/adr/ADR-098-*.md`, `docs/adr/ADR-099-*.md` | (governance) | Open |
| **AUD-048** | A | ADR-007 + ADR-014 describe a CPI discriminator pattern that the code no longer uses | `programs/settlement/src/lib.rs:270-282` | **ADR-007**, **ADR-014** | Open |
| **AUD-049** | A | ADR-012 + ADR-033 + ADR-048 are three near-duplicate web3.js v2 ADRs without canonical | `docs/adr/ADR-{012,033,048,087}-*.md` | ADR-012, ADR-033, ADR-048, ADR-087 | Open |
| **AUD-050** | A | ADR-031 → ADR-080 is a de-facto supersession with no annotation | `docs/adr/ADR-031-mainnet-deployment.md`, `ADR-080-mainnet-deploy-safety-mandates.md` | ADR-031, ADR-080 | Open |
| **AUD-051** | A | 32 of 121 ADRs (26%) lack the optional-but-load-bearing `Alternatives` section | `docs/adr/*.md` | ADR-TEMPLATE | Open |
| **AUD-052** | A | 7 mega-ADRs bundle 6–9 sub-decisions each, violating the template | `docs/adr/ADR-{050,058,061,063,064,065,080}-*.md` | ADR-TEMPLATE | Open |
| **AUD-053** | A | `scripts/status-audit.sh` is a stats-printer, not a CI lint | `scripts/status-audit.sh` | (governance) | Open |
| **AUD-054** | A | No `docs/adr/README.md` index across 121 files | `docs/adr/` | (governance) | Open |
| **AUD-055** | A | Wall-clock waits in tests (1s + 6s `setTimeout`) are flake landmines | `tests/settlement.ts:1673`, `tests/agent-registry.ts:344` | ADR-009 | Open |
| **AUD-056** | A | Proptest blocks counted as one `#[test]` — 113 actual cases, README says 48 | `programs/*/src/lib.rs` (proptest blocks) | ADR-021 | Open |
| **AUD-057** | A | `scripts/load-test-discovery.ts` invoked by no CI workflow (ADR-022 deliverable inert) | `scripts/load-test-discovery.ts`, `.github/workflows/` | **ADR-022** | Open |
| **AUD-058** | A | Fuzz CI runs 256 cases per property; no nightly with `PROPTEST_CASES=10000` | `.github/workflows/ci.yml` | **ADR-021** | Open |
| **AUD-059** | A | No `v*-mainnet`-tagged readiness gate; `--self-test` runs in `shellcheck.yml:67` but no workflow parses `MAINNET_CHECKLIST.md` Pending rows or asserts signed-tag on publish | `.github/workflows/`, `scripts/mainnet-deploy.sh` | ADR-031, ADR-080 | Open (corrected by Phase 2) |
| **AUD-060** | A | Self-hosted runner is single-point; recurring action-download flakes | `.github/workflows/ci.yml`, runner config | **ADR-105** | Open |
| **AUD-061** | A | `cargo clippy` / `cargo audit` / `npm audit` are advisory-only (`continue-on-error: true`) | `.github/workflows/ci.yml` | **ADR-115** | Open |
| **AUD-062** | A | `@coral-xyz/anchor` pinned `^0.31.1` (caret) in workspace `package.json` | `package.json` | ADR-013, ADR-089 | Open |
| **AUD-063** | A | No `close_escrow` test — rent-recovery path is dead-coverage | `tests/settlement.ts` (gap) | ADR-009 | Open |
| **AUD-064** | A | `programs/agent-vault/src/instructions.rs` has zero `#[test]`s | `programs/agent-vault/src/instructions.rs` | ADR-008 | Open |
| **AUD-065** | A | Two parallel reputation paths in production (legacy + ADR-094) | `programs/agent-registry/src/lib.rs` | ADR-094 | Open |
| **AUD-066** | A | Anchor `has_one` cannot OR-match `Option<Pubkey>`; ad-hoc constraint logic in dispute paths | `programs/settlement/src/contexts.rs:219-253` | ADR-073 | Open |
| **AUD-067** | A | No `close_vault` instruction; bricked vaults are permanent | `programs/agent-vault/src/lib.rs` (gap) | ADR-029 | Open |
| **AUD-068** | A | `ProtocolConfig.authority` rotation is single-key, no two-step / timelock / renounce | `programs/settlement/src/instructions/protocol_config.rs` | ADR-031, ADR-078, ADR-084 | Open |
| **AUD-069** | A | Reputation type-system smell: `i64` delta + `u64` score + `u8` cap | `programs/agent-registry/src/{lib.rs,state.rs}` | ADR-094, ADR-096 | Open |
| **AUD-070** | A | `settlement_authority` PDA bump re-derived per CPI; not stored | `programs/settlement/src/instructions/cpi.rs` | ADR-074 | Open |
| **AUD-071** | A | `expire_escrow` + `resolve_dispute_timeout` permissionless cron with no keeper fee | `programs/settlement/src/instructions/escrow.rs:380-385`, `dispute.rs` | ADR-030 | Open |
| **AUD-072** | A | `SUMMARY.md` claims `execute_program_call` exists; ADR-050 removed it | `SUMMARY.md` | ADR-050 | Open |
| **AUD-073** | A | SDK and MCP each derive PDAs independently; no shared seed table in `@agenomics/idl` | `sdk/client/src/*.ts`, `mcp-server/src/solana.ts` | ADR-098, ADR-099, ADR-119 | Open |
| **AUD-074** | A | Confirmation pipeline (preflight, idempotency, blockhash-expiry retry) used by 1 of 24 handlers | `mcp-server/src/pipeline/`, `mcp-server/src/handlers-v2/` | ADR-059 | Open |

## Phase 2 additions (ADR drift)

The full ADR inventory in `ADR-INVENTORY.md` and cross-cuts in `ADR-DRIFT-MATRIX.md` surfaced additional governance-layer items that did not appear in the Phase 1 master index. Rather than expanding this index further, Phase 2 issues are tracked in the drift matrix. Material new findings:

- **Path-drift epidemic** — ADRs 040/041/043/044/047 cite `programs/aep/src/...` (a single-program layout that doesn't exist). Drafting template never re-pointed after the multi-program split. (Drift matrix §5)
- **ADR-073 / ADR-075 status lies** — header says Proposed; code shipped. (Drift matrix §3)
- **ADR-088 SDK drift** — typed clients done in mcp-server, NOT in `sdk/client/*.ts`. (Drift matrix §2 / AUD-025)
- **Date 2026-04-15 across ADR-001..ADR-030** — backfill smell; cannot be 30 distinct decision dates. (Drift matrix §9)
- **All four ADR-098/099 duplicates were "Accepted 2026-04-23"** — neither PR author noticed during review. (Drift matrix §1)

## Coverage gaps — ADRs that should exist

Identified by Phase 1 audits; to be reconciled against Phase 2 inventory:

- **Feature-flag / kill-switch policy** (instructions, not credentials)
- **Observability SLO/SLI definitions** (ADR-104 covers plumbing only)
- **Incident response / on-call runbook**
- **Rollback policy** (when do we forward-fix vs revert?)
- **Indexer / x402 data retention + privacy posture**
- **Economic-parameter ownership** (who can change `reputation_delta_*`, escrow minimums, etc.)
- **API versioning / deprecation policy** for SDK packages and MCP tools
- **`MAINNET_CHECKLIST.md` promoted to ADR** (currently a doc, not a decision)

## Status tracking conventions

- **Open** — unfixed; needs PR
- **In-progress** — agent or PR in flight
- **Fixed** — code merged; cite PR # + commit hash
- **Documented** — accepted as-is; trade-off recorded
- **Wontfix** — explicit decision not to remediate; cite ADR

When marking a finding Fixed, append a sub-entry:
```
**AUD-NNN** — Fixed in PR #XX (commit abc1234), 2026-MM-DD. Notes: …
```

## How to use this doc

1. **Reference findings by stable ID** in commits, PRs, and new ADRs (`Fixes AUD-001`, `Refs AUD-003`).
2. **Phase 2** will cross-link each AUD entry to ADRs that govern it (column "ADR refs" expands as inventory completes).
3. **Phase 3** (`REMEDIATION-PLAN.md`) groups findings into PR-shaped batches with sequencing constraints.
4. **Future audits** create a new file `ARCHITECTURE-AUDIT-YYYY-MM-DD.md`; do not edit this one in-place after Phase 4 closes (per ADR-TEMPLATE.md immutability principle).

## Source audits (verbatim)

The four sub-audit reports are preserved in this directory as appendices:

- `appendix-onchain-security.md`
- `appendix-offchain-typescript.md`
- `appendix-adr-governance.md`
- `appendix-tests-ci.md`

Each finding above traces back to a specific section of one or more appendices.

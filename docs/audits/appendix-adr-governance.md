# Appendix — ADR Governance & Consistency (Phase 1, 2026-04-25)

**Source**: `researcher` sub-agent run, 2026-04-25 — *superseded by Phase 2 full inventory once available.*
**Scope**: 126 files in `docs/adr/`, sampled across foundational + recent
**Method**: read ADR-TEMPLATE, the most recent ten (ADR-110+), structurally important ADRs (037, 045, 050, 054, 055, 056, 080), and 5–6 foundational ones (001, 007, 014, 017, 020, 028); ran filename consistency checks
**Master IDs**: AUD-047..AUD-054

## Executive summary

This is a **load-bearing ADR collection, not theatre** — but it's mid-transition between two operating models and currently shows the seams. The signal-to-noise ratio is high in the security and on-chain decision band (ADR-001/007/014/050/068/074/075/078/080), where ADRs trace cleanly to specific files and CPI patterns. The rituals around supersession (ADR-054), numbering gaps (ADR-045), and "not written" stubs (ADR-055/056) are unusually disciplined — most projects don't bother. The recent canonicalization migration (commit `871bb88`) and `STATUS-AUDIT-2026-04-23` show active hygiene investment.

The weak spots: (1) two duplicate-numbered files exist (098, 099); (2) ADRs 106–113 are research-paper-driven proposals with no implementation hooks and no rejection criterion; (3) major operational decisions (deploy, key custody, observability SLOs, rollback) are scattered or missing; (4) `status-audit.sh` audits **only frontmatter shape and git stats** — not ADR-vs-code drift, dead links, or supersession-chain integrity.

**Verdict**: good bones, four concrete fixes from being genuinely useful governance infrastructure rather than a corpus future-you will skim and trust by default.

## Inventory snapshot (Phase 1 sample)

- 121 numbered ADR files (ADR-001..ADR-120) + 5 top-level docs (template, status-audit template, three audit reports). No `README.md` / index.
- ADR-057 is the only true numbering gap (per ADR-045, intentional).
- **Duplicates**: `ADR-098-client-sdk.md` + `ADR-098-sdk-client-package.md`; `ADR-099-idl-package.md` + `ADR-099-sdk-idl-package.md`. Both pairs "Accepted 2026-04-23" — collision from parallel branches.
- Status distribution: ~90 Accepted, 23 Proposed, 3 Reserved, 3 Not Written, 1 Superseded. Heavy proposed bulge in 106–120.
- 32/121 ADRs (26%) have no `## Alternatives` section.
- 15 ADRs cite a `PR #N` for traceability; 19 cite `programs/...rs:LINE`; 43 use older `## Files Changed` convention. Over half the corpus has neither.

## Coverage gaps (concrete missing ADRs)

| Missing ADR | Why it should exist |
|---|---|
| **Feature-flag / kill-switch policy** | Only 2 ADRs mention "feature flag" (106, 109). For pre-mainnet protocol with progressive-decentralization aspirations, no decision on how new instructions are gated, dark-launched, or rolled back. |
| **Observability SLOs / SLIs** | ADR-104 defines plumbing; zero ADRs mention "SLO" or "SLI". Latency/error-rate targets for indexer = undefined. |
| **Incident response / on-call runbook** | "Incident response" mentioned 10x in passing; no ADR defines paging, escalation, postmortems. ADR-079 covers signer custody only. |
| **Rollback / migration policy** | "Rollback" appears 5x, narrowly scoped. No general decision on forward-fix vs revert. |
| **Data retention / privacy** | Indexer is SQLite of all on-chain events plus correlation IDs (ADR-090). No retention windows, GDPR posture (relevant for x402 JWT identity), backup policy. |
| **Cost / economics model** | ADR-020 + ADR-115 define mechanisms; no ADR documents the actual values, who can change them, or invariants. ADR-053 is "params are compile-time"; not what they should be. |
| **API versioning / deprecation policy** | Multiple SDK packages (098/099/100) and an MCP server, no decision on semver discipline, breaking-change cadence, client pinning. ADR-110 introduces VCV but only at agent-manifest level. |
| **Mainnet readiness checklist as ADR** | ADR-031 + ADR-080 approximate this but don't say "the protocol does not deploy until X, Y, Z are green". The de facto checklist lives in `docs/MAINNET_CHECKLIST.md` per ADR-031, **not** an ADR — drifts silently. |

## Consistency issues

| Issue | Evidence | Severity |
|---|---|---|
| **Duplicate ADR numbers** | `ADR-098-client-sdk.md` (longer, has Out-of-Scope) and `ADR-098-sdk-client-package.md` (terse, 26 lines) both Accepted 2026-04-23 with overlapping decisions; same for ADR-099 | High |
| **Three status-formatting conventions** | `## Status\n<value>` (most), `**Status:** X` (some old), table form (rare). Canonicalization migration `871bb88` migrated 48; tail cases remain. | Med |
| **Status field carries trailing prose** | `ADR-053` Status is `Accepted (v1 compile-time decision still in force); v2 ProtocolConfig account is live per ADR-075…`. Stuffs disposition into status line. | Low |
| **Date semantics drift** | ADR-031 dated 2026-04-15 but operational hardening landed in ADR-080 (2026-04-23). 031 looks "Accepted" but is partially aspirational; 080 is the real one. No revision log on 031. | Med |
| **Supersession chain partial** | ADR-054 declares itself superseded by 025+075 — clean. ADR-031 is *de facto* superseded by ADR-080 with no forward link. ADR-053 status-line claims it'll be Superseded "on full ADR-075 enforcement maturity" — soft promise. | Med |
| **Missing Alternatives section** | 32/121 ADRs (26%), including ADR-007, ADR-029, ADR-049, ADR-050, ADR-104. | Med |
| **Aspirational-task-list shape** | ADR-050 ("Final Audit Polish") is 9 categorized fixes — release notes, not single decision. Same shape: ADR-058, 060, 061, 063, 064, 065, 080. Each contains 6–9 sub-decisions. Template says one decision per file. | Med |
| **Web3.js v2 migration triplicate** | ADR-012, ADR-033, ADR-048 cover effectively the same decision space. ADR-087 (Solana Kit dual-stack adapter) supersedes the lot; 012/033/048 not marked Superseded. | High |

## ADR-vs-code drift (spot checks, all Accepted)

| ADR | Claim | Code | Verdict |
|---|---|---|---|
| ADR-001 | Settlement signs CPI to Registry via `settlement_authority` PDA, Registry verifies with `seeds::program = SETTLEMENT_PROGRAM_ID` | `programs/agent-registry/src/contexts.rs:160,164,295,320,324` — confirmed | Implemented |
| **ADR-007** | Manual discriminator `[194, 220, 43, ...]` retained, will fail loudly | `programs/settlement/src/lib.rs:270-282` comment says "calls `agent_registry::cpi::update_reputation(...)`" — manual-discriminator pattern was **replaced** with Anchor CPI crate. ADR-007 status still Accepted. **ADR is stale.** | **Drift** |
| **ADR-014** | Test asserts `sha256("global:update_reputation")[..8]` matches the hardcoded array | `test_cpi_update_reputation_symbol_exists` exists at `programs/settlement/src/lib.rs:281` but tests *symbol presence*, not the discriminator hash — because per ADR-007's actual evolution, there's no hardcoded discriminator anymore. | **Drift (transitive)** |
| ADR-050 (M2) | `VaultAction` enum removed | `programs/agent-vault/src/lib.rs:392`: `// ADR-050: VaultAction test removed — enum was orphaned dead code` | Implemented |
| ADR-050 (L1) | `execute_program_call` removed | `programs/agent-vault/src/lib.rs:126`: `// ADR-050: execute_program_call removed` | Implemented |
| ADR-080 | Pre-flight gates, `--self-test`, `AUDIT_REPORT_HASHES`, signed-tag enforcement | `scripts/mainnet-deploy.sh` lines 6, 57, 274, 361-385; `config/AUDIT_REPORT_HASHES` template exists; `.github/workflows/shellcheck.yml` exists | Implemented |
| ADR-104 | Prometheus + OTel wired | Not verified inline — needs `prom-client` import in indexer/mcp-server | Unverified |

**Key finding**: ADR-007 + ADR-014 drift is the canonical anti-pattern — the codebase advanced past the ADR and the ADR was never amended or superseded. Exactly the failure mode the template warns against.

## `status-audit.sh` evaluation

The script is well-written shell but **narrow lint + git stats**:

- ✅ Counts ADRs by parsed Status (handles 3 frontmatter forms — that's why the canonicalization migration mattered).
- ✅ Reports git HEAD/branch/ahead/behind, today's landings, working-tree dirtiness, untracked count.
- ✅ Lists Cargo crates under `programs/`.
- ❌ Does **not** check supersession-chain integrity.
- ❌ Does **not** verify ADR-cited file paths exist.
- ❌ Does **not** detect duplicate ADR numbers.
- ❌ Does **not** spot ADR-vs-code drift.
- ❌ Sections 4–10 are agent-filled placeholders.

It's a "fancy `cat` with statistics," not a CI-runnable governance gate.

## Recommendations (ranked by leverage)

1. **Deduplicate ADR-098 and ADR-099 immediately.** Pick one of each pair, mark the other `Superseded by ADR-09X`. 15-minute fix; resolves the most flagrant template violation.
2. **Mark ADR-007 and ADR-014 as Superseded or write a successor ADR.** The Anchor CPI crate switch is a real architectural shift. Either retroactively supersede or write ADR-12X documenting.
3. **Convert `status-audit.sh` into a CI lint that actually audits.** Add: duplicate-number detection; supersession-link bidirectional check; dead-link detection for `programs/...rs:LINE` and `ADR-NNN` references; flag any ADR whose code-cited files no longer contain the cited symbol.
4. **Write a `docs/adr/README.md` index.** 121 files with no index is unnavigable. Group by domain.
5. **Triage ADR-106..113 (research-driven proposals).** State explicitly: when does each get accepted, deferred, or closed? Currently they accumulate as "Proposed" forever and dilute the signal.
6. **Promote `MAINNET_CHECKLIST.md` to an ADR.** For a pre-mainnet protocol it should be the highest-status decision, immutable, surrounded by supersession ritual.
7. **Add the eight missing-coverage ADRs from the table above.**
8. **Refactor mega-ADRs (050, 058, 061, 063, 080)** opportunistically as items are revisited.

## Phase 2 supersedes this appendix

This Phase 1 governance review covered ~30 ADRs by sample. **Phase 2 (in progress)** runs four parallel agents covering all 121 ADRs and produces:

- `docs/audits/ADR-INVENTORY.md` — one row per ADR with implementation evidence + drift verdict
- `docs/audits/ADR-DRIFT-MATRIX.md` — cross-cuts and overlap clusters

After Phase 2 completes, treat this appendix as **historical context** and refer to the inventory + drift matrix as canonical.

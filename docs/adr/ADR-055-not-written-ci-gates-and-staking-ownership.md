# ADR-055: Not Written — CI quality gates + staking-PDA ownership both addressed elsewhere

## Status
Not Written (proposals absorbed by existing ADRs / process work)

## Date
2026-04-22 (backfill disposition)

## Context

ADR-055 was referenced under two different titles across two audit documents:

- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"`: **"CI quality gates (mandatory vs advisory policy)"** — a single source of truth for which CI jobs block merge vs which are advisory, including anchor-build-with-IDL-diff and secret-scan as mandatory. Closes S-xcut-03, -04, -05, -08.
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11.2`: **"Staking PDA Ownership Model"** — Registry owns the staking PDA; `init` on first stake; `invoke_signed` for unstake; integration test required for merge.

Neither proposal reached ADR status under the number 055.

**Staking PDA ownership**: the decision is resolved. Current code (`programs/agent-registry/src/lib.rs`) has the Registry program owning the `reputation-stake` PDA, with seeds `[authority, "reputation-stake"]`; the unstake path uses `invoke_signed` from the Registry's authority PDA; ADR-020 (`reputation-staking`, Accepted) and ADR-039 (`wire-slashing-unstake`, Accepted) together govern the current design. ARCHITECTURE_DEEP_CRITIQUE's ADR-055 ask was implemented ahead of its own formal authorship and does not need a separate ADR now. Related Audit 1 finding #4 (stake-orphan on `deregister_agent`) is a correctness bug under the current ownership model, tracked as ADR-070 on the parallel audit-response track — it does not reopen the ownership decision.

**CI quality gates**: the mandatory-vs-advisory question was decided by CI configuration (`.github/workflows/*.yml`) rather than by ADR. Current state per STATUS.md §1: all 11 jobs green; Anchor Integration (99/99 tests), mcp-server tests, validator tests, sas-resolver tests, Squads config tests all mandatory on PR. Secret scanning and anchor-build-with-IDL-diff are in place. There is no open architectural question; there is an operational question about Dependabot cadence and action SHA pinning (REAUDIT P2 items #9, #10, #11) that is governance-process work, not an architectural decision. No ADR is needed.

Audit 3 gap #12 flagged ADR-055 as "referenced but not present." Investigation confirms both proposals were subsumed by work that landed without formal ADR-055 authorship.

## Decision

**Do not write ADR-055.** Both original proposals are closed by existing ADRs (ADR-020, ADR-039) or by CI-configuration decisions that do not rise to architectural-decision status. The number remains vacant as an editorial artifact.

## Consequences

- No open architectural question remains under ADR-055.
- Follow-up CI hardening (Dependabot, action-SHA pinning, ESLint on mcp-server, Node minor pin) is operational and tracked in REAUDIT P2 — not pinned to this ADR number.
- Does not gate mainnet.

## References
- `docs/adr/ADR-020-reputation-staking.md` — current staking-PDA ownership doctrine (Accepted)
- `docs/adr/ADR-039-wire-slashing-unstake.md` — unstake / slashing via `invoke_signed` from Registry authority (Accepted)
- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"` — original CI-gates proposal
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11.2` — original staking-ownership proposal
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gap #12 — current audit trigger
- `.github/workflows/` — CI configuration where the mandatory-vs-advisory decision actually lives

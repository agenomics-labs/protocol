# ADR-045: Numbering gap — no decision recorded

## Status
Not Written (numbering gap)

## Date
2026-04-22 (backfill disposition)

## Context

The ADR sequence 001 → 079 contains a gap at number 045. `ARCHITECTURE_REAUDIT_2026-04.md §5` (S-xcut-01) flagged this as "Medium severity, historical record gap, reviewer discipline degraded" but did not identify a lost decision — only the missing number. Deep-Audit 2026-04-22 (Audit 3 gap #12) re-surfaced the concern pre-mainnet.

Investigation (2026-04-22):

- `grep -rn "ADR-045"` across `docs/`, `programs/`, `packages/`, `mcp-server/`, `scripts/` returns zero substantive references beyond the two audit documents that flagged the gap. No source file, no test, no other ADR cites ADR-045 as a dependency or a decision.
- No PR history shows an ADR-045 draft that was subsequently renumbered, merged, or rejected. The number was allocated and left vacant between ADR-044 (`clean-spend-records`, Accepted 2026-04-15) and ADR-046 (`add-missing-mcp-tools`, Accepted 2026-04-15), both landing in the same day.
- No open design question in the reaudit or the deep audit lists ADR-045 as its tracking number.

The gap is editorial, not architectural: a reviewer skipped 045 when cutting ADR-046.

## Decision

**Leave the number vacant and record this stub as the audit trail.** No decision was made, no decision was rejected, no decision is missing.

## Consequences

- Preserves the monotonic numbering convention (no renumber-shuffle across existing ADRs, which would invalidate every cross-reference in `programs/` and `packages/`).
- Closes S-xcut-01 and Audit 3 gap #12 (ADR-045 line) without ambiguity.
- Does not affect mainnet readiness.

## References
- `docs/ARCHITECTURE_REAUDIT_2026-04.md` §5 (S-xcut-01) — original gap flag
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gap #12 — pre-mainnet re-surface
- `docs/adr/ADR-044-clean-spend-records.md` — preceding ADR
- `docs/adr/ADR-046-add-missing-mcp-tools.md` — succeeding ADR

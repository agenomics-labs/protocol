# ADR-103 — Standardized TypeScript Result Shape

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-04-23 |

## Context
mcp-server and sas-resolver each define near-identical Result types and wrap()
helpers. Drift between these duplicates causes subtle inconsistencies.

## Decision
The canonical Result type is defined in `@agenomics/action-runtime` (ADR-100):
  type Result<T, E = Error> = {ok: true; value: T} | {ok: false; error: E}
All off-chain services import from that package. The local wrap() helpers are
replaced by the canonical one. A defineAction() builder standardizes MCP
action definitions.

## Alternatives
- Keep per-package: simpler short-term, drift long-term.
- Use fp-ts/neverthrow: heavier dependency, different ergonomics.

## Consequences
- Uniform error handling across all TypeScript services.
- action-runtime becomes a required dev dependency for mcp-server and sas-resolver.

## References
- Architecture Audit 2026-04-23, Item 26, Code §1.3 / §3.3
- ADR-100 (@agenomics/action-runtime)

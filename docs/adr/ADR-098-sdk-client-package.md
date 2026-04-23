# ADR-098 — @agenomics/client SDK Package

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-04-23 |

## Context
No public TypeScript client exists for the AEP protocol. External builders
must read mcp-server internals or reverse-engineer PDA derivation logic.

## Decision
Create `sdk/client/` publishing as `@agenomics/client`. Provides:
- Typed PDA derivation helpers (using @agenomics/idl for program IDs)
- High-level `AepClient` class wrapping common operations (register, getProfile, etc.)
- Re-exports `@agenomics/idl` program IDs and IDL types for convenience

## Consequences
- External builders get a stable, typed surface to build on.
- Must be kept in sync with program IDL changes.

## References
- Architecture Audit 2026-04-23, Item 23, Arch §6.2

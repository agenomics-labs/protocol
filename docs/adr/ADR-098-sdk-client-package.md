# ADR-098 — @agenomics/client SDK Package

## Status

Accepted

## Date

2026-04-23

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
- **Amended by [ADR-141] (2026-05-18, Accepted):** the hand-written PDA/wrapper
  *mechanism* in this ADR is superseded by Codama codegen, and the instruction
  builders ADR-098 explicitly deferred are now delivered. This ADR's
  package/distribution decision (`@agenomics/client`, the `AepClient` surface,
  `@agenomics/idl` re-exports) remains **in force** — ADR-141 changes *how* the
  client is produced, not *that* it exists. Status stays `Accepted` (not
  Superseded): only the generation mechanism is replaced.

## References
- Architecture Audit 2026-04-23, Item 23, Arch §6.2
- [ADR-141] Codama-generated Anchor clients — supersedes the hand-written
  wrapper mechanism; closes the SDK-F2 seed-rename trust-root weakness

[ADR-141]: ADR-141-codama-generated-anchor-clients.md

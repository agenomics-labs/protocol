# ADR-100 — @agenomics/action-runtime SDK Package

## Status

Accepted

## Date

2026-04-23

## Context
The MCP server contains action-definition boilerplate (Result type, wrap helper,
defineAction builder) that external action authors need but can't import without
depending on the entire mcp-server.

## Decision
Extract to `sdk/action-runtime/` publishing as `@agenomics/action-runtime`. Provides:
- `Result<T,E>` type: `{ok: true; value: T} | {ok: false; error: E}`
- `ok(value)` and `err(error)` constructors
- `defineAction(spec)` builder that wraps a handler with standard error catching
- `wrap(fn)` helper for async-to-Result conversion

## Consequences
- External action authors depend only on this lightweight package.
- mcp-server refactors to import from this package (in a follow-up).

## References
- Architecture Audit 2026-04-23, Item 23 / Item 26, Arch §6.3

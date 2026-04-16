# ADR-008: Add Rust Unit Tests for All Programs

## Status
Accepted

## Date
2026-04-15

## Context
None of the three Solana programs had Rust-level unit tests (`#[cfg(test)]` modules). All testing relied on the TypeScript integration test suite (`mcp-server/test/mcp-handlers.test.ts`), which:

1. Requires a running local validator
2. Tests the full stack (MCP server -> Anchor client -> on-chain program)
3. Cannot test internal program logic in isolation (e.g., policy validation, enum transitions)
4. Is slow to iterate on during development

Unit tests complement integration tests by testing internal logic without a validator.

## Decision
Add `#[cfg(test)]` modules to each program with tests for:

### Agent Vault
- Policy construction and defaults
- `is_token_allowed` / `is_program_allowed` with empty and populated allowlists
- Allowlist cap enforcement logic

### Agent Registry
- Status transition validation (Active/Paused/Retired state machine)
- Reputation score arithmetic (saturating add/sub, bounds)
- Average rating calculation (weighted running average)

### Settlement
- Milestone sum validation
- Escrow status transitions
- Milestone status state machine

These are pure-logic tests that verify data structures and validation without requiring Anchor runtime or a validator.

## Alternatives Considered

### Alternative: Use `solana-program-test` for unit-level BPF tests
Provides more realistic testing but requires BPF compilation and is significantly slower. Reserved for integration-level tests.

### Alternative: Property-based testing (proptest)
Good for finding edge cases but adds a dependency and is better suited for mature codebases. Can be added later.

## Consequences

### Positive
- Fast feedback loop during development (`cargo test` runs in seconds)
- Tests internal invariants that integration tests can't easily reach
- Serves as executable documentation for business logic

### Negative
- Cannot test Anchor account constraints or CPI behavior
- Must be maintained alongside integration tests

## Files Changed
- `programs/agent-vault/src/lib.rs` - Added `#[cfg(test)]` module
- `programs/agent-registry/src/lib.rs` - Added `#[cfg(test)]` module
- `programs/settlement/src/lib.rs` - Added `#[cfg(test)]` module

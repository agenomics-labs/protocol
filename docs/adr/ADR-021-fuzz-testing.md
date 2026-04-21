# ADR-021: Fuzz Testing with Property-Based Tests

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

The AEP Solana programs handle financial operations (vault spending limits, escrow milestones, reputation scoring) where arithmetic edge cases could lead to fund loss or program panics. Traditional unit tests cover known scenarios but miss unexpected input combinations. We need systematic testing of invariants across random inputs to catch overflow bugs, off-by-one errors, and violated assumptions.

Cargo-fuzz requires nightly Rust and is incompatible with our stable toolchain pinned for Anchor. The `proptest` crate provides property-based testing on stable Rust with no additional tooling.

## Decision

Add `proptest = "1"` as a dev-dependency to all three program crates and implement property-based fuzz tests inside each program's existing `#[cfg(test)]` module. Tests target the following invariants:

**agent-vault:**
- Token allowlist size never exceeds `MAX_TOKEN_ALLOWLIST` after any sequence of add/remove operations
- `VaultPolicy::is_token_allowed` returns `true` for any pubkey when allowlist is empty
- Daily limit arithmetic using `saturating_add` never overflows or panics

**agent-registry:**
- Reputation score arithmetic with arbitrary `i64` deltas never panics (saturating ops)
- `avg_rating` stays within 0-5 range for any sequence of valid ratings

**settlement:**
- Milestone amount summation either succeeds or overflow is detected via `checked_add`
- `released_amount` tracking with random milestone amounts never exceeds `total_amount`

## Alternatives Considered

1. **cargo-fuzz / libfuzzer** -- Requires nightly Rust, incompatible with our Anchor toolchain
2. **Trident (Ackee Blockchain)** -- Full Anchor fuzzer but heavy dependency; overkill for arithmetic invariants
3. **Manual boundary tests** -- Already in place but cannot cover the combinatorial input space

## Consequences

- All property tests run as part of `cargo test` with zero additional CI configuration
- Each test runs 256 random cases by default (configurable via `PROPTEST_CASES`)
- New invariants can be added incrementally without changing test infrastructure
- Does not replace integration tests for on-chain logic requiring Anchor context

## Files Changed

- `programs/agent-vault/Cargo.toml` -- added `proptest = "1"` to dev-dependencies
- `programs/agent-registry/Cargo.toml` -- added `proptest = "1"` to dev-dependencies
- `programs/settlement/Cargo.toml` -- added `proptest = "1"` to dev-dependencies
- `programs/agent-vault/src/lib.rs` -- added `mod fuzz` with 3 proptest functions
- `programs/agent-registry/src/lib.rs` -- added `mod fuzz` with 2 proptest functions
- `programs/settlement/src/lib.rs` -- added `mod fuzz` with 2 proptest functions

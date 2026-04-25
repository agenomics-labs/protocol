# ADR-014: Verify CPI Discriminator with Automated Test

## Status
Superseded by code-evolution (test removed when manual-discriminator pattern was abandoned)

## Date
2026-04-15

## Context
The Settlement program's `update_provider_reputation` helper uses a hardcoded 8-byte discriminator `[194, 220, 43, 201, 54, 209, 49, 178]` to construct the CPI instruction data for the Registry's `update_reputation` instruction. This discriminator is the Anchor convention: `sha256("global:update_reputation")[..8]`.

If the Registry instruction were renamed, or Anchor changed its discriminator convention, this hardcoded value would silently produce an "instruction not found" error at runtime with no clear indication of the root cause.

## Decision
Add an automated Rust unit test that:
1. Computes `sha256("global:update_reputation")[..8]` at test time
2. Asserts it matches the hardcoded `[194, 220, 43, 201, 54, 209, 49, 178]`
3. Fails with a descriptive message if they diverge

This runs as part of `cargo test` on every CI build, catching any drift immediately.

## Alternatives Considered

### Alternative: Use Anchor CPI crate to avoid manual discriminators entirely
Preferred long-term but requires publishing agent-registry as a crate dependency. The test provides equivalent safety for the manual pattern. See ADR-007.

### Alternative: Runtime discriminator computation
Computing the hash at runtime adds CPU cost to every CPI call. The compile-time constant + test assertion is zero-cost at runtime.

## Consequences

### Positive
- Discriminator correctness is verified on every `cargo test` run
- Descriptive error message pinpoints the exact mismatch
- Zero runtime overhead

### Negative
- Test must be updated if the instruction name changes (but the test failure itself would catch this)

## Files Changed
- `programs/settlement/src/lib.rs` — Added `test_cpi_discriminator_matches_anchor_convention` test

## Revisions

- 2026-04-25 — Status flipped to Superseded by code-evolution. The
  `test_cpi_discriminator_matches_anchor_convention` test no longer exists in
  the tree; it was removed when ADR-007's manual-discriminator pattern was
  abandoned in favour of Anchor's CPI helper (see ADR-007 Revisions). The
  test's purpose was to guard a hardcoded discriminator that no longer drives
  the runtime. AUD-2026-04-25 / AUD-048 / drift matrix §2.

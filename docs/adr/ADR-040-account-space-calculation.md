# ADR-040: Account Space Calculation

## Status

Accepted

## Date

2026-04-16

## Context

The `AgentProfile` account space was previously calculated using `mem::size_of::<AgentProfile>() + 500`. This approach is incorrect for Borsh-serialized data because `mem::size_of` returns the Rust stack size of the struct, which does not reflect the actual serialized layout. Variable-length types like `Vec<T>` and `String` occupy a fixed pointer/length/capacity triple on the stack but serialize to a 4-byte length prefix followed by their contents. The addition of `ReputationStake` fields in ADR-020 further widened the gap between stack size and serialized size, making the magic `+ 500` buffer unreliable.

## Decision

Replace `mem::size_of::<AgentProfile>() + 500` with an explicit 1243-byte calculation that sums the serialized size of every field:

- 8 bytes: Anchor discriminator
- 32 bytes: `owner` (Pubkey)
- 4 + 64 bytes: `name` (String, max 64 chars)
- 4 + 256 bytes: `metadata_uri` (String, max 256 chars)
- 4 + 50 bytes: `category` (String, max 50 chars)
- 8 bytes: `created_at` (i64)
- 8 bytes: `updated_at` (i64)
- 1 byte: `is_active` (bool)
- 8 bytes: `total_ratings` (u64)
- 8 bytes: `rating_sum` (u64)
- 4 bytes: `rating_count` (u32)
- 32 bytes: `reputation_stake_mint` (Pubkey)
- 8 bytes: `reputation_stake_amount` (u64)
- 9 bytes: `disputed_at` (Option<i64>)
- 4 + N bytes: `tags` (Vec, reserved max)
- Remaining bytes: padding/reserved

Each field size is documented inline in the constant definition to make future field additions auditable.

## Alternatives Considered

1. **Keep `mem::size_of` with a larger buffer** -- fragile; any struct change requires guessing a new buffer.
2. **Use `InitSpace` derive macro** -- Anchor's `InitSpace` does not yet handle all custom types and requires `#[max_len]` annotations that are easy to forget.
3. **Allocate maximum account size (10 KB)** -- wastes rent-exempt lamports for every agent.

## Consequences

- Account allocations now match the exact maximum serialized size, preventing realloc failures and wasted lamports.
- Adding new fields requires updating the constant and its inline documentation, which is an intentional friction to prevent silent breakage.
- Existing accounts created with the old size may need migration if the new size exceeds the old allocation.

## Files Changed

- `programs/aep/src/state/agent.rs` -- replaced `ACCOUNT_SPACE` constant with explicit 1243-byte sum
- `programs/aep/src/instructions/register_agent.rs` -- updated `space` parameter in `init` constraint
- `tests/agent_registration.ts` -- updated expected account size in test assertions

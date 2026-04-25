# ADR-047: disputed_at Option Type and avg_rating Rounding

## Status

Accepted

## Date

2026-04-16

## Context

Two related issues existed in the `AgentProfile` state:

**L1 -- `disputed_at` sentinel value**: The `disputed_at` field was typed as `i64` and used `0` as a sentinel value meaning "not disputed." This is ambiguous because `0` is a valid Unix timestamp (1970-01-01T00:00:00Z). Any code checking `disputed_at != 0` carries the implicit assumption that no dispute could ever have a timestamp of zero, which is fragile and semantically incorrect.

**L2 -- `avg_rating` integer truncation**: The average rating calculation used `(old_avg * (n - 1) + new_rating) / n`, which truncates toward zero due to integer division. Over many ratings, this systematic truncation introduces a downward bias. For example, an agent with ratings [5, 4, 5, 4, 5] would compute an average of 4 instead of the correct rounded value of 5 (actual mean: 4.6).

## Decision

**L1 fix**: Change `disputed_at` from `i64` to `Option<i64>`. An undisputed agent has `disputed_at: None`. A disputed agent has `disputed_at: Some(timestamp)`. This eliminates the sentinel value and makes the semantics explicit in the type system. Borsh serializes `Option<i64>` as 1 byte (discriminant) + 8 bytes (payload when `Some`), totaling 9 bytes, which is accounted for in ADR-040's space calculation.

**L2 fix**: Change the average rating formula to use rounded integer division:

```rust
avg_rating = (old_avg * (n - 1) + new_rating + n / 2) / n;
```

The `+ n / 2` term implements "round half up" behavior for positive values, which is the expected rounding mode for user-facing ratings. This eliminates the systematic downward bias from truncation.

## Alternatives Considered

### For disputed_at

1. **Keep `i64` with sentinel `0`** -- ambiguous and error-prone as described above.
2. **Use sentinel `-1`** -- negative timestamps are also valid (dates before epoch); does not solve the fundamental problem.
3. **Use a separate `bool is_disputed` flag** -- adds a field but duplicates information; the timestamp already implies disputed status.

### For avg_rating

1. **Use floating-point (`f64`)** -- Borsh supports it but introduces floating-point determinism concerns in on-chain programs.
2. **Store rating as basis points (multiply by 100)** -- adds precision but increases complexity for a marginal improvement over rounding.
3. **Store only `rating_sum` and `rating_count`, compute average off-chain** -- valid but prevents on-chain logic from using the average for decisions (e.g., reputation thresholds).

## Consequences

- `disputed_at` semantics are now explicit: pattern matching on `Option` forces callers to handle both cases, eliminating a class of sentinel-related bugs.
- The serialized size of `disputed_at` changes from 8 bytes to 9 bytes (1-byte `Option` discriminant + 8-byte `i64`). This is accounted for in the ADR-040 space calculation.
- Existing accounts with `disputed_at = 0` need migration to `disputed_at = None`. Accounts with nonzero values migrate to `Some(value)`.
- Average ratings now round to the nearest integer, producing more accurate and fair results for agents.
- The rounding fix is backward-compatible in the sense that it does not change the type, only the computed value.

## Files Changed

- `programs/aep/src/state/agent.rs` -- changed `disputed_at: i64` to `disputed_at: Option<i64>`
- `programs/aep/src/instructions/dispute.rs` -- updated to set `disputed_at = Some(clock.unix_timestamp)`
- `programs/aep/src/instructions/resolve_dispute.rs` -- updated to set `disputed_at = None`
- `programs/aep/src/instructions/rate_agent.rs` -- updated avg_rating formula with `+ n / 2` rounding term
- `programs/aep/src/state/agent.rs` -- updated `ACCOUNT_SPACE` to reflect 9-byte `Option<i64>`
- `tests/dispute.ts` -- updated assertions to check for `null` / timestamp instead of `0` / nonzero
- `tests/rating.ts` -- added test verifying correct rounding behavior

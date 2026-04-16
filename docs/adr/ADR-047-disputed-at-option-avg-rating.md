# ADR-047: Fix L1/L2 — disputed_at Option + avg_rating Rounding

## Status
Accepted

## Date
2026-04-16

## Context
Two low-severity issues from ADR-037 audit:

**L1**: `disputed_at` used `i64` with sentinel value `0` for "not disputed". Unix epoch 0 (January 1, 1970 00:00:00 UTC) is a technically valid timestamp, creating ambiguity.

**L2**: `avg_rating` used integer truncation: `(old_avg * (n-1) + new_rating) / n`. With ratings 4, 5, 3 this produces avg=3 (truncated from 3.67) instead of the expected 4.

## Decision

**L1 Fix**: Changed `disputed_at: i64` to `disputed_at: Option<i64>` in `TaskEscrow`. Initialized as `None`. Set to `Some(timestamp)` in `raise_dispute`. Timeout check uses `.ok_or()` for clean error handling.

**L2 Fix**: Added rounding term to the weighted average formula:
```rust
let new_avg = (old_avg * (n - 1) + rating as u128 + n / 2) / n;
```
The `+ n/2` term provides round-to-nearest-integer behavior instead of truncation.

## Consequences

### Positive
- `disputed_at` has proper null semantics — `None` vs `Some(timestamp)` is unambiguous
- Ratings are more accurate — 3.67 rounds to 4 instead of truncating to 3

### Negative
- `Option<i64>` adds 1 byte to serialized size (Borsh option tag) — within margin
- Breaking change for any code reading `disputed_at` as raw i64

## Files Changed
- `programs/settlement/src/lib.rs` — `disputed_at: Option<i64>`, init/set/check updated
- `programs/agent-registry/src/lib.rs` — avg_rating formula with rounding

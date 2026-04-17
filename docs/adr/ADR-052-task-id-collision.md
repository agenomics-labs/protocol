# ADR-052: Escrow PDA task_id Collision — Known Limitation

## Status
Accepted

## Date
2026-04-17

## Context

Escrow PDA seeds are `[b"escrow", client, provider, task_id_bytes]` where `task_id` is a user-supplied `u64`. If the same `(client, provider)` pair reuses a `task_id` while an escrow account still exists at that PDA, `init` fails with a cryptic Anchor error ("account already in use" / "already initialized"). The error gives no indication that the root cause is a duplicate `task_id`.

After an escrow reaches a terminal state (completed, refunded, or expired), the `CloseEscrow` instruction (added in PR #1) reclaims the account's lamports and zeroes its data, freeing the PDA for reuse with the same `task_id`.

## Decision

Accept as v1 behavior. The `task_id` uniqueness constraint is per `(client, provider)` pair, not global. `CloseEscrow` enables PDA reuse after the escrow lifecycle completes.

### Mitigation (MCP / Client Layer)

- Use monotonic counters per `(client, provider)` pair to guarantee uniqueness.
- Alternatively, derive `task_id` from an application-level hash: `hash(timestamp + description + nonce) % u64::MAX`.
- Document clearly that `task_id` values are unique per `(client, provider)` pair, not globally unique.
- Surface a descriptive error in the MCP server when escrow creation fails due to an existing account at the derived PDA.

## Alternatives Considered

### On-chain counter PDA per (client, provider) pair
A counter account at `[b"escrow-counter", client, provider]` would auto-increment `task_id` on each escrow creation. Rejected because:
- Adds an extra account to every `create_escrow` transaction
- Introduces write contention on the counter for concurrent escrow creation
- Pushes a client-side concern (ID generation) on-chain unnecessarily

### Global sequential counter
A single program-wide counter PDA. Rejected for the same contention reasons, amplified across all users.

## Consequences

### Positive
- No additional on-chain accounts or state
- `CloseEscrow` prevents permanent PDA exhaustion
- Client-side ID generation is flexible — callers choose their own scheme

### Negative
- Duplicate `task_id` produces a confusing Anchor error without custom messaging
- Clients must implement their own uniqueness guarantees
- If `CloseEscrow` is not called after terminal state, the PDA remains occupied

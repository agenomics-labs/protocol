# ADR-095 — Vault ↔ Registry Suspension Coupling

## Status

Accepted

## Date

2026-04-23

## Context

Agent vault transfer instructions do not currently check the Registry's
suspension flag. A suspended agent (penalized or frozen) can still move funds
through their vault, defeating the suspension's purpose.

The Registry program sets `AgentStatus::Suspended` when an agent accumulates
three or more slashes via `update_reputation`. While this prevents the agent
from staking more reputation or transitioning status, it does not block asset
movement through the vault — an economically significant loophole.

## Decision

Agent vault `ExecuteTransfer` and `ExecuteTokenTransfer` instruction contexts
include the `agent_profile` account (from the Registry program) as a read-only
account. A call to `require_not_suspended` in the instruction handler enforces
that the agent is not in the `Suspended` status. If the account is suspended,
the instruction returns `VaultError::AgentSuspended`.

The vault depends on `agent-registry` with `features = ["cpi"]` (the same
mechanism used by the settlement program) so that `agent_registry::state::AgentProfile`
and `AgentStatus` are available as strongly-typed imports. This provides
compile-time safety over brittle byte-offset reads.

The `agent_profile` PDA is validated by the seed constraint
`[authority.key().as_ref(), b"agent-profile", vault.profile_nonce.to_le_bytes()]`
(per ADR-097). The `profile_nonce` is stored in the vault's `Vault` account
and was recorded at `initialize_vault` time by the caller reading the current
nonce from the `OwnerNonce` account. This ensures the vault always points to
the live profile PDA, not a stale one from a previous registration cycle.

## Alternatives

- **Document as out-of-band**: Client must check before submitting — too weak.
  On-chain enforcement is the only guarantee; clients can be bypassed or buggy.
- **Separate "freeze" flag on vault**: Duplicates state, can desync if the
  registry suspends the agent but the vault flag is not updated. Single
  source of truth is superior.
- **Off-chain relayer**: A cranker watches for suspension events and pauses
  the vault — introduces liveness dependency and a permissioned actor.

## Consequences

- Vault `ExecuteTransfer` and `ExecuteTokenTransfer` gain one additional
  account (`agent_profile`). Clients must include this account in transfer
  transactions.
- Suspension is now enforceable on-chain for asset movement, not just
  reputation gating.
- The vault program gains a dependency on `agent-registry` (with `cpi`
  feature), creating a compile-time coupling. Independent upgrades require
  bumping the shared crate version.
- Slight compute overhead per transfer for the additional account
  deserialization and field check.
- `initialize_vault` gains a `profile_nonce: u64` parameter; existing
  callers must be updated.

## References

- Architecture Audit 2026-04-23, Item 20, Arch §1.2
- ADR-097 (registration nonce — defines the updated PDA seed consumed here)

# ADR-097 — Registration Nonce for Sybil Resistance

## Status

Accepted

## Date

2026-04-23

## Context

`AgentProfile` PDA is derived from `[authority.key().as_ref(), b"agent-profile"]`.
An agent can close their profile via `deregister_agent` and reopen it at the
**same address** via `register_agent`, bypassing reputation history — a Sybil
reuse attack. A monotonic registration nonce in the PDA seed prevents address
reuse after close.

The existing `StakePresentOnDeregister` guard (ADR-070/SEC-4) requires agents
to drain their reputation stake before deregistering, but it does not prevent
deregistration of unstaked (e.g. zero-stake) agents. Once deregistered, the
same PDA address can be occupied by a fresh `register_agent` call, starting
with a clean reputation slate. Off-chain indexers that key history on the PDA
address would be unable to distinguish the fresh registration from the old one.

## Decision

Add `registration_nonce: u64` to `AgentProfile`. A per-owner `OwnerNonce`
account tracks the next nonce for each owner. The PDA seed becomes:

```
[authority.key().as_ref(), b"agent-profile", nonce.to_le_bytes().as_ref()]
```

The `OwnerNonce` account is:
- Seeded: `[authority.key().as_ref(), b"owner-nonce"]`
- Initialized to 0 on first `register_agent` if it does not yet exist (via
  `init_if_needed`), with `nonce = 0`.
- Incremented atomically in `deregister_agent` so the next `register_agent`
  uses `nonce + 1`, producing a different PDA address.

On `register_agent`:
1. Read `owner_nonce.nonce` (the current value, starting at 0).
2. Derive `agent_profile` PDA using this nonce.
3. Store `agent_profile.registration_nonce = nonce`.

On `deregister_agent`:
1. Close `agent_profile` (existing `close = authority` constraint).
2. Increment `owner_nonce.nonce` so the next registration uses `nonce + 1`.

This means the second registration of the same authority lives at a
different PDA address, making its history unambiguously separate from the
first registration's history in any indexer that keys on the profile address.

## Alternatives

- **Prevent closes entirely**: Too restrictive. Legitimate reasons to
  deregister exist (name changes, key migration, service retirement).
- **Store closed-address blocklist**: Unbounded storage; not viable on Solana
  without a separate index account that itself could grow arbitrarily large.
- **Timestamp-in-seed**: Non-monotonic, can be replayed within the same
  second; does not provide the strict "address never reused" guarantee.

## Consequences

- **Migration required for mainnet**: Existing `agent_profile` PDAs were
  derived without a nonce component. They are at old addresses. A migration
  strategy (e.g. a one-time re-registration window at nonce=0 for accounts
  that were registered before this change) is required before deploying to
  mainnet. For the current devnet/testnet environment, existing accounts
  are simply abandoned at the old addresses.
- **Off-chain indexers must include nonce in PDA derivation queries**: Any
  indexer or client that derives the `agent_profile` PDA must read the
  current `OwnerNonce` account first to determine the correct nonce.
- **`OwnerNonce` account initialization**: The first `register_agent` call
  per authority must pay for the `OwnerNonce` account (one additional
  rent-exempt allocation, ~890 lamports for 16 bytes: 8 discriminator + 8 nonce).
- **ADR-095 dependency**: The vault suspension check (ADR-095) must derive
  the `agent_profile` PDA using the nonce stored in the `Vault` account
  at `initialize_vault` time.

## References

- Architecture Audit 2026-04-23, Item 22, Arch §4.3 / Sec 2.1
- ADR-070 (SEC-4): StakePresentOnDeregister guard
- ADR-095: Vault suspension coupling (consumes the updated PDA seed)

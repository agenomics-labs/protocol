# ADR-096 — Account-resize / Migration Pattern

## Status

Accepted

## Date

2026-04-23

## Context

`AgentProfile` is an Anchor account with a fixed initial space allocation
(1405 bytes as of ADR-060). Adding new fields — e.g., `registration_nonce`
from ADR-097, or a `version` byte for forward-compatibility — requires
growing deployed accounts in-place. Without an explicit migration path, any
field addition is a breaking change: all existing accounts must be closed and
re-created, losing their PDA address continuity and requiring coordinated
client rollouts.

Anchor's `realloc` constraint (added in Anchor 0.26) provides in-place
account resize via the System Program's `realloc` syscall. The cost is
lamports to cover the additional rent-exempt balance, paid by a designated
payer. This ADR establishes the reusable pattern.

## Decision

1. **`version: u8` field** — Add a `version` field to `AgentProfile` (after
   all existing fields). Set to `0` on creation; incremented by
   `migrate_agent_profile`. Acts as a cheap on-chain schema discriminator.

2. **`MIGRATION_HEADROOM = 64`** — Reserve 64 bytes beyond the current
   `INIT_SPACE` in `register_agent`'s space allocation. This covers the
   next 2–3 field additions without triggering `realloc` on every upgrade.

3. **`migrate_agent_profile` instruction** — A permissioned, idempotent
   instruction that:
   - Uses Anchor's `realloc` constraint to resize the account to
     `8 + AgentProfile::INIT_SPACE + MIGRATION_HEADROOM`.
   - Writes the new `version` value when `target_version > profile.version`.
   - Is a no-op (returns `Ok(())`) when `profile.version >= target_version`,
     making repeated calls safe.

4. **Upgrade authority** must run a migration script after any
   field-adding program upgrade. New fields must be added as `Option<T>` or
   with a sensible zero-value default (Anchor zero-initializes reallocated
   bytes when `realloc::zero = true`).

## Alternatives

- **Close and recreate**: loses PDA address continuity, breaks all
  downstream integrations that hold the PDA key, requires coordinated
  multi-party rollout. Rejected.
- **Version in discriminator**: Anchor uses an 8-byte account discriminator
  derived from the account name; it does not support discriminator
  versioning. Rejected.
- **Separate versioned account type**: doubles the IDL surface and requires
  all callers to handle two account layouts. Rejected.

## Consequences

- Upgrade authority must run the migration script after any field-adding
  program upgrade.
- New fields must be `Option<T>` or have sensible zero-value defaults so
  that `realloc::zero = true` produces a valid state.
- Initial account space includes `MIGRATION_HEADROOM` (64 bytes), adding a
  one-time cost of ~0.00045 SOL per newly registered agent at current rent
  rates — acceptable.
- The `version` field is 1 byte; any program checking `AgentProfile` layout
  must account for it appearing after the ADR-060 manifest fields.

## References

- Architecture Audit 2026-04-23, Item 21, Arch §4.2
- ADR-097 (registration_nonce requires this migration path)
- ADR-040 (original explicit space calculation)
- ADR-060 (manifest fields, established the 1405-byte baseline)
- Anchor `realloc` docs: https://docs.rs/anchor-lang/latest/anchor_lang/derive.Accounts.html

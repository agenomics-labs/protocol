# ADR-041: Vault has_one Authority Constraint

- **Status**: Accepted
- **Date**: 2026-04-16

## Context

Several instruction contexts that mutate vault state -- `UpdatePolicy`, `ManageAllowlist`, `ManageProgramAllowlist`, `PauseVault`, and `ResumeVault` -- relied on handler-level `require!` checks to verify that `ctx.accounts.authority.key() == vault.authority`. This pattern is error-prone: a developer adding a new handler could forget the check, and the mismatch would only surface at runtime. Anchor provides a `has_one` constraint that validates the relationship at account deserialization time, before handler code executes.

## Decision

Add `has_one = authority` to the `#[account]` attribute on the `vault` field in each of the following contexts:

- `UpdatePolicy`
- `ManageAllowlist`
- `ManageProgramAllowlist`
- `PauseVault`
- `ResumeVault`

Remove the now-redundant `require!(ctx.accounts.authority.key() == vault.authority, ...)` checks from the corresponding handler functions. The Anchor framework enforces the constraint during account deserialization, producing an `Anchor ConstraintHasOne` error on mismatch.

This is a defense-in-depth measure: Anchor validates the authority match before any handler logic runs, eliminating an entire class of authorization bypass bugs.

## Alternatives Considered

1. **Keep `require!` checks only** -- works but is fragile; relies on every handler remembering to include the check.
2. **Use `constraint = vault.authority == authority.key()`** -- functionally equivalent to `has_one` but more verbose and less idiomatic.
3. **Custom access control macro** -- over-engineered for a simple ownership check that Anchor already supports.

## Consequences

- Authority validation is now enforced at the framework level for all five instruction contexts, reducing the surface area for authorization bugs.
- Error messages change from custom error variants to `Anchor ConstraintHasOne`, which is less descriptive but universally recognized.
- The redundant `require!` calls are removed, reducing handler code and eliminating the risk of the check diverging from the constraint.
- Any future instruction context operating on the vault should follow this pattern and include `has_one = authority`.

## Files Changed

- `programs/aeap/src/instructions/update_policy.rs` -- added `has_one = authority`, removed `require!`
- `programs/aeap/src/instructions/manage_allowlist.rs` -- added `has_one = authority`, removed `require!`
- `programs/aeap/src/instructions/manage_program_allowlist.rs` -- added `has_one = authority`, removed `require!`
- `programs/aeap/src/instructions/pause_vault.rs` -- added `has_one = authority`, removed `require!`
- `programs/aeap/src/instructions/resume_vault.rs` -- added `has_one = authority`, removed `require!`
- `tests/vault_authority.ts` -- updated error assertions to expect `ConstraintHasOne`

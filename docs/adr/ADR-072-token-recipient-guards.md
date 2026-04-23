# ADR-072: Token transfer recipient guards and self-transfer DoS mitigation

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-6 (HIGH)** identified missing recipient guards in `programs/agent-vault::execute_token_transfer`.

`programs/agent-vault/src/contexts.rs:108` gates `vault_token_account` with `vault_token_account.owner == vault.key()` (correct), but at `:113-117` the `recipient_token_account` is validated only against the mint — **there is no check that the recipient account is not the vault itself or some sanctioned destination**. Combined with the `ExecuteTokenTransfer` self-referential seed derivation (`seeds = [b"vault", vault.authority.key().as_ref()]`) flagged in the same audit section, an authority can legitimately transfer tokens to any recipient under the daily cap — including back to the vault's own associated token account.

This is "by design" for normal transfers, but there is no guard preventing a self-transfer loop. A griefer (who controls the vault authority, so this is mostly a self-harm scenario) can burn rate-limit slots on no-op self-transfers. More operationally concerning: a compromised `agent_identity` key (see ADR-069) could spam self-transfers to exhaust the rate-limit window during an attack, preventing the legitimate authority from executing a defensive transfer-out as part of incident response.

The audit mitigation is a `recipient != vault` assertion at the constraint layer.

## Decision

Add recipient guards to `programs/agent-vault::execute_token_transfer`:

**Constraint-layer check in `contexts.rs`** (`ExecuteTokenTransfer` struct):

1. `constraint = recipient_token_account.key() != vault_token_account.key()` — reject self-transfers of the vault's token account to itself. Anchor constraint error code: new `Error::SelfTransferNotAllowed`.
2. `constraint = recipient_token_account.owner != vault.key()` — defense-in-depth: reject any recipient account whose owner is the vault. This catches the case where an authority created multiple token accounts under the vault's ownership and would attempt a self-ownership loop.

**Handler-layer check** (paranoid belt-and-braces):

3. `require!(recipient_token_account.key() != vault_token_account.key(), Error::SelfTransferNotAllowed)` — identical to the constraint, present in the handler as a defense-in-depth against future Anchor version changes that weaken constraint enforcement.

**Do not add a recipient allowlist** — the whole point of Vault is that the authority decides destinations under the daily cap. Guards are limited to "don't transfer to yourself" hygiene, not "transfer only to these addresses."

**Optional follow-on (not in this ADR)**: a `recipient_token_account.owner != sanctioned_program_ids` check against a compile-time list of well-known sanctioned program IDs (e.g., mixer programs). Tracked as future work; the mainnet trade-off between sanctioned-list maintenance burden and operator autonomy needs broader governance input.

**Program changes**: `programs/agent-vault` only.

**Tests to add** (under `tests/vault/`):

- Negative: `execute_token_transfer` with `recipient_token_account == vault_token_account` → fails with `SelfTransferNotAllowed`.
- Negative: `execute_token_transfer` where `recipient_token_account.owner == vault.key()` → fails.
- Happy path: all other owners (external wallets, contract-owned accounts) → succeeds under existing cap/allowlist rules.
- Integration: attempt 50 self-transfers in a loop → all rejected; `txs_in_current_window` unchanged (this combines with ADR-071's ordering fix).
- Regression: existing happy-path tests remain green; the new constraints must not reject legitimate transfers to external wallets.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Handler-only check, no constraint.** Rejected — Anchor constraint-layer enforcement is cheaper (no handler entry on failure) and auditable directly in the context struct. Defense-in-depth uses both.
- **Constraint check only, no handler check.** Rejected — see "paranoid belt-and-braces" above. If a future Anchor upgrade semantically changes constraint evaluation order, the handler check is a safety net.
- **Add a recipient-pubkey allowlist on `VaultPolicy`.** Rejected — aggressively restricts vault autonomy, defeats the per-transfer authority model, and duplicates the token-allowlist pattern without a matching threat. The threat here is self-transfer spam, not destination freedom.
- **Rate-limit at the recipient level instead of globally.** Rejected — introduces per-recipient state that must be initialized and garbage-collected; the global rate limit plus self-transfer guard is a strictly simpler solution to the same attack class.

## Consequences

**Positive**: closes the self-transfer DoS vector; makes the recipient constraint explicit and auditable in `contexts.rs`; reinforces the rate-limit ordering fix from ADR-071 by ensuring burned slots represent real external-destination transfer attempts.

**Negative**: minor — rejects a small class of (arguably legitimate) self-transfer use cases, e.g., an operator who wanted to use `execute_token_transfer` as a no-op to test the instruction's wiring. Workaround: use devnet for wiring tests; mainnet `execute_token_transfer` is for external transfers only.

**Migration path**: one program upgrade. Additive constraints — no existing legitimate transfer should fail post-upgrade. Operators are notified via release notes. No data migration; existing `VaultPolicy` and `TokenSpendRecord` accounts are untouched. Devnet rehearsal mandatory (GOV-6). Pairs with the ADR-071 upgrade — ideally landed in the same program version to avoid two sequential Vault upgrades.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-6
- `docs/adr/ADR-071-token-rate-limit-ordering.md` — paired fix
- `docs/adr/ADR-041-vault-has-one-authority.md` — authority-binding pattern
- `programs/agent-vault/src/contexts.rs:108, 113-117`

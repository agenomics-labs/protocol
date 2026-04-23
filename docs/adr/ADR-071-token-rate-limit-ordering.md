# ADR-071: Token rate-limit counter ordering — validate before increment

## Status
Proposed

## Date
2026-04-22

## Context

DEEP-AUDIT-2026-04-22.md Audit 1 finding **SEC-5 (HIGH)** identified a rate-limit DoS in `programs/agent-vault::execute_token_transfer`.

The handler at `programs/agent-vault/src/instructions.rs:331` checks `is_token_allowed(&mint)`, but the rate-limit bucket increment at `:347-352` runs **before** the `TokenSpendRecord` lookup at `:365` which resolves `ok_or(TokenNotConfigured)`. Ordering today is: (1) allowlist check, (2) window-counter increment (`txs_in_current_window += 1`), (3) `TokenSpendRecord` lookup, (4) daily-cap check.

**Exploit**: an attacker submits `execute_token_transfer` with a mint that is on the allowlist but has no `TokenSpendRecord` PDA (either never initialized, or an obscure decimals mint). Step 1 passes. Step 2 increments the counter. Step 3 fails, transaction aborts, **and the counter increment is rolled back with the transaction** — so in principle this is OK.

However, Audit 1 notes the more severe case: if `token_allowlist` is empty (per `state.rs:110-114`, "No allowlist = all tokens allowed"), every mint passes step 1, and an attacker can spam `execute_token_transfer` with 1,000 random mints to force 1,000 transaction failures. The on-chain state rolls back per-tx, but off-chain operators see `txs_in_current_window` temporarily observable in the flight window, and future-code refactors that persist the counter before the failing read (a plausible mistake) would make the DoS real. More urgently: the *ordering invariant* itself is the audit item — even if no live exploit exists today, the ordering is fragile and the default-allow-all allowlist semantics invert the secure default.

## Decision

Two-part fix in `programs/agent-vault`:

**Part 1 — Ordering**: rewrite the prelude of `execute_token_transfer` so all validation that can fail precedes any counter mutation. Target sequence:

1. Policy load.
2. Signer gate (`agent.key() == vault.authority || agent.key() == vault.agent_identity`).
3. Mint allowlist check.
4. `TokenSpendRecord` lookup and existence check (fail with `TokenNotConfigured` if absent).
5. Per-mint daily-cap check against `TokenSpendRecord`.
6. Global rate-limit window check (not yet incremented).
7. All checks pass → increment `txs_in_current_window`, update `spent_today` on the `TokenSpendRecord`, execute SPL transfer CPI.

Counter increments are the last mutable step before the CPI. Any validation failure fails fast with no state mutation.

**Part 2 — Default-deny allowlist**: amend `state.rs:110-114` so an empty `token_allowlist` means "deny all tokens" rather than "allow all tokens". Rationale:

- Default-deny is the secure default for allowlists by industry consensus.
- The current "empty = allow all" was an ergonomic choice for early devnet testing; mainnet operators who intentionally want all-tokens semantics can express that with an explicit wildcard sentinel (e.g., an all-zeros `Pubkey` marker entry documented in the Vault SDK, or a separate `token_allowlist_mode: AllowAll | Explicit` field on the policy struct).
- Flipping the semantic is a policy-behavior change. Existing vaults that rely on empty-allowlist = allow-all must migrate (see Consequences).

**Program changes**: `programs/agent-vault` only.

**Tests to add** (under `tests/vault/`):

- Ordering: fuzz `execute_token_transfer` with missing `TokenSpendRecord`, denied mint, daily-cap exceeded — assert `txs_in_current_window` unchanged in each failure case.
- Default-deny: empty allowlist + any mint → fails with `TokenNotAllowed`, not silently permits.
- Wildcard mode (if chosen): explicit wildcard entry + any mint → succeeds gated only by `TokenSpendRecord` + daily cap.
- Regression: existing happy-path tests (allowlisted mint + initialized `TokenSpendRecord` + under cap) remain green.

**Deployment**: program upgrade required. **Multisig signing required** per ADR-031.

## Alternatives Considered

- **Fix ordering but keep default-allow-all.** Rejected — the audit specifically calls out default-allow-all as the severe case. Even with correct ordering, a misconfigured policy (empty allowlist by accident) opens the vault to every mint on Solana, which is not a state any production vault should reach silently.
- **Flip to default-deny silently without a migration path.** Rejected — some devnet vaults may genuinely rely on the current semantics for integration-testing purposes. Providing an explicit opt-in wildcard preserves the ergonomic for test contexts without changing the default.
- **Move the counter to a separate PDA with its own retry logic.** Rejected — over-engineered for the problem. The fix is sequencing, not architecture.
- **Make `execute_token_transfer` atomic-or-panic (no partial state).** It already is, per Solana tx semantics; the audit item is about ordering of reads and mutations within the single atomic handler, not about multi-tx atomicity.

## Consequences

**Positive**: removes the rate-limit DoS fragility; aligns allowlist semantics with secure defaults; makes the handler's validation/mutation boundary auditable at a glance.

**Negative**: existing vaults with an empty `token_allowlist` will **change behavior**: all token transfers start failing after upgrade until the operator adds explicit entries or the wildcard sentinel. This is a policy-behavior change, not a code break, but it is observable.

**Migration path**: the program upgrade ships with a **changelog note** flagged as "BEHAVIOR CHANGE" directing operators to audit their vault policies before upgrading. A companion off-chain script (in `scripts/` — out of scope for this ADR) enumerates all Vault accounts, identifies those with empty `token_allowlist`, and emits a list for operator review. Operators who want to preserve allow-all semantics add the wildcard entry via `update_policy` (existing instruction). Devnet rehearsal mandatory — ties to GOV-6 in the audit. The upgrade itself is single-program and atomic.

## References
- `docs/adr/DEEP-AUDIT-2026-04-22.md` — Audit 1, finding SEC-5
- `docs/adr/ADR-015-token-daily-limits.md` — `TokenSpendRecord` and daily-cap design
- `docs/adr/ADR-006-allowlist-size-caps.md` — allowlist sizing rationale
- `programs/agent-vault/src/instructions.rs:331, 347-352, 365`
- `programs/agent-vault/src/state.rs:110-114`

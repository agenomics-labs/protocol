# ADR-015: Per-Token Daily Spending Limits for Vault

## Status

Accepted

## Date

2026-04-15

## Context

The agent vault enforces a global daily spending limit (`daily_limit_lamports`) for SOL transfers, but SPL token transfers have no per-token daily cap. An agent could exhaust high-value tokens in a single day without any throttle, creating risk for vault owners who delegate spending authority to autonomous agents.

We need per-token daily spending tracking so that each allowlisted token mint is independently capped at the vault's daily limit, preventing runaway token spending.

## Decision

1. Add a `TokenSpendRecord` struct with fields `mint: Pubkey`, `spent_today: u64`, `last_spend_day: u64` to track per-token daily spending.
2. Add a `token_spend_records: Vec<TokenSpendRecord>` field to the `Vault` account, capped at `MAX_TOKEN_SPEND_RECORDS` (10, matching `MAX_TOKEN_ALLOWLIST`).
3. In `execute_token_transfer`, before the CPI transfer:
   - Look up the record for the token mint being transferred.
   - If the day has changed, reset `spent_today` to 0.
   - Verify `spent_today + amount <= daily_limit_lamports`.
   - Update `spent_today` with the new cumulative amount.
   - If no record exists, create one (enforcing the capacity cap).
4. Add two new error variants: `TokenDailyLimitExceeded` and `TokenSpendRecordsFull`.
5. Reuse the existing `daily_limit_lamports` policy field as a universal daily cap for both SOL and token transfers.

## Alternatives Considered

- **Separate per-token limits**: A dedicated limit per mint would give finer control but adds complexity to the policy struct and instruction interface. Deferred to a future ADR if needed.
- **Off-chain enforcement**: Relying on the agent's off-chain logic to self-limit is insufficient for trustless vault security.
- **Separate account for records**: Using a dedicated PDA account for spend records would allow unlimited tokens but increases account management complexity. The 10-entry cap is sufficient for the current allowlist size.

## Consequences

- Each SPL token transfer now checks and updates the per-token daily spend record, adding a small amount of compute per transaction.
- Vault account size increases by up to ~480 bytes (10 records * 48 bytes each) plus vec overhead.
- Vault owners get automatic daily spending protection for every allowlisted token.
- The daily limit is shared across SOL and token transfers (same policy field), keeping the interface simple.

## Files Changed

- `programs/agent-vault/src/lib.rs`: Added `TokenSpendRecord` struct, `token_spend_records` field to `Vault`, daily limit enforcement in `execute_token_transfer`, new error variants, and unit tests.

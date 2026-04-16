# ADR-001: Fix CPI Caller Verification in Registry UpdateReputation

## Status
Accepted

## Date
2026-04-15

## Context
The `update_reputation` instruction in the Agent Registry program is intended to be called exclusively by the Settlement program via Cross-Program Invocation (CPI). The original implementation verified the caller by checking that a passed `settlement_program` account was executable and matched a hardcoded program ID. However, this check was insufficient:

1. Any external caller could pass the Settlement program's account info as a read-only account
2. The `executable` check passes because the Settlement program IS executable on-chain
3. The `require_eq!` check passes because the key matches the constant
4. The `agent_profile` account had no PDA seed verification at the Anchor constraint level

This meant an attacker could call `update_reputation` directly, inflating any agent's reputation score without completing actual work.

## Decision
Replace the weak executable-check pattern with a **PDA-signed CPI** pattern:

1. The Settlement program derives a `settlement_authority` PDA with seeds `["settlement_authority"]`
2. When completing an escrow, Settlement signs the CPI call using `invoke_signed` with this PDA
3. The Registry's `UpdateReputation` context requires `settlement_authority` as a **signer** and verifies its PDA seeds with `seeds::program = SETTLEMENT_PROGRAM_ID`
4. The `agent_profile` account now has full PDA seed verification at the Anchor constraint level

This is cryptographically unforgeable: only the Settlement program can produce a valid signature for its own PDA.

## Alternatives Considered

### Alternative A: Require Settlement program as signer via invoke
Rejected because Solana programs cannot sign transactions directly; only PDAs derived from the program can sign via `invoke_signed`.

### Alternative B: Store authorized caller list on-chain
Rejected as overly complex for a single-caller pattern. A PDA signer is simpler and more secure.

## Consequences

### Positive
- Unauthorized reputation inflation is now cryptographically impossible
- PDA seed verification on `agent_profile` prevents arbitrary account injection
- Pattern is standard Anchor CPI best practice

### Negative
- Settlement program must derive and pass an additional PDA account in the `approve_milestone` instruction
- Existing MCP server code must be updated to include the `settlement_authority` PDA
- Breaking change: existing deployments need coordinated program upgrade

## Files Changed
- `programs/agent-registry/src/lib.rs` - UpdateReputation context rewritten
- `programs/settlement/src/lib.rs` - CPI helper updated to use `invoke_signed`
- `mcp-server/src/index.ts` - `handleApproveMilestone` updated

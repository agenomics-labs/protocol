# ADR-038: Fix C1 — Sandbox execute_program_call to Prevent SPL Token Drain

## Status
Accepted

## Date
2026-04-16 05:15 UTC

## Context
ADR-037 (architecture deep audit) identified a critical vulnerability (C1): the `execute_program_call` instruction injected the vault PDA as a CPI signer, giving any allowlisted program the vault's signing authority. While ADR-024 added post-CPI SOL balance checks, it did not monitor SPL token account balances. An allowlisted program with a "transfer from signer" instruction could drain all vault token accounts.

### Root Cause
The CPI account meta builder contained:
```rust
let is_vault = acc.key() == vault_key;
AccountMeta::new(acc.key(), is_vault || acc.is_signer)
```
This automatically promoted the vault PDA to signer status in every CPI, regardless of whether the target instruction needed the vault's authority.

## Decision
**Remove vault PDA signing from `execute_program_call` entirely.**

The instruction now uses `invoke` (not `invoke_signed`) and preserves only the original signer status of each account — the vault PDA is never injected as a signer. Financial operations must go through the dedicated, policy-enforced instructions:

- `execute_transfer` — SOL transfers with daily/per-tx limits
- `execute_token_transfer` — SPL token transfers with allowlist + daily limits

`execute_program_call` is now a **read/interact** instruction for non-financial CPI (oracle queries, governance voting, data reads) where the agent's own keypair provides authorization to the target program.

## Alternatives Considered

### Alternative A: Snapshot all vault token account balances before/after CPI
Technically possible but requires passing all vault token accounts as `remaining_accounts`, which is complex, expensive in compute units, and error-prone (missing a token account = undetected drain).

### Alternative B: Add a per-CPI token spending limit parameter
Adds complexity without eliminating the fundamental risk — the vault PDA's signing authority still leaks to the target program.

### Alternative C: Remove execute_program_call entirely
Considered but rejected — agents need non-financial CPI for legitimate use cases (oracle reads, governance participation). The unsigned CPI variant is safe and useful.

## Consequences

### Positive
- Vault PDA signing authority can never be exploited by allowlisted programs
- SPL token drain attack is eliminated at the architecture level, not just mitigated
- Simpler implementation — no balance snapshots, no post-CPI checks needed
- Clear separation: financial operations have dedicated instructions with policy enforcement

### Negative
- Breaking change: any integration relying on vault PDA as CPI signer must migrate to `execute_transfer` or `execute_token_transfer`
- Programs that require the vault as authority (e.g., DeFi protocols) need the agent to set up separate authority delegation

## Files Changed
- `programs/agent-vault/src/lib.rs` — `execute_program_call` rewritten to use `invoke` without PDA signing; `AuditEntry` dead struct removed

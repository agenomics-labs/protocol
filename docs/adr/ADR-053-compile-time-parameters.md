# ADR-053: Compile-Time Protocol Parameters — v2 Governance Roadmap

## Status
Accepted

## Date
2026-04-17

## Context

All protocol parameters are compile-time Rust constants. Any change requires program redeployment via the multisig upgrade authority. The current constants are:

**Settlement:**
- `MIN_ESCROW_AMOUNT`: 10,000 lamports
- `DISPUTE_TIMEOUT_SECONDS`: 604,800 (7 days)
- `REPUTATION_DELTA_TASK_COMPLETED`: +50
- `REPUTATION_DELTA_DISPUTE_LOSS`: -25
- `REPUTATION_DELTA_EXPIRY_UNDELIVERED`: -10

**Vault:**
- `MAX_TOKEN_ALLOWLIST`: 10
- `MAX_PROGRAM_ALLOWLIST`: 10
- `MAX_TOKEN_SPEND_RECORDS`: 10

**Registry:**
- Slash threshold: 3 slashes triggers `Suspended` status (hardcoded in `update_reputation` logic)

## Decision

Compile-time constants are acceptable for v1. Dynamic governance via an on-chain config account is deferred to v2.

### Rationale

1. **Transaction overhead**: A `GlobalConfig` PDA would need to be passed as an account to every instruction that reads a parameter. This increases transaction size and account lock contention.
2. **Complexity**: Runtime config requires validation logic, admin authority checks, and migration handling — all for parameters that rarely change.
3. **Calibration**: The current values are well-calibrated based on testing and documented in code. Redeployment via multisig is a sufficient change mechanism for v1 scale.

## v2 Sketch

Introduce a `GlobalConfig` PDA owned by a multisig admin authority:

```rust
#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,             // multisig
    pub min_escrow_amount: u64,
    pub dispute_timeout: i64,
    pub rep_delta_completed: i64,
    pub rep_delta_dispute_loss: i64,
    pub rep_delta_expiry: i64,
    pub max_token_allowlist: u8,
    pub max_program_allowlist: u8,
    pub slash_threshold: u8,
}
```

- `initialize_config`: Called once by deploy authority; sets initial values matching current constants.
- `update_config`: Admin-only; updates individual fields with range validation.
- Instructions fetch config at runtime instead of referencing constants.
- Default values (matching v1 constants) used if config account is not provided, enabling backward-compatible rollout.

## Consequences

### Positive
- No runtime overhead in v1 — constants are inlined by the compiler
- No additional account required in any transaction
- Parameters are auditable directly in source code
- Clear v2 upgrade path documented

### Negative
- Any parameter change requires a full program upgrade cycle (build, test, multisig approval, deploy)
- Cannot respond quickly to market conditions (e.g., adjusting dispute timeout)
- Different programs may define overlapping constants that drift out of sync

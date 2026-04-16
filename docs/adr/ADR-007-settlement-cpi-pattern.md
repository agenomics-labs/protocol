# ADR-007: Improve Settlement-to-Registry CPI Pattern

## Status
Accepted

## Date
2026-04-15

## Context
The Settlement program's `update_provider_reputation` helper used a manual CPI pattern with several fragility risks:

1. **Hardcoded discriminator**: `[194, 220, 43, 201, 54, 209, 49, 178]` — manually computed from `sha256("global:update_reputation")[..8]`. Any namespace change in the Registry would silently break this.
2. **Manual instruction building**: Raw `Vec<u8>` data construction with manual byte layout
3. **`invoke` instead of `invoke_signed`**: The old pattern passed the Settlement program's executable account as a read-only reference, which the Registry checked for executability — insufficient for CPI caller verification (see ADR-001)

## Decision
Refactor the CPI to use **PDA-signed invocation**:

1. **Settlement authority PDA**: Seeds `["settlement_authority"]` derived from the Settlement program ID
2. **`invoke_signed`**: The Settlement program signs with its authority PDA, which the Registry verifies as a signer with `seeds::program = SETTLEMENT_PROGRAM_ID`
3. **Retained manual discriminator**: While an Anchor CPI crate would be ideal, it requires publishing the Registry as a separate crate and managing cross-program dependency versions. The manual discriminator is acceptable because:
   - It's a stable Anchor convention (`sha256("global:{fn_name}")[..8]`)
   - It's documented with a comment
   - It would fail loudly (instruction not found) if the Registry instruction changes

### Why not a full Anchor CPI crate?
Anchor CPI crates (`use agent_registry::cpi::*`) require:
- Publishing the Registry as a crate or path dependency
- Keeping ABI compatibility across program upgrades
- Additional build complexity

For a single CPI call with a stable interface, the manual pattern with PDA signing provides sufficient safety.

## Consequences

### Positive
- CPI caller identity is now cryptographically verified (PDA signer)
- Eliminates the weak "executable account" verification pattern
- Compatible with ADR-001's Registry-side verification

### Negative
- Discriminator is still hardcoded (mitigated by documentation and loud failure mode)
- If Anchor changes discriminator convention, both programs need coordinated update

## Files Changed
- `programs/settlement/src/lib.rs` - `update_provider_reputation` rewritten with `invoke_signed`
- `programs/settlement/src/lib.rs` - `ApproveMilestone` context updated with `settlement_authority` PDA

# ADR-049: Split Programs into Modules

## Status
Accepted

## Date
2026-04-16

## Context
All three Solana programs were single-file monoliths exceeding 1,000 lines each (vault: 1,340, registry: 1,034, settlement: 1,431). The CLAUDE.md convention says "Keep files under 500 lines." Large single files make auditing harder, increase merge conflict risk, and reduce readability.

## Decision
Split each program into Anchor-convention modules:

| Module | Contents |
|--------|----------|
| `state.rs` | Account structs, enums, constants, helper impls |
| `errors.rs` | Error code enum |
| `events.rs` | Event structs |
| `contexts.rs` | `#[derive(Accounts)]` instruction contexts |
| `instructions.rs` | Instruction handler logic |
| `lib.rs` | `declare_id!`, module declarations, `#[program]` thin wrappers, tests |

### Result

| Program | Before | After (largest file) |
|---------|--------|---------------------|
| Agent Vault | 1,340 lines | 511 (instructions.rs) |
| Agent Registry | 1,034 lines | 286 (lib.rs) |
| Settlement | 1,431 lines | 706 (instructions.rs) |

All `pub` visibility was set correctly for cross-module access. `VaultPolicy` methods changed from `fn` to `pub fn`. The `instructions` module uses `crate::` imports for sibling modules.

## Consequences

### Positive
- No file exceeds ~700 lines (down from 1,400+)
- Auditors can review state, errors, and contexts independently
- Merge conflicts are localized to the module being changed
- Follows standard Anchor project conventions

### Negative
- More files to navigate (6 per program instead of 1)
- Cross-module imports add a few lines of boilerplate

## Files Changed
- `programs/agent-vault/src/` — Split into 6 modules
- `programs/agent-registry/src/` — Split into 5 modules (no separate instructions.rs, logic stays in lib.rs)
- `programs/settlement/src/` — Split into 6 modules

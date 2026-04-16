# ADR-013: Upgrade to Anchor 0.31+

## Status
Accepted

## Date
2026-04-15

## Context
The project was using Anchor 0.30.1 which had a critical toolchain issue: `anchor-syn` 0.30.1 calls `proc_macro2::Span::source_file()`, a method removed from Rust's proc-macro API in Rust 1.83+. This made IDL generation impossible on modern Rust stable, requiring either:
- Pinning to Rust 1.79.0 (which broke as transitive deps adopted edition 2024)
- Building with `--no-idl` and manually generating IDL files

Anchor 0.31.1 resolves this by updating `anchor-syn` to use stable proc-macro2 APIs.

## Decision
Upgrade all three programs from Anchor 0.30 to 0.31.1:

1. **Rust crates**: `anchor-lang` and `anchor-spl` upgraded from `0.30` to `0.31.1`
2. **JS client**: `@coral-xyz/anchor` upgraded from `0.30.0` to `0.31.1`
3. **CLI**: Kept at `0.30.1` — the 0.31.x npm CLI packages have binary version mismatch bugs. The CLI version doesn't affect program compilation.
4. **`solana-program` removed**: Anchor 0.31.1 re-exports `solana-program` through `anchor_lang::solana_program`. Removing the explicit dependency resolved a `zeroize` version conflict between `solana-program v1.18` and `anchor-spl v0.31.1` (which pulls `solana-pubkey v2.x`).

### IDL Format Change
Anchor 0.31 generates IDLs with snake_case instruction names (e.g., `initialize_vault`) instead of camelCase (`initializeVault`). The `@coral-xyz/anchor` JS client 0.31.1 handles this automatically.

### Deprecation Warnings
Anchor 0.31 deprecates `AccountInfo::realloc()` in favor of `AccountInfo::resize()`. These warnings come from Anchor's internal derive macros, not our code, and are cosmetic.

## Alternatives Considered

### Alternative: Anchor 1.0.0
`anchor-lang` 1.0.0 exists on crates.io but is designed for the Solana v2 SDK ecosystem. No matching CLI exists yet, and migration would require significant refactoring. Deferred until the ecosystem stabilizes.

### Alternative: Stay on 0.30 with manual IDL workarounds
Rejected because the proc-macro2 incompatibility creates ongoing maintenance burden and the manual IDL generation was error-prone.

## Consequences

### Positive
- `anchor build` now generates IDLs natively on Rust stable
- No more `rust-toolchain.toml` version pinning
- No more proc-macro2 workarounds
- All 35 unit tests and 31 integration tests pass

### Negative
- CLI remains at 0.30.1 due to npm packaging issues in 0.31.x
- `AccountInfo::realloc` deprecation warnings (cosmetic, from Anchor internals)
- IDL format change (snake_case) — existing consumers must use matching JS client version

## Files Changed
- `programs/agent-vault/Cargo.toml` — anchor-lang/spl 0.31.1, removed solana-program
- `programs/agent-registry/Cargo.toml` — anchor-lang/spl 0.31.1, removed solana-program
- `programs/settlement/Cargo.toml` — anchor-lang/spl 0.31.1, removed solana-program
- `mcp-server/package.json` — @coral-xyz/anchor 0.31.1

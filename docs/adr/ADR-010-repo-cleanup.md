# ADR-010: Remove Stray Build Artifacts and Clean Repository

## Status
Accepted

## Date
2026-04-15

## Context
The repository root contained `libprobe.rlib`, a Rust library artifact that was accidentally committed. This file:

1. Has no purpose in the repository (not referenced by any build configuration)
2. Is a binary file that inflates repository size
3. Suggests the `.gitignore` was missing coverage for `.rlib` files

Additionally, the `rust-toolchain.toml` pinned Rust to 1.79.0 due to a `proc-macro2` compatibility issue with Anchor 0.30.1. This pin became untenable as transitive dependencies (`cpufeatures`, `toml_datetime`, `blake3`) began requiring Rust edition 2024 features.

## Decision

### Artifact cleanup
1. Remove `libprobe.rlib` from the repository
2. Add `*.rlib` to `.gitignore` to prevent future accidental commits

### Toolchain update
1. Update `rust-toolchain.toml` from `channel = "1.79.0"` to `channel = "stable"`
2. Build with `anchor build --no-idl` since IDL generation triggers the `proc-macro2` issue
3. Existing IDL files in `target/idl/` are preserved and used by the MCP server

The `proc-macro2` issue (anchor-syn 0.30.1 uses `Span::source_file()` removed in proc-macro2 >= 1.0.95) only affects IDL generation, not program compilation. IDLs are generated once and checked in or preserved in the build directory.

## Consequences

### Positive
- Repository is cleaner
- Modern Rust stable toolchain supports all current crate ecosystem
- No more cascading dependency pin failures

### Negative
- IDL regeneration requires either pinning proc-macro2 or using `--no-idl`
- Future Anchor 0.30.x updates may fully resolve the proc-macro2 issue

## Files Changed
- `libprobe.rlib` - Removed
- `.gitignore` - Added `*.rlib`
- `rust-toolchain.toml` - Updated to stable

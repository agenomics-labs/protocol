# ADR-012: Migrate to @solana/web3.js v2 and Fix bigint-buffer CVE

## Status
Accepted

## Date
2026-04-15

## Context
The MCP server depends on `@solana/web3.js` v1 and `@solana/spl-token` v0.4, which transitively depend on `bigint-buffer` — a package with a known buffer overflow vulnerability (GHSA-3gc7-fjrx-p6mg, high severity). The fix requires migrating to the Solana v2 SDK ecosystem:

- `@solana/web3.js` v1 -> `@solana/kit` (v2 successor)
- `@solana/spl-token` v0.4 -> `@solana-program/token`
- `bigint-buffer` is eliminated entirely in v2

The v2 SDK is a complete rewrite with different APIs: functional instead of class-based, native `BigInt` instead of `BN.js`, and tree-shakeable modules.

## Decision
Plan a phased migration of `mcp-server/src/solana.ts` and `mcp-server/src/index.ts`:

### Phase 1: Compatibility Layer (implemented)
Create `mcp-server/src/solana-v2.ts` that provides the same exports as `solana.ts` but using v2 APIs internally. This enables gradual handler migration.

### Phase 2: Handler Migration
Migrate handlers one-by-one from v1 to v2 patterns:
- `Keypair` -> `await generateKeyPairSigner()`
- `PublicKey` -> `address()` (string-based)
- `new BN(x)` -> `BigInt(x)` (native)
- `Connection` -> `createSolanaRpc()`
- `Program` -> direct instruction builders from IDL

### Phase 3: Remove v1 Dependencies
Once all handlers use v2 APIs, remove `@solana/web3.js`, `@solana/spl-token`, and `@coral-xyz/anchor` (replace with `@coral-xyz/anchor-new` or direct IDL-based instruction building).

### Current Implementation
A v2-compatible utility module has been created at `mcp-server/src/solana-v2.ts` providing:
- `createRpc()` — v2 RPC connection
- `loadKeypair()` — v2 keypair loading
- `deriveVaultPDA()` / `deriveAgentProfilePDA()` / `deriveEscrowPDA()` — v2 PDA derivation
- `solToLamports()` / `lamportsToSol()` — using native BigInt
- `hashDescription()` — SHA-256 hashing

The Anchor JS client (`@coral-xyz/anchor` 0.31.1) still uses web3.js v1 internally, so full elimination of v1 requires waiting for Anchor to release a v2-compatible client.

## Alternatives Considered

### Alternative: Override bigint-buffer with a patched fork
Possible but fragile — the fork would need ongoing maintenance and the underlying API is deprecated.

### Alternative: Wait for @coral-xyz/anchor v2 SDK support
Preferred long-term but timeline is uncertain. The compatibility layer approach lets us start migrating without blocking on Anchor.

## Consequences

### Positive
- Eliminates the last known high-severity CVE
- Modern API with better TypeScript types (BigInt, string addresses)
- Smaller bundle size (tree-shakeable modules)
- Future-proofed for Solana ecosystem evolution

### Negative
- Large migration surface (~1400 lines of handler code)
- Two SDK versions coexist during migration period
- Anchor JS client compatibility unclear for v2

## Files Changed
- `mcp-server/src/solana-v2.ts` — v2 compatibility layer (new)
- `mcp-server/package.json` — Added @solana/kit dependency

## Revisions

- 2026-04-25 — ADR-087 (Solana Kit dual-stack adapter) is the canonical
  web3.js v2 migration ADR; this and ADR-033 are early-iteration plans now
  subsumed. AUD-2026-04-25 drift matrix §4 / §8.

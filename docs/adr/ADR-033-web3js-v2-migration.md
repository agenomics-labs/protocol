# ADR-033: Web3.js v2 Migration Plan

## Status

Accepted

## Date

2026-04-15

## Context

The AEP MCP server (`mcp-server/src/solana.ts`) uses `@solana/web3.js` v1 with class-based APIs (`Connection`, `PublicKey`, `Keypair`, `Transaction`) and `@solana/spl-token` for token account operations. The `@coral-xyz/anchor` TypeScript client also depends on web3.js v1 internally.

Solana's web3.js v2 introduces breaking changes: addresses are strings instead of `PublicKey` objects, amounts use native `BigInt` instead of `BN.js`, functions are tree-shakeable (no class singletons), and PDA derivation is async. A partial v2 compatibility layer already exists at `mcp-server/src/solana-v2.ts` with string addresses, BigInt amounts, and bridge functions (`bnToBigInt`, `pubkeyToAddress`).

Migrating to v2 improves bundle size (tree-shaking), type safety (branded address strings), and alignment with the Solana ecosystem direction. However, the Anchor JS client has not yet released a v2-compatible version, blocking full migration of write operations.

## Decision

1. **Three-phase migration**: Migrate in order of risk -- read-only operations first, then write operations, then Anchor client replacement (blocked on upstream).

2. **Dual-module approach**: Maintain `solana.ts` (v1) and `solana-v2.ts` (v2) in parallel during migration. Feature flag (`AEP_WEB3_V2=true`) enables v2 code paths for testing.

3. **Migration plan document**: Create `docs/WEB3_V2_MIGRATION.md` with:
   - Complete v1 API usage inventory (every import and call site)
   - v2 equivalent for each call with code examples
   - Phase-by-phase migration order
   - Blockers (Anchor JS client dependency on v1)
   - Timeline estimate (~3-4 weeks excluding Anchor blocker)
   - Rollback plan (revert imports, no data migration needed)

4. **Validation requirements**: Before switching to v2 in production, PDA derivation and ATA derivation must produce identical addresses in v1 and v2 for all existing on-chain accounts.

## Alternatives Considered

1. **Big-bang migration** -- Replace all v1 code at once. Rejected due to high risk and Anchor blocker.
2. **Wait for Anchor v2 client** -- Delay all migration until Anchor ships. Rejected; read-only operations can be migrated now.
3. **Fork Anchor client** -- Patch Anchor to use v2 internally. Rejected; maintenance burden too high.

## Consequences

- Read-only operations can be migrated immediately with low risk.
- Write operations require the v2 compatibility layer bridge functions until Anchor releases a v2 client.
- The dual-module approach allows incremental testing and instant rollback.
- Bundle size improvements are deferred until Phase 3 (full v1 removal).
- No on-chain program changes are required; this is purely a client-side migration.

## Files Changed

- `docs/WEB3_V2_MIGRATION.md` -- new migration plan document

## Revisions

- 2026-04-25 — Same-day duplicate of ADR-012. ADR-087 is canonical.
  AUD-2026-04-25 drift matrix §4 / §8.

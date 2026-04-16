# ADR-048: Complete solana-v2.ts Compatibility Layer

## Status
Accepted

## Date
2026-04-16

## Context
`mcp-server/src/solana-v2.ts` was introduced as a v2-style compatibility layer but only contained amount conversion utilities (`solToLamports`, `lamportsToSol`), a SHA-256 hashing helper, and address validation. It lacked PDA derivation, connection creation, and keypair loading -- the three capabilities required to actually use the module in place of `solana.ts` during migration.

## Decision
Add the missing functionality to `solana-v2.ts` so it becomes a complete bridge module:

1. **PDA derivation** (`deriveVaultPDAv2`, `deriveAgentProfilePDAv2`, `deriveEscrowPDAv2`, `deriveEscrowTokenAccountv2`) -- mirrors the four PDA helpers in `solana.ts` but accepts and returns plain strings instead of `PublicKey` objects. Uses `PublicKey.findProgramAddressSync` from the installed `@solana/web3.js` v1 as a bridge until the full `@solana/kit` v2 package is adopted.

2. **Connection helper** (`createConnection`) -- creates a `Connection` with configurable RPC URL, defaulting to `SOLANA_RPC_URL` env var or devnet. Unlike the singleton pattern in `solana.ts`, each call returns a fresh instance to support tree-shakeable, functional usage.

3. **Keypair loading** (`loadKeypairv2`) -- loads a JSON secret-key file from a given path, `SOLANA_KEYPAIR_PATH`, or the default Solana CLI location.

All new functions follow the v2 convention of using string addresses and BigInt amounts. The existing `solana.ts` module is unchanged.

## Consequences
- Handlers can begin importing from `solana-v2.ts` for new code while existing handlers continue using `solana.ts`.
- When `@solana/kit` v2 is installed, the `PublicKey.findProgramAddressSync` bridge calls can be replaced with `getProgramDerivedAddress` without changing the public API signatures.
- No runtime behaviour change for existing code.

## Files Changed
- `mcp-server/src/solana-v2.ts`

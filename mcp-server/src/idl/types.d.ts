/**
 * ADR-088: Anchor IDL types — re-exported from `target/types/*.ts`.
 *
 * This `.d.ts` re-export shim is the seam that lets `mcp-server` consume
 * Anchor's generated typing surface without violating its own
 * `compilerOptions.rootDir`. tsc treats `.d.ts` re-exports as pure type
 * declarations: they do not emit JavaScript and they do not pull the
 * referenced source file into the program's emit graph (only the type
 * graph), so TS6059 ("file is not under rootDir") never fires.
 *
 * The referenced files at `../../../target/types/*.ts` are produced by
 * `anchor build` from the on-chain Rust programs' IDLs. They stay in
 * lockstep with the deployed binaries and are the single source of truth
 * for `Program<IDL>` typing throughout this package.
 *
 * Build dependency: `anchor build` MUST run before `npm --prefix
 * mcp-server run build`. CI's existing Anchor Build job satisfies this;
 * fresh local checkouts must run `anchor build` once.
 */

export type { AgentRegistry } from "../../../target/types/agent_registry";
export type { AgentVault } from "../../../target/types/agent_vault";
export type { Settlement } from "../../../target/types/settlement";

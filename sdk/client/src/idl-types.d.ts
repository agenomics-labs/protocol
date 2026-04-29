/**
 * MCP-323 (Batch G) — re-export shim for Anchor's IDL typed shapes.
 *
 * Same pattern as `mcp-server/src/idl/types.d.ts` (ADR-088): a `.d.ts`
 * re-export brings the `target/types/*.ts` declarations into the
 * sdk/client package's type graph WITHOUT pulling them into the emit
 * graph (so `compilerOptions.rootDir` is not violated). The referenced
 * files are produced by `anchor build` from the on-chain Rust programs'
 * IDLs and stay in lockstep with the deployed binaries.
 *
 * Build dependency: `anchor build` MUST run before `npm --prefix
 * sdk/client run build`.
 */

export type { AgentRegistry } from "../../../target/types/agent_registry";
export type { AgentVault } from "../../../target/types/agent_vault";
export type { Settlement } from "../../../target/types/settlement";

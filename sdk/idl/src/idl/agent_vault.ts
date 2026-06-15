import AgentVaultJson from "./agent_vault.json" with { type: "json" };

/**
 * Anchor IDL for the AgentVault program.
 *
 * Cast to `Idl` from `@anchor-lang/core` when constructing a typed `Program`:
 * ```ts
 * import type { Idl } from "@anchor-lang/core";
 * const program = new Program(AgentVaultIdl as unknown as Idl, provider);
 * ```
 */
export const AgentVaultIdl = AgentVaultJson;

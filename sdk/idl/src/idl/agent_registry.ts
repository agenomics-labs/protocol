import AgentRegistryJson from "./agent_registry.json" with { type: "json" };

/**
 * Anchor IDL for the AgentRegistry program.
 *
 * Cast to `Idl` from `@coral-xyz/anchor` when constructing a typed `Program`:
 * ```ts
 * import type { Idl } from "@coral-xyz/anchor";
 * const program = new Program(AgentRegistryIdl as unknown as Idl, provider);
 * ```
 */
export const AgentRegistryIdl = AgentRegistryJson;

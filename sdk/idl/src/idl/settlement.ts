import SettlementJson from "./settlement.json" with { type: "json" };

/**
 * Anchor IDL for the Settlement program.
 *
 * Cast to `Idl` from `@coral-xyz/anchor` when constructing a typed `Program`:
 * ```ts
 * import type { Idl } from "@coral-xyz/anchor";
 * const program = new Program(SettlementIdl as unknown as Idl, provider);
 * ```
 */
export const SettlementIdl = SettlementJson;

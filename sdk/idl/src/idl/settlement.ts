import SettlementJson from "./settlement.json" with { type: "json" };

/**
 * Anchor IDL for the Settlement program.
 *
 * Cast to `Idl` from `@anchor-lang/core` when constructing a typed `Program`:
 * ```ts
 * import type { Idl } from "@anchor-lang/core";
 * const program = new Program(SettlementIdl as unknown as Idl, provider);
 * ```
 */
export const SettlementIdl = SettlementJson;

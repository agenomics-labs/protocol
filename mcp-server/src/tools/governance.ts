// ADR-135 — Governance MCP tool descriptor, DERIVED from the
// single-source Zod schema in `actions/governance.ts`.
//
// `verify_protocol_invariants` sweeps a batch of `AgentProfile`
// accounts and re-runs `assert_valid_profile` on-chain. The batch cap
// (MAX_INVARIANT_BATCH = 16, AUD-106) lives in `actions/governance.ts`
// as the single source; the rendered JSON Schema's `maxItems` is now a
// projection of that Zod `.max()` rather than a hand-mirrored literal,
// so the advertised cap and the router-enforced cap cannot diverge.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { renderInputSchema } from "./render-schema.js";
import {
  verifyProtocolInvariantsAction,
  MAX_INVARIANT_BATCH as ACTION_MAX_INVARIANT_BATCH,
} from "../actions/governance.js";

/**
 * Re-export of the single-source batch cap (defined in
 * `actions/governance.ts`) for any pre-ADR-135 importer that read it
 * from this module. New code should import it from
 * `actions/governance.ts` directly.
 */
export const MAX_INVARIANT_BATCH = ACTION_MAX_INVARIANT_BATCH;

export const verifyProtocolInvariantsTool: Tool = {
  name: "verify_protocol_invariants",
  description:
    "Run the post-migration / governance invariant sweep over a batch of " +
    "agent-profile accounts. Re-deserialises each profile and runs " +
    "`assert_valid_profile` on-chain; any violation reverts the transaction " +
    "(making the failure loud and the offending account index visible in " +
    "program logs). The batch is hard-capped at " +
    `${MAX_INVARIANT_BATCH} accounts per call (AUD-106) — slice large ` +
    "sweeps into multiple calls. On-chain authorization is " +
    "`ProtocolConfig.authority` (Settlement program); the MCP-layer claim " +
    "`gov:invariant:check` is the default-deny wall (ADR-058 §4).",
  inputSchema: renderInputSchema(verifyProtocolInvariantsAction.inputSchema),
};

// Surface 2 — `pay_x402_service` MCP tool descriptor (SCAFFOLD).
//
// ADR-135: DERIVED from the single-source Zod schema in
// `actions/pay-x402-service.ts`. Pre-ADR-135 this file hand-mirrored
// the IC-3 contract as a JSON Schema literal that had to be kept in
// sync with the Zod schema the router enforces. The `inputSchema` is
// now `renderInputSchema(<action Zod shape>)`, so the advertised and
// enforced contracts are projections of ONE schema. (The Zod schema
// also carries the optional `nonce` idempotency field that the
// pre-ADR-135 hand-written descriptor omitted; ADR-135 makes the
// advertised schema reflect the truthful, router-enforced contract.)

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { renderInputSchema } from "./render-schema.js";
import { payX402ServiceAction } from "../actions/pay-x402-service.js";

export const payX402ServiceTool: Tool = {
  name: "pay_x402_service",
  description:
    "Make an authenticated payment to an x402-protected service URL on " +
    "behalf of an AEP-registered agent. Wraps an x402 client, debits the " +
    "agent's Vault, settles via CDP Facilitator on Base, and returns the " +
    "response + receipt. The `reasoning` field is mandatory — it captures " +
    "the agent's natural-language justification and is the primary AWS " +
    "judging-criterion artifact (see spec IC-3, line 136). " +
    "STATUS: Surface 2 scaffold (stub) — real x402 / CDP integration lands " +
    "Day 3–7 per docs/aep-reflex-tech-spec.md §'Surface 2'.",
  inputSchema: renderInputSchema(payX402ServiceAction.inputSchema),
};

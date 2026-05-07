// Surface 2 — `pay_x402_service` MCP tool descriptor (SCAFFOLD).
//
// JSON-Schema descriptor for the `pay_x402_service` tool. Mirrors the IC-3
// contract from docs/aep-reflex-tech-spec.md lines 109–137. The actual
// handler + zod schema live in `../actions/pay-x402-service.ts`; the
// router synthesizes a JSON Schema from the zod shape, so this file's
// `inputSchema` is hand-mirrored only for clients that consume
// `tools/list` directly without going through `actionRouter`.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
  inputSchema: {
    type: "object",
    properties: {
      agent_address: {
        type: "string",
        description:
          "AEP-registered agent (the spender), base58-encoded Solana pubkey.",
      },
      service_url: {
        type: "string",
        format: "uri",
        description: "x402-protected URL to call.",
      },
      max_price_usdc_micros: {
        type: "integer",
        exclusiveMinimum: 0,
        description:
          "Hard cap on the payment in USDC micros (10^-6 USDC). Tool " +
          "refuses if the x402 quote exceeds this value.",
      },
      request: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
        },
        required: ["method"],
      },
      reasoning: {
        type: "string",
        minLength: 1,
        description:
          "Mandatory natural-language justification for this call. Empty " +
          "reasoning is rejected (spec IC-3, line 136).",
      },
    },
    required: [
      "agent_address",
      "service_url",
      "max_price_usdc_micros",
      "request",
      "reasoning",
    ],
  },
};

import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * Governance Tools (1) — protocol-wide instructions whose signer is the
 * upgrade-authority / multisig rather than a domain-scoped admin.
 *
 * AUD-206 (cycle-3, roadmap §3 B2): typed MCP-tool wrapper for
 * `verify_protocol_invariants`. The on-chain ix sweeps a batch of
 * `AgentProfile` accounts and re-runs `assert_valid_profile` over each.
 * Bounded by MAX_INVARIANT_BATCH = 16 (AUD-106).
 */

/**
 * Mirror of the schema-layer cap in `actions/governance.ts`. Exposed in
 * the JSON schema's `maxItems` so MCP clients see the limit in their
 * tool-list response and can refuse oversized batches before submission.
 */
export const MAX_INVARIANT_BATCH = 16 as const;

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
  inputSchema: {
    type: "object",
    properties: {
      accounts: {
        type: "array",
        items: {
          type: "string",
          description: "Base58-encoded `AgentProfile` PDA pubkey",
        },
        minItems: 1,
        maxItems: MAX_INVARIANT_BATCH,
        description:
          `Batch of agent-profile PDAs to sweep (1-${MAX_INVARIANT_BATCH}). ` +
          "AUD-106: the on-chain handler enforces the same upper bound.",
      },
    },
    required: ["accounts"],
  },
};

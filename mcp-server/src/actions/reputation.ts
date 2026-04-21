/**
 * ADR-061 `get_agent_reputation` read action.
 *
 * Merges the on-chain Registry `AgentProfile` with the ADR-060 capability
 * manifest and the optional ADR-061 SAS attestation signal. Read-only; per
 * ADR-058 §4 the capability gate is bypassed for readOnly actions.
 */

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import { handleGetAgentReputation } from "../handlers/reputation.js";

function wrap<I>(fn: (args: Record<string, unknown>) => Promise<any>) {
  return async (_ctx: any, input: I) => {
    try {
      return ok(await fn(input as unknown as Record<string, unknown>));
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

const getAgentReputationInput = {
  agentAddress: z.string().optional(),
} as const;

export const getAgentReputationAction: Action<
  z.infer<z.ZodObject<typeof getAgentReputationInput>>,
  unknown
> = {
  name: "get_agent_reputation",
  title: "Get agent reputation snapshot",
  description:
    "Fetches the merged reputation snapshot for an agent: on-chain Registry native state (reputation_score, stake, slash_count, status, avg_rating, total_tasks_completed) + capability manifest summary (fetched from IPFS and validated via @agenomics/capability-manifest-validator) + optional SAS attestation signal (resolved via @agenomics/sas-resolver). Read-only — no on-chain writes.",
  inputSchema: getAgentReputationInput,
  outputSchema: z.unknown(),
  similes: ["reputation", "check agent score", "agent reputation", "agent snapshot"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleGetAgentReputation),
};

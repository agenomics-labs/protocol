// All 5 registry Actions. Wraps existing handlers without logic change.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  handleRegisterAgent,
  handleGetAgentProfile,
  handleUpdateAgentProfile,
  handleDiscoverAgents,
  handleStakeReputation,
} from "../handlers/registry.js";

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

// ---------- register_agent ----------

const registerAgentInput = {
  name: z.string().max(64),
  description: z.string().max(256),
  category: z.string(),
  capabilities: z.array(z.string()).min(1).max(10),
  pricingModel: z.enum(["perTask", "perHour", "perToken"]),
  pricingAmountSol: z.number().nonnegative(),
  acceptedTokens: z.array(z.string()).min(1).max(5),
} as const;

export const registerAgentAction: Action<
  z.infer<z.ZodObject<typeof registerAgentInput>>,
  unknown
> = {
  name: "register_agent",
  title: "Register agent",
  description:
    "Register this agent in the on-chain registry with a name, capabilities, and pricing. The canonical vault PDA is derived and bound to the profile on-chain. Enables discovery by other agents.",
  inputSchema: registerAgentInput,
  outputSchema: z.unknown(),
  similes: ["create profile", "list agent"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:registry"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: wrap(handleRegisterAgent),
};

// ---------- get_agent_profile ----------

const getAgentProfileInput = {
  agentAddress: z.string().optional(),
} as const;

export const getAgentProfileAction: Action<
  z.infer<z.ZodObject<typeof getAgentProfileInput>>,
  unknown
> = {
  name: "get_agent_profile",
  title: "Get agent profile",
  description:
    "Get detailed profile for a specific agent including reputation, pricing, capabilities, and task history.",
  inputSchema: getAgentProfileInput,
  outputSchema: z.unknown(),
  similes: ["look up agent", "agent details"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleGetAgentProfile),
};

// ---------- update_agent_profile ----------

const updateAgentProfileInput = {
  name: z.string().optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  pricingModel: z.enum(["perTask", "perHour", "perToken"]).optional(),
  pricingAmountSol: z.number().optional(),
  acceptedTokens: z.array(z.string()).optional(),
} as const;

export const updateAgentProfileAction: Action<
  z.infer<z.ZodObject<typeof updateAgentProfileInput>>,
  unknown
> = {
  name: "update_agent_profile",
  title: "Update agent profile",
  description:
    "Update this agent's profile. All fields are optional — only provided fields are updated.",
  inputSchema: updateAgentProfileInput,
  outputSchema: z.unknown(),
  similes: ["edit profile", "update agent"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:registry"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: wrap(handleUpdateAgentProfile),
};

// ---------- discover_agents ----------

const discoverAgentsInput = {
  capability: z.string().optional(),
  category: z.string().optional(),
  minReputation: z.number().optional(),
  limit: z.number().int().positive().optional(),
} as const;

export const discoverAgentsAction: Action<
  z.infer<z.ZodObject<typeof discoverAgentsInput>>,
  unknown
> = {
  name: "discover_agents",
  title: "Discover agents",
  description:
    "Search the on-chain registry for agents. Optionally filter by capability or minimum reputation.",
  inputSchema: discoverAgentsInput,
  outputSchema: z.unknown(),
  similes: ["search agents", "find agent"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleDiscoverAgents),
};

// ---------- stake_reputation ----------

const stakeReputationInput = {
  amount: z.number().positive(),
} as const;

export const stakeReputationAction: Action<
  z.infer<z.ZodObject<typeof stakeReputationInput>>,
  unknown
> = {
  name: "stake_reputation",
  title: "Stake reputation",
  description:
    "Stake SOL to back this agent's reputation. Staked SOL can be slashed for misbehaviour. Higher stake signals higher trustworthiness to other agents.",
  inputSchema: stakeReputationInput,
  outputSchema: z.unknown(),
  similes: ["stake", "back reputation"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:registry"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: wrap(handleStakeReputation),
};

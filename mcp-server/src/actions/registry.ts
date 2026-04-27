// All 6 registry Actions. Wraps existing handlers without logic change.
//
// ADR-129 Phase 1 (cycle-3): `find_similar_agents` adds a manifest-similarity
// retrieval primitive backed by the EVO L1 HNSW index. Read-only, gated by
// `read:agent-memory`, no signer required. Falls back to an empty result
// when `AEP_EVO_ENABLED=false` (kill-switch default; ADR-129 §"Migration").

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import { isValidPublicKey } from "../solana.js";
import {
  handleRegisterAgent,
  handleGetAgentProfile,
  handleUpdateAgentProfile,
  handleDiscoverAgents,
  handleStakeReputation,
  handleFindSimilarAgents,
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

// ---------- find_similar_agents (ADR-129 Phase 1) ----------

/**
 * Phase 1 schema. `agent_id` is a base58-encoded Solana pubkey (the seed
 * agent's authority). `top_k` is bounded to [1, 50] — EVO accepts up to
 * 1024 by default but Phase 1's response shape is hydrated against on-
 * chain accounts (one fetchMultiple per call), so 50 is a sane upper bound
 * on the per-call work. `min_similarity` is the cosine floor in [0, 1];
 * the default 0.3 matches EVO's `DEFAULT_MIN_SIMILARITY` (ADR-062 in EVO).
 *
 * The on-chain handler is read-only; this action is intentionally NOT
 * marked `readOnly: true` because we want the capability gate to enforce
 * `read:agent-memory` (the gate skips claims when `readOnly: true`). A
 * read-only action with a non-empty `capabilities[]` would be
 * registration-time invalid per `capability-gated-tool.ts:33-36` — but
 * that check fires the OTHER way (non-readOnly + empty caps), so we just
 * declare `readOnly: false` to make the gate fire on missing claims.
 */
const findSimilarAgentsInput = {
  agent_id: z
    .string()
    .min(32, { message: "agent_id must be a base58-encoded Solana public key" })
    .refine(isValidPublicKey, {
      message: "agent_id must be a base58-encoded Solana public key",
    }),
  top_k: z.number().int().min(1).max(50),
  min_similarity: z.number().min(0).max(1).optional(),
} as const;

export const findSimilarAgentsAction: Action<
  z.infer<z.ZodObject<typeof findSimilarAgentsInput>>,
  unknown
> = {
  name: "find_similar_agents",
  title: "Find similar agents (manifest-similarity, EVO L1)",
  description:
    "ADR-129 Phase 1 — return the K agents whose manifest is cosine-similar " +
    "to the seed agent's, ranked by similarity in EVO's 384-dim ONNX " +
    "embedding space (all-MiniLM-L6-v2). The seed manifest is resolved on- " +
    "chain at call time; each hit is hydrated against the on-chain " +
    "AgentProfile so the response shape mirrors `discover_agents` plus " +
    "`similarity_score` and `memory_id`. Read-only; `read:agent-memory` " +
    "claim required. Returns an empty `similar_agents` array (with " +
    "`skipped: true`) when AEP_EVO_ENABLED is false — the kill-switch " +
    "default. Best-effort: EVO bridge errors surface as PROGRAM_ERROR; " +
    "register_agent's contract is unaffected.",
  inputSchema: findSimilarAgentsInput,
  outputSchema: z.unknown(),
  similes: [
    "find similar manifests",
    "agent manifest similarity",
    "neighbours",
    "k nearest agents",
  ],
  examples: [],
  // NOT readOnly — the capability-gate skips claim enforcement on
  // readOnly:true actions, and we want the `read:agent-memory` claim to
  // gate access. The handler itself performs no on-chain writes.
  readOnly: false,
  capabilities: ["read:agent-memory"],
  // No preflight gate: cluster_health is for on-chain submission paths,
  // and the only on-chain calls here are read-side `fetchNullable` /
  // `fetchMultiple` which fail-soft (drop the hit) without us needing a
  // pre-flight RPC.
  // No signer required — this is a read against EVO + the on-chain
  // registry, no transaction is built.
  requiresSigner: false,
  handler: wrap(handleFindSimilarAgents),
};

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

// ADR-135: `.describe()` carries the MCP-client-visible field docs that
// pre-ADR-135 lived only in the hand-written tools/registry.ts JSON
// Schema. Constraints (max/min/enum) were already router-enforced.
const registerAgentInput = {
  name: z.string().max(64).describe("Agent display name (max 64 characters)"),
  description: z
    .string()
    .max(256)
    .describe("Description of the agent's capabilities (max 256 chars)"),
  category: z
    .string()
    .describe(
      "Primary category (e.g., 'data-analysis', 'trading', 'content-generation')",
    ),
  capabilities: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe("List of capability tags (1-10 tags)"),
  pricingModel: z
    .enum(["perTask", "perHour", "perToken"])
    .describe("How the agent charges for work"),
  pricingAmountSol: z
    .number()
    .nonnegative()
    .describe("Price amount in SOL according to the pricing model"),
  acceptedTokens: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe("Mint addresses of accepted payment tokens (1-5 tokens)"),
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
  agentAddress: z
    .string()
    .optional()
    .describe(
      "Public key (authority) of the agent to look up. If omitted, returns this agent's profile.",
    ),
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
  name: z.string().optional().describe("New agent name"),
  description: z.string().optional().describe("New description"),
  category: z.string().optional().describe("New primary category"),
  capabilities: z
    .array(z.string())
    .optional()
    .describe("New capability tags"),
  pricingModel: z
    .enum(["perTask", "perHour", "perToken"])
    .optional()
    .describe("New pricing model"),
  pricingAmountSol: z.number().optional().describe("New pricing amount in SOL"),
  acceptedTokens: z
    .array(z.string())
    .optional()
    .describe("New accepted token mint addresses"),
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
  capability: z
    .string()
    .optional()
    .describe("Filter by capability tag (partial match)"),
  category: z
    .string()
    .optional()
    .describe("Filter by category (exact match)"),
  minReputation: z.number().optional().describe("Minimum reputation score"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max results to return (default: 20)"),
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
  amount: z
    .number()
    .positive()
    .describe("Amount of SOL to stake for reputation"),
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
 * The on-chain handler is read-only, so this action is correctly declared
 * `readOnly: true`. Per ADR-143 the capability gate is decoupled from
 * `readOnly` — it fires on any non-empty `capabilities[]` — so the
 * `read:agent-memory` claim is still enforced. `sensitiveRead: true`
 * additionally triggers the registration-time assertion that this
 * sensitive read action carries caps. The pre-ADR-143 `readOnly: false`
 * workaround (declared purely to re-enable the gate) is reverted.
 */
const findSimilarAgentsInput = {
  agent_id: z
    .string()
    .min(32, { message: "agent_id must be a base58-encoded Solana public key" })
    .refine(isValidPublicKey, {
      message: "agent_id must be a base58-encoded Solana public key",
    })
    .describe(
      "Base58-encoded authority pubkey of the seed agent. The seed's " +
        "manifest (category, name, capabilities, description) is " +
        "fetched from chain and embedded; results are the K agents " +
        "whose observation embedding is closest by cosine distance.",
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe(
      "Maximum number of similar agents to return (1-50). The seed " +
        "agent is excluded from results, so a top_k of 10 returns up " +
        "to 10 *peers* (not 10 including the seed).",
    ),
  min_similarity: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Cosine-similarity floor in [0, 1]. Default 0.3 (matches EVO's " +
        "ADR-062 default). Hits below this threshold are dropped before " +
        "hydration.",
    ),
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
  // ADR-143: the handler performs no on-chain writes, so this is honestly
  // `readOnly: true`. Capability enforcement is decoupled from `readOnly`
  // — the `read:agent-memory` claim is still gated because
  // `capabilities[]` is non-empty. `sensitiveRead: true` enforces, at
  // registration time, that this sensitive read carries that cap.
  readOnly: true,
  sensitiveRead: true,
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

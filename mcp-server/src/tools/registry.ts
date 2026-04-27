import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * Registry Tools (5) - Agent discovery and reputation
 */

export const registerAgentTool: Tool = {
  name: "register_agent",
  description:
    "Register this agent in the on-chain registry with a name, capabilities, and pricing. The canonical vault PDA (seeds: [\"vault\", authority] under the Agent Vault program) is derived and bound to the profile on-chain. Enables discovery by other agents.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Agent display name (max 64 characters)",
      },
      description: {
        type: "string",
        description: "Description of the agent's capabilities (max 256 chars)",
      },
      category: {
        type: "string",
        description:
          "Primary category (e.g., 'data-analysis', 'trading', 'content-generation')",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "List of capability tags (1-10 tags)",
      },
      pricingModel: {
        type: "string",
        enum: ["perTask", "perHour", "perToken"],
        description: "How the agent charges for work",
      },
      pricingAmountSol: {
        type: "number",
        description: "Price amount in SOL according to the pricing model",
      },
      acceptedTokens: {
        type: "array",
        items: { type: "string" },
        description:
          "Mint addresses of accepted payment tokens (1-5 tokens)",
      },
    },
    required: [
      "name",
      "description",
      "category",
      "capabilities",
      "pricingModel",
      "pricingAmountSol",
      "acceptedTokens",
    ],
  },
};

export const getAgentProfileTool: Tool = {
  name: "get_agent_profile",
  description:
    "Get detailed profile for a specific agent including reputation, pricing, capabilities, and task history.",
  inputSchema: {
    type: "object",
    properties: {
      agentAddress: {
        type: "string",
        description:
          "Public key (authority) of the agent to look up. If omitted, returns this agent's profile.",
      },
    },
  },
};

export const updateAgentProfileTool: Tool = {
  name: "update_agent_profile",
  description:
    "Update this agent's profile. All fields are optional — only provided fields are updated.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "New agent name" },
      description: { type: "string", description: "New description" },
      category: { type: "string", description: "New primary category" },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "New capability tags",
      },
      pricingModel: {
        type: "string",
        enum: ["perTask", "perHour", "perToken"],
        description: "New pricing model",
      },
      pricingAmountSol: {
        type: "number",
        description: "New pricing amount in SOL",
      },
      acceptedTokens: {
        type: "array",
        items: { type: "string" },
        description: "New accepted token mint addresses",
      },
    },
  },
};

export const discoverAgentsTool: Tool = {
  name: "discover_agents",
  description:
    "Search the on-chain registry for agents. Optionally filter by capability or minimum reputation. Returns a list of matching agent profiles.",
  inputSchema: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "Filter by capability tag (partial match)",
      },
      category: {
        type: "string",
        description: "Filter by category (exact match)",
      },
      minReputation: {
        type: "number",
        description: "Minimum reputation score",
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 20)",
      },
    },
  },
};

export const stakeReputationTool: Tool = {
  name: "stake_reputation",
  description:
    "Stake SOL to back this agent's reputation. Staked SOL can be slashed for misbehaviour. Higher stake signals higher trustworthiness to other agents.",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "number",
        description: "Amount of SOL to stake for reputation",
      },
    },
    required: ["amount"],
  },
};

export const getAgentReputationTool: Tool = {
  name: "get_agent_reputation",
  description:
    "Fetches the merged reputation snapshot for an agent: on-chain Registry native state (reputation_score, stake, slash_count, status) + capability manifest summary (fetched from IPFS and validated via @agenomics/capability-manifest-validator) + optional SAS attestation signal (resolved via @agenomics/sas-resolver). Read-only. AUD-007 (PR-Q): the legacy `avg_rating` / `total_tasks_completed` aggregates were removed from the on-chain account; per-task telemetry now belongs to the indexer.",
  inputSchema: {
    type: "object",
    properties: {
      agentAddress: {
        type: "string",
        description:
          "Public key (authority) of the agent to look up. If omitted, returns this agent's snapshot.",
      },
    },
  },
};

/**
 * ADR-129 Phase 1 — manifest-similarity discovery backed by EVO L1 HNSW.
 *
 * The JSON-schema bounds mirror the zod schema in
 * `actions/registry.ts#findSimilarAgentsInput` so MCP clients see the
 * limits in their tool-list response and can refuse out-of-range input
 * before submission. Capability `read:agent-memory` is enforced at the
 * router; that's not surfaced in the schema (capabilities are the
 * router's concern, not the wire schema).
 */
export const findSimilarAgentsTool: Tool = {
  name: "find_similar_agents",
  description:
    "ADR-129 Phase 1 — return the K agents whose manifest is cosine-similar " +
    "to the seed agent's, ranked by similarity in EVO's 384-dim ONNX " +
    "embedding space (all-MiniLM-L6-v2). Read-only; the seed manifest is " +
    "resolved on-chain at call time and each hit is hydrated against the " +
    "on-chain AgentProfile so the response shape mirrors `discover_agents` " +
    "plus `similarity_score` and `memory_id`. Best-effort: returns an " +
    "empty `similar_agents` array (`skipped: true`) when AEP_EVO_ENABLED " +
    "is false (kill-switch default). Capability `read:agent-memory` is " +
    "enforced at the router (ADR-058 §4).",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: {
        type: "string",
        description:
          "Base58-encoded authority pubkey of the seed agent. The seed's " +
          "manifest (category, name, capabilities, description) is " +
          "fetched from chain and embedded; results are the K agents " +
          "whose observation embedding is closest by cosine distance.",
        minLength: 32,
      },
      top_k: {
        type: "integer",
        description:
          "Maximum number of similar agents to return (1-50). The seed " +
          "agent is excluded from results, so a top_k of 10 returns up " +
          "to 10 *peers* (not 10 including the seed).",
        minimum: 1,
        maximum: 50,
      },
      min_similarity: {
        type: "number",
        description:
          "Cosine-similarity floor in [0, 1]. Default 0.3 (matches EVO's " +
          "ADR-062 default). Hits below this threshold are dropped before " +
          "hydration.",
        minimum: 0,
        maximum: 1,
      },
    },
    required: ["agent_id", "top_k"],
  },
};

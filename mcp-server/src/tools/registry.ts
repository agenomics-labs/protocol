// ADR-135 — Registry MCP tool descriptors, DERIVED from the
// single-source Zod schemas in `actions/registry.ts` and
// `actions/reputation.ts`.
//
// See `tools/render-schema.ts` for the rationale. Each `inputSchema`
// below is `renderInputSchema(<action Zod shape>)`, so the advertised
// `tools/list` contract and the runtime-enforced router contract are
// projections of ONE schema. `description` strings are preserved
// verbatim from the pre-ADR-135 hand-written descriptors for wire
// stability; the frozen snapshot test proves the rendered schema.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { renderInputSchema } from "./render-schema.js";
import {
  registerAgentAction,
  getAgentProfileAction,
  updateAgentProfileAction,
  discoverAgentsAction,
  stakeReputationAction,
  findSimilarAgentsAction,
} from "../actions/registry.js";
import { getAgentReputationAction } from "../actions/reputation.js";

/**
 * Registry Tools (7) — agent discovery and reputation. `inputSchema` is
 * derived from the corresponding `actions/*.ts` Zod schema (ADR-135
 * single source of truth).
 */

export const registerAgentTool: Tool = {
  name: "register_agent",
  description:
    "Register this agent in the on-chain registry with a name, capabilities, and pricing. The canonical vault PDA (seeds: [\"vault\", authority] under the Agent Vault program) is derived and bound to the profile on-chain. Enables discovery by other agents.",
  inputSchema: renderInputSchema(registerAgentAction.inputSchema),
};

export const getAgentProfileTool: Tool = {
  name: "get_agent_profile",
  description:
    "Get detailed profile for a specific agent including reputation, pricing, capabilities, and task history.",
  inputSchema: renderInputSchema(getAgentProfileAction.inputSchema),
};

export const updateAgentProfileTool: Tool = {
  name: "update_agent_profile",
  description:
    "Update this agent's profile. All fields are optional — only provided fields are updated.",
  inputSchema: renderInputSchema(updateAgentProfileAction.inputSchema),
};

export const discoverAgentsTool: Tool = {
  name: "discover_agents",
  description:
    "Search the on-chain registry for agents. Optionally filter by capability or minimum reputation. Returns a list of matching agent profiles.",
  inputSchema: renderInputSchema(discoverAgentsAction.inputSchema),
};

export const stakeReputationTool: Tool = {
  name: "stake_reputation",
  description:
    "Stake SOL to back this agent's reputation. Staked SOL can be slashed for misbehaviour. Higher stake signals higher trustworthiness to other agents.",
  inputSchema: renderInputSchema(stakeReputationAction.inputSchema),
};

export const getAgentReputationTool: Tool = {
  name: "get_agent_reputation",
  description:
    "Fetches the merged reputation snapshot for an agent: on-chain Registry native state (reputation_score, stake, slash_count, status) + capability manifest summary (fetched from IPFS and validated via @agenomics/capability-manifest-validator) + optional SAS attestation signal (resolved via @agenomics/sas-resolver). Read-only. AUD-007 (PR-Q): the legacy `avg_rating` / `total_tasks_completed` aggregates were removed from the on-chain account; per-task telemetry now belongs to the indexer.",
  inputSchema: renderInputSchema(getAgentReputationAction.inputSchema),
};

/**
 * ADR-129 Phase 1 — manifest-similarity discovery backed by EVO L1 HNSW.
 * The schema bounds (`top_k` 1-50, `min_similarity` 0-1, `agent_id`
 * minLength 32) are now sourced from the single Zod schema in
 * `actions/registry.ts#findSimilarAgentsInput` — the same schema the
 * router enforces — so the MCP-advertised limits cannot drift from the
 * enforced ones. Capability `read:agent-memory` is enforced at the
 * router (not in the wire schema).
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
  inputSchema: renderInputSchema(findSimilarAgentsAction.inputSchema),
};

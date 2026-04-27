// ADR-129 Phase 1 — domain facade over EvoClient.
//
// The action layer (`actions/registry.ts:findSimilarAgentsAction`) and the
// `handleRegisterAgent` post-success observe BOTH talk to this module —
// not to evo-bridge directly. That gives us one place to:
//
//   1. Translate domain inputs (an agent's authority + manifest) into the
//      free-form text + metadata shape EVO's L1 indexes.
//   2. Translate EVO's retrieval hits back into the SDK-friendly shape
//      `find_similar_agents` returns.
//   3. Hide the kill-switch from callers — when AEP_EVO_ENABLED=false, the
//      facade still resolves cleanly (recordAgentRegistration → void;
//      findSimilarAgents → empty result + `skipped: true` flag).
//
// EVO-specific types stay below this line. Keeping the boundary narrow is
// what lets ADR-129 Phase 2 swap evo-bridge's transport (NAPI) without
// touching the action layer.

import type {
  EvoClient,
  EvoObservation,
  EvoRetrievalQuery,
} from "./evo-bridge.js";
import { getEvoClient } from "./evo-bridge.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "agent-memory" });

// ---------------------------------------------------------------------------
// Domain inputs / outputs
// ---------------------------------------------------------------------------

/**
 * Phase 1 observation shape: when an agent registers, we feed the manifest
 * tuple (authority, name, description, category, capabilities) plus the
 * canonical agent-profile PDA so a future `find_similar_agents` lookup can
 * retrieve back to the on-chain account without an indexer round trip.
 */
export interface AgentRegistrationObservation {
  authority: string;
  agentProfileAddress: string;
  name: string;
  description: string;
  category: string;
  capabilities: string[];
}

export interface FindSimilarAgentsInput {
  /** Authority pubkey of the seed agent. The handler resolves the
   *  on-chain manifest at the call site (Phase 1 keeps the facade pure;
   *  hydration lives in the action handler). */
  queryText: string;
  topK: number;
  minSimilarity: number;
  tokenBudget?: number;
}

export interface SimilarAgentHit {
  /** EVO node id (opaque). Useful for later `learn` credit assignment. */
  memoryId: string;
  /** Cosine similarity in [0, 1]. */
  similarityScore: number;
  /** Authority pubkey, recovered from the observation's metadata. May be
   *  empty if the observation predates this metadata convention — the
   *  caller treats that as "skip." */
  authority: string;
  /** PDA recovered from metadata. Empty when not available. */
  agentProfileAddress: string;
  /** Compact human-readable summary of the original observation. */
  manifestSummary: string;
}

export interface FindSimilarAgentsResult {
  /** True when the kill-switch was OFF and the facade returned an empty
   *  result without invoking the bridge. Lets the action layer surface a
   *  distinct response shape rather than masking the disabled state. */
  skipped: boolean;
  similarAgents: SimilarAgentHit[];
}

// ---------------------------------------------------------------------------
// Facade surface
// ---------------------------------------------------------------------------

export interface AgentMemory {
  /**
   * Best-effort write into EVO's L1. Errors are propagated so callers can
   * decide whether to swallow (the post-register success path does) or
   * surface them. The kill-switch is honoured silently — when disabled
   * this resolves to void without invoking the bridge.
   */
  recordAgentRegistration(observation: AgentRegistrationObservation): Promise<void>;

  /**
   * Query L1 for manifest-similar agents. Returns
   * `{ skipped: true, similarAgents: [] }` when the bridge is disabled,
   * otherwise `{ skipped: false, similarAgents: [...] }`.
   */
  findSimilarAgents(input: FindSimilarAgentsInput): Promise<FindSimilarAgentsResult>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class AgentMemoryFacade implements AgentMemory {
  constructor(private readonly client: EvoClient) {}

  async recordAgentRegistration(
    observation: AgentRegistrationObservation,
  ): Promise<void> {
    if (!this.client.enabled) {
      log.debug(
        { authority: observation.authority },
        "agent-memory: skip observe (EVO disabled)",
      );
      return;
    }
    const evoObservation = toEvoObservation(observation);
    await this.client.observe(evoObservation);
  }

  async findSimilarAgents(
    input: FindSimilarAgentsInput,
  ): Promise<FindSimilarAgentsResult> {
    if (!this.client.enabled) {
      return { skipped: true, similarAgents: [] };
    }
    const query: EvoRetrievalQuery = {
      query: input.queryText,
      topK: input.topK,
      minSimilarity: input.minSimilarity,
      tokenBudget: input.tokenBudget,
    };
    const result = await this.client.retrieve(query);
    const similarAgents: SimilarAgentHit[] = result.hits.map((hit) => ({
      memoryId: hit.id,
      similarityScore: hit.score,
      authority: hit.metadata?.["authority"] ?? "",
      agentProfileAddress: hit.metadata?.["agent_profile_address"] ?? "",
      manifestSummary: summarize(hit.content),
    }));
    return { skipped: false, similarAgents };
  }
}

/**
 * Translate the registration tuple into the free-form text + metadata
 * EVO observes. The text is what the embedder sees — keep it dense and
 * deterministic so two registrations with identical manifests embed
 * identically. Metadata is the structured retrieval payload (kept under
 * EVO's `EVO_MAX_METADATA_VALUE_LEN=8192` per-value cap, ADR-058 in EVO).
 */
function toEvoObservation(observation: AgentRegistrationObservation): EvoObservation {
  const capabilities = observation.capabilities.join(", ");
  // The text is intentionally compact — the embedder doesn't benefit from
  // boilerplate. Keep the most distinguishing fields up front.
  const content =
    `category=${observation.category}\n` +
    `name=${observation.name}\n` +
    `capabilities=${capabilities}\n` +
    `description=${observation.description}`;
  return {
    content,
    metadata: {
      kind: "agent_registration",
      authority: observation.authority,
      agent_profile_address: observation.agentProfileAddress,
      category: observation.category,
      // Store the joined capability list so retrieval hits can reconstruct
      // it without a second on-chain fetch. Bounded by EVO's 8 KiB
      // per-value cap; truncate defensively.
      capabilities: truncate(capabilities, 8000),
      name: truncate(observation.name, 256),
    },
  };
}

function summarize(content: string): string {
  // Single-line summary suitable for SDK clients that won't render
  // multi-line content well. Caps at 200 chars.
  const oneLine = content.replace(/\s+/g, " ").trim();
  return truncate(oneLine, 200);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

// ---------------------------------------------------------------------------
// Module-load singleton + test seam.
// ---------------------------------------------------------------------------

let cachedFacade: AgentMemory | null = null;

export function getAgentMemory(): AgentMemory {
  if (!cachedFacade) {
    cachedFacade = new AgentMemoryFacade(getEvoClient());
  }
  return cachedFacade;
}

/**
 * Test seam. Replace the cached facade (or clear with `null` to force
 * the next call to re-read the singleton EvoClient).
 */
export function setAgentMemory(facade: AgentMemory | null): void {
  cachedFacade = facade;
}

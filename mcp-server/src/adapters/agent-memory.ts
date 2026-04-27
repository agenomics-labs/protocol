// ADR-129 Phase 1 + Phase 2 — domain facade over EvoClient.
//
// The action layer (`actions/registry.ts:findSimilarAgentsAction`,
// settlement handlers) and the `handleRegisterAgent` post-success observe
// ALL talk to this module — not to evo-bridge directly. That gives us one
// place to:
//
//   1. Translate domain inputs (an agent's authority + manifest, a
//      milestone outcome) into the free-form text + metadata + learn
//      shapes EVO's L1 / L2 indexes.
//   2. Translate EVO's retrieval hits back into the SDK-friendly shape
//      `find_similar_agents` returns.
//   3. Hide the kill-switch from callers — when AEP_EVO_ENABLED=false, the
//      facade still resolves cleanly (recordAgentRegistration → void;
//      recordOutcome → void; findSimilarAgents → empty result +
//      `skipped: true` flag).
//
// Phase 2 (cycle-3 cont., this commit) adds `recordOutcome` — the write-
// path companion to Phase 1's read-path observe. Settlement handlers fire
// it AFTER the on-chain ix succeeds (approve_milestone, resolve_dispute,
// resolve_dispute_timeout). Best-effort posture preserved: a learn failure
// never breaks the parent contract — failure is bounded to "this outcome
// silently dropped from L2 strategy formation."
//
// EVO-specific types stay below this line. Keeping the boundary narrow is
// what lets a future bridge transport swap (NAPI) happen without touching
// the action layer.

import type {
  EvoClient,
  EvoLearnOutcome,
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

/**
 * ADR-129 Phase 2 — typed milestone-outcome enum.
 *
 * The four kinds map 1:1 to the on-chain reason codes plumbed by AUD-109 /
 * AUD-113 (`programs/settlement/src/instructions/cpi.rs:54-56`):
 *
 *   - `task_completed`     → REASON_TASK_COMPLETED (0)
 *     Emitted by `approve_milestone` and by `expire_escrow` when all
 *     milestones were already approved before the deadline. Provider got
 *     paid; reputation moved positive.
 *
 *   - `dispute_won`        → REASON_DISPUTE_LOSS (1) for the *client*; for
 *     the provider's perspective EVO records this as success because the
 *     provider received funds. Emitted by `resolve_dispute` when the
 *     resolver awarded a non-zero `provider_payment`. The on-chain reason
 *     code is the same as `dispute_lost` — EVO's split into two outcomes
 *     happens here at the adapter, not on chain — because L2 strategy
 *     formation cares about provider success, not the legal classification.
 *
 *   - `dispute_lost`       → REASON_DISPUTE_LOSS (1).
 *     Emitted by `resolve_dispute` when the resolver awarded zero to the
 *     provider, and unconditionally by `resolve_dispute_timeout` (the
 *     client-default-favouring auto-resolution). Provider's reputation
 *     was slashed via the Settlement→Registry CPI; EVO records the
 *     strategy that led here as a failure for the provider agent.
 *
 *   - `expiry_undelivered` → REASON_EXPIRY_UNDELIVERED (2).
 *     Emitted by `expire_escrow` when one or more milestones were never
 *     submitted past the deadline. Provider's reputation was slashed.
 *     Phase 2 declares this kind even though no MCP handler wraps
 *     `expire_escrow` today (it is on-chain only, see
 *     `programs/settlement/src/lib.rs:101`); the enum stays exhaustive so
 *     a future MCP wrapper can wire it without an enum change.
 *
 * The `success` boolean and `score` ([0,1]) are derived from the kind in
 * `toEvoLearnOutcome` below; callers do NOT need to compute them. Keeping
 * the kind as the wire input means a future score-policy change is one
 * file, not five.
 */
export type MilestoneOutcomeKind =
  | "task_completed"
  | "dispute_won"
  | "dispute_lost"
  | "expiry_undelivered";

/**
 * Phase 2 outcome shape. The `taskId` is the EVO-side task identifier
 * (a free-form string, ≤64 chars per EVO's `EVO_MAX_TASK_ID_LEN` bound,
 * ADR-058 in EVO). Settlement callers pass the escrow PDA + milestone
 * index (e.g. `<escrow_b58>:m<idx>`) so a `learn` and a future `retrieve`
 * keyed on the same task line up.
 *
 * `providerAuthority` is the agent whose reputation moved on chain — the
 * same value the Settlement→Registry CPI passed as `provider_authority`.
 * It is stored in EVO's free-form metadata as a structured pivot so a
 * Phase-3 retrieval can answer "what strategies worked for THIS agent."
 */
export interface MilestoneOutcomeObservation {
  taskId: string;
  kind: MilestoneOutcomeKind;
  providerAuthority: string;
  /** Optional per-call free-form metadata (escrow address, milestone
   *  index, on-chain reason code). All values stringified before going
   *  to EVO; see `toEvoLearnOutcome` for the reason-code mirror. */
  metadata?: Record<string, string>;
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

  /**
   * ADR-129 Phase 2 — write-path learn loop on milestone outcomes.
   *
   * Translates a typed `MilestoneOutcomeObservation` into EVO's
   * `evo_learn` shape and forwards it. Errors are propagated so callers
   * can decide whether to swallow (the settlement post-success paths do)
   * or surface them. The kill-switch is honoured silently — when disabled
   * this resolves to void without invoking the bridge.
   *
   * Best-effort contract (mirrors `recordAgentRegistration`):
   *   - The settlement handler wraps the call in try/catch and swallows.
   *   - A learn failure NEVER breaks the parent on-chain ix's success
   *     return. The failure mode is bounded to "this outcome silently
   *     dropped from L2 strategy formation."
   */
  recordOutcome(observation: MilestoneOutcomeObservation): Promise<void>;
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

  async recordOutcome(observation: MilestoneOutcomeObservation): Promise<void> {
    if (!this.client.enabled) {
      log.debug(
        {
          task_id: observation.taskId,
          kind: observation.kind,
          provider_authority: observation.providerAuthority,
        },
        "agent-memory: skip learn (EVO disabled)",
      );
      return;
    }
    // EVO's `evo_learn` MCP schema is strict (additionalProperties: false)
    // and accepts only {task_id, score, success} (`EVO/src/mcp/tools.ts:188`).
    // The rich (provider_agent, kind, reason, escrow, milestone) tuple ADR-129
    // §Phase 2 calls out goes via a companion `observe` so the credit
    // assignment (`learn`) and the operator-visible metadata (`observe`)
    // share the same `task_id` key but use the right EVO surface for each.
    //
    // Observe first so that even if the learn call rejects (surprise gate,
    // rare schema mismatch), the outcome trail still lands in L1.
    const outcomeObs = toOutcomeObservation(observation);
    await this.client.observe(outcomeObs);

    const evoOutcome = toEvoLearnOutcome(observation);
    await this.client.learn(evoOutcome);
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

/**
 * EVO `evo_learn` task-id cap (`EVO_MAX_TASK_ID_LEN`, default 64,
 * `EVO/src/mcp/tools.ts:53`). The protocol's natural composite key is
 * `<escrow_b58>:m<idx>` (44 + 4 ≈ 48 chars) which fits, but we truncate
 * defensively in case a future caller passes a longer composite shape.
 */
const EVO_TASK_ID_MAX_LEN = 64;

/**
 * Static score table for `MilestoneOutcomeKind`. EVO's L2 strategy
 * formation cares about success/failure plus a magnitude — the absolute
 * scale is not load-bearing as long as it is consistent across calls
 * (ADR-019 + ADR-020 in EVO). 1.0 / 0.0 reflects the binary nature of the
 * on-chain outcome; partial-credit shapes can be added in a future
 * Phase-2.x by parameterising on `metadata` (e.g. partial settlements
 * where the provider got a fraction).
 *
 * `dispute_won` is treated as a partial success (0.7) — the provider got
 * paid but had to go through dispute resolution, which a future strategy
 * retrieval should weigh below clean `task_completed`.
 */
const OUTCOME_SCORE_TABLE: Readonly<Record<MilestoneOutcomeKind, { score: number; success: boolean }>> = {
  task_completed: { score: 1.0, success: true },
  dispute_won: { score: 0.7, success: true },
  dispute_lost: { score: 0.0, success: false },
  expiry_undelivered: { score: 0.0, success: false },
};

/**
 * Mirror of the on-chain reason codes
 * (`programs/settlement/src/instructions/cpi.rs:54-56`). Two of our four
 * outcome kinds (`dispute_won`, `dispute_lost`) collapse to the same
 * on-chain reason (1 = REASON_DISPUTE_LOSS) — the on-chain CPI does not
 * distinguish them because the reputation delta is the same. EVO's L2
 * does benefit from the split (see comment on `MilestoneOutcomeKind`).
 */
const OUTCOME_TO_ONCHAIN_REASON: Readonly<Record<MilestoneOutcomeKind, number>> = {
  task_completed: 0,
  dispute_won: 1,
  dispute_lost: 1,
  expiry_undelivered: 2,
};

/**
 * Translate a typed milestone outcome into EVO's `evo_learn` shape.
 *
 * The translation is deterministic: same kind → same (score, success).
 * `taskId` is bounded to EVO's 64-char cap. EVO's `evo_learn` schema is
 * strict (additionalProperties: false, only task_id/score/success) — the
 * rich metadata travels via a companion `observe` (see
 * `toOutcomeObservation`). Both calls share the same `task_id` key so a
 * Phase-3 retrieval can join them.
 */
function toEvoLearnOutcome(observation: MilestoneOutcomeObservation): EvoLearnOutcome {
  const { score, success } = OUTCOME_SCORE_TABLE[observation.kind];
  return {
    taskId: truncate(observation.taskId, EVO_TASK_ID_MAX_LEN),
    score,
    success,
  };
}

/**
 * Build the L1 observation that complements the `learn` call. The text
 * shape mirrors `toEvoObservation`'s "compact key=value lines" so the
 * embedder produces clean, distinguishing vectors. Metadata carries the
 * structured pivot fields (kind, provider_authority, on-chain reason)
 * that a future Phase-3 `agent_memory_query` retrieval projects on.
 */
function toOutcomeObservation(observation: MilestoneOutcomeObservation): EvoObservation {
  const reasonCode = OUTCOME_TO_ONCHAIN_REASON[observation.kind];
  const { score, success } = OUTCOME_SCORE_TABLE[observation.kind];
  const extra = observation.metadata ?? {};
  // Build extras text deterministically (sorted keys) so two outcomes with
  // the same metadata bag embed identically.
  const extraLines = Object.keys(extra)
    .sort()
    .map((k) => `${k}=${extra[k]}`)
    .join("\n");
  const content =
    `kind=outcome:${observation.kind}\n` +
    `provider_authority=${observation.providerAuthority}\n` +
    `task_id=${observation.taskId}\n` +
    `onchain_reason=${reasonCode}\n` +
    `success=${String(success)}\n` +
    `score=${score.toFixed(2)}` +
    (extraLines ? `\n${extraLines}` : "");
  return {
    content,
    metadata: {
      kind: "milestone_outcome",
      outcome_kind: observation.kind,
      provider_authority: observation.providerAuthority,
      task_id: truncate(observation.taskId, EVO_TASK_ID_MAX_LEN),
      onchain_reason: String(reasonCode),
      success: String(success),
      score: score.toFixed(2),
      // Forward caller-supplied metadata, truncated per EVO's 8 KiB
      // per-value cap (matches `toEvoObservation`).
      ...Object.fromEntries(
        Object.entries(extra).map(([k, v]) => [k, truncate(v, 8000)]),
      ),
    },
  };
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

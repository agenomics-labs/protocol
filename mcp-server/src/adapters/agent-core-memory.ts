// Surface 2 — AgentCore Memory write adapter (Surface 2 Day 3).
//
// Spec: docs/aep-reflex-tech-spec.md §"Surface 2 / Implementation" steps
// 4 + 5 (lines 254–268):
//
//   4. Record the decision in AgentCore Memory.
//      `const decision_record_id = await recordDecision({ agent_address,
//          service_url, reasoning, payment, duration_ms });`
//
//   5. Update agent's pricing history (long-term Memory).
//      `await updatePricingHistory(agent_address, { service_url,
//          paid_micros, quality_signal });`
//
// Reality:
//   - The spec calls AWS Bedrock AgentCore Memory the canonical sink for
//     these writes (master spec §"Cross-cutting / Observability"), and
//     promises a `recordDecision` helper from `../memory`. That helper
//     does not exist in this repo today and AWS AgentCore Memory's
//     short-term-key API is not yet exposed by an SDK we depend on.
//   - The closest already-wired sink is the EVO L1 store (`evo-bridge`,
//     consumed via `adapters/agent-memory.ts`). Surface 4 (the AgentCore
//     loop) reads "what worked" out of EVO already — so writing the
//     pay_x402 decisions to the same store gives Surface 4's reasoning
//     loop direct visibility into past x402 outcomes without any new
//     plumbing.
//   - When AgentCore Memory's API stabilizes, the `recordDecision` /
//     `updatePricingHistory` implementations below will gain a second
//     write to the AgentCore Memory short-term-key channel. The IC-3
//     `decision_record_id` returned to the caller is the EVO observation
//     id today, and will become the AgentCore Memory record id when that
//     channel is wired (the wire shape doesn't change — IC-3 just says
//     "pointer into AgentCore Memory", and EVO is the AgentCore-Memory-
//     adjacent surface in the AEP world). See spec open-questions N4.
//
// Env vars:
//   - AEP_EVO_ENABLED            — already gates the entire EVO bridge
//                                   (`adapters/evo-bridge.ts`). Surface 2
//                                   inherits the kill-switch silently —
//                                   when EVO is disabled,
//                                   `recordDecision` returns a synthetic
//                                   "memory-disabled-…" id so the IC-3
//                                   contract is still satisfied.
//   - AGENTCORE_MEMORY_ENDPOINT  — RESERVED, not yet read. Documents the
//                                   eventual AgentCore Memory call site.
//   - AGENTCORE_MEMORY_BEARER    — RESERVED, not yet read. AgentCore
//                                   Gateway-managed bearer for the Memory
//                                   API.
//
// TODO(Surface 2 follow-up, AgentCore Memory wiring): when AgentCore
// Memory's TS client lands, add a second `await memoryClient.write(...)`
// call inside `recordDecision`. Keep the EVO write — it stays useful for
// Surface 4's strategy retrieval. Tracked in spec open-questions N4 +
// master §"Cross-cutting / Observability".

import { createHash } from "node:crypto";
import { getEvoClient } from "./evo-bridge.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "agent-core-memory" });

// ---------------------------------------------------------------------------
// Domain types — IC-3 audit trail fields (spec lines 109–137).
// ---------------------------------------------------------------------------

export interface DecisionRecord {
  agent_address: string;
  service_url: string;
  /** The agent's natural-language justification (mandatory per IC-3). */
  reasoning: string;
  payment: {
    tx_hash: string;
    amount_paid_micros: number;
    network: "base-mainnet" | "base-sepolia";
    facilitator: "cdp" | "kora";
  };
  status: number;
  duration_ms: number;
}

export interface PricingHistoryUpdate {
  service_url: string;
  paid_micros: number;
  /** 0 = call failed (5xx / refund), 1 = call succeeded (200). */
  quality_signal: 0 | 1;
}

export interface AgentCoreMemoryWriter {
  /**
   * Persist the IC-3 decision audit record. Returns the
   * `decision_record_id` IC-3 surfaces back to the caller — opaque,
   * stable, retrievable.
   */
  recordDecision(record: DecisionRecord): Promise<string>;

  /**
   * Long-term pricing-history write. Best-effort: failures here never
   * break the parent x402 call (mirrors `agent-memory.ts:recordOutcome`
   * best-effort posture). Logged but swallowed.
   */
  updatePricingHistory(
    agent_address: string,
    update: PricingHistoryUpdate,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// EVO-backed implementation. Same kill-switch convention as
// `adapters/agent-memory.ts`: when AEP_EVO_ENABLED=false, writes are
// no-ops and `recordDecision` returns a synthetic id so IC-3's
// `decision_record_id` contract is preserved.
// ---------------------------------------------------------------------------

class EvoBackedAgentCoreMemory implements AgentCoreMemoryWriter {
  async recordDecision(record: DecisionRecord): Promise<string> {
    const client = getEvoClient();
    if (!client.enabled) {
      const stableId = `memory-disabled-${record.agent_address.slice(0, 8)}-${Date.now()}`;
      log.debug(
        {
          agent_address: record.agent_address,
          service_url: record.service_url,
        },
        "agent-core-memory: skip recordDecision (EVO disabled), returning synthetic id",
      );
      return stableId;
    }

    // EVO's `observe` shape (`adapters/evo-bridge.ts:EvoObservation`):
    //   { content: string, metadata?: Record<string, string> }
    // Mirrors the registration / outcome encoding in `agent-memory.ts` —
    // dense `key=value\n` content for the embedder, structured fields in
    // metadata for retrieval pivot.
    const content =
      `kind=pay_x402_decision\n` +
      `agent_address=${record.agent_address}\n` +
      `service_url=${record.service_url}\n` +
      `status=${record.status}\n` +
      `tx_hash=${record.payment.tx_hash}\n` +
      `amount_paid_micros=${record.payment.amount_paid_micros}\n` +
      `network=${record.payment.network}\n` +
      `facilitator=${record.payment.facilitator}\n` +
      `duration_ms=${record.duration_ms}\n` +
      `reasoning=${record.reasoning}`;

    // EVO's `observe` returns void (`adapters/evo-bridge.ts:103`) — IDs
    // live inside EVO's L1 keyed by the content hash. To satisfy IC-3's
    // "decision_record_id pointer" contract we synthesize a deterministic
    // id off the same inputs the embedder sees. Same input → same id, so
    // a retried call (idempotency case, error table row 6) returns the
    // pointer to the same record without creating a duplicate.
    const id =
      "decision-" +
      createHash("sha256").update(content).digest("hex").slice(0, 32);

    await client.observe({
      content,
      metadata: {
        kind: "pay_x402_decision",
        decision_record_id: id,
        agent_address: record.agent_address,
        service_url: record.service_url,
        tx_hash: record.payment.tx_hash,
        network: record.payment.network,
        facilitator: record.payment.facilitator,
        amount_paid_micros: String(record.payment.amount_paid_micros),
        status: String(record.status),
        duration_ms: String(record.duration_ms),
      },
    });

    log.info(
      {
        agent_address: record.agent_address,
        service_url: record.service_url,
        decision_record_id: id,
      },
      "agent-core-memory: recordDecision wrote to EVO",
    );
    return id;
  }

  async updatePricingHistory(
    agent_address: string,
    update: PricingHistoryUpdate,
  ): Promise<void> {
    const client = getEvoClient();
    if (!client.enabled) {
      log.debug(
        { agent_address, service_url: update.service_url },
        "agent-core-memory: skip updatePricingHistory (EVO disabled)",
      );
      return;
    }

    // Pricing history is a separate observation kind so a future
    // retrieval can filter by `kind=pricing_history` without false hits
    // from decision records. The numeric fields are stringified per
    // EVO's metadata schema (string-only values).
    const content =
      `kind=pricing_history\n` +
      `agent_address=${agent_address}\n` +
      `service_url=${update.service_url}\n` +
      `paid_micros=${update.paid_micros}\n` +
      `quality_signal=${update.quality_signal}`;

    try {
      await client.observe({
        content,
        metadata: {
          kind: "pricing_history",
          agent_address,
          service_url: update.service_url,
          paid_micros: String(update.paid_micros),
          quality_signal: String(update.quality_signal),
        },
      });
    } catch (e) {
      // Best-effort — never break the parent x402 call on a memory write.
      log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          agent_address,
          service_url: update.service_url,
        },
        "agent-core-memory: updatePricingHistory failed (swallowed)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Module-load singleton + test seam.
// ---------------------------------------------------------------------------

let cachedWriter: AgentCoreMemoryWriter | null = null;

export function getAgentCoreMemory(): AgentCoreMemoryWriter {
  if (!cachedWriter) {
    cachedWriter = new EvoBackedAgentCoreMemory();
  }
  return cachedWriter;
}

export function setAgentCoreMemory(
  writer: AgentCoreMemoryWriter | null,
): void {
  cachedWriter = writer;
}

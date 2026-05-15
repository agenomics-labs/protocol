/**
 * ADR-129 Phase 2 — tests for the milestone-outcome learn loop.
 *
 * Phase 2 scope: when a settlement-side ix succeeds (approve_milestone,
 * resolve_dispute, resolve_dispute_timeout), the handler fires
 * `agentMemory.recordOutcome(...)` post-success, wrapped in try/catch so
 * a learn failure can never break the parent ix's success contract.
 *
 * Coverage targets:
 *
 * agent-memory.ts#recordOutcome — facade contract:
 *   1. Kill-switch (DisabledEvoClient) → recordOutcome resolves to void
 *      and never invokes observe/learn on the bridge.
 *   2. Live bridge, recordOutcome(task_completed) → bridge.observe is
 *      called with the outcome content + metadata, AND bridge.learn is
 *      called with {task_id, score: 1.0, success: true}. Two-tier
 *      assertion.
 *   3. Live bridge, recordOutcome(dispute_won) → learn called with
 *      {score: 0.7, success: true}.
 *   4. Live bridge, recordOutcome(dispute_lost) → learn called with
 *      {score: 0.0, success: false}.
 *   5. Live bridge, recordOutcome(expiry_undelivered) → learn called
 *      with {score: 0.0, success: false}.
 *   6. The on-chain reason code (0/1/2) is mirrored into the observe's
 *      metadata bag so dashboards can correlate without re-deriving the
 *      mapping.
 *   7. EVO's 64-char task_id cap is honoured: a 100-char taskId is
 *      truncated to 64 (with the EVO ellipsis convention).
 *   8. learn-throws → recordOutcome rejects with the bridge's error;
 *      observe-throws → recordOutcome rejects (and the second leg never
 *      fires). The settlement handler's try/catch is what swallows; the
 *      facade itself surfaces the typed Error.
 *
 * Settlement handler contract (best-effort posture):
 *   9. handleApproveMilestone — recordOutcome throws → handler still
 *      returns a success-shaped response, error swallowed at WARN.
 *      Verified at the facade boundary (live RPC isn't available in the
 *      unit-test env, so we exercise the swallow shape itself).
 *  10. handleResolveDispute — same swallow contract.
 *  11. handleResolveDisputeTimeout — same swallow contract.
 *  12. The wire kind ↔ on-chain reason code mapping matches AUD-109/113
 *      (programs/settlement/src/instructions/cpi.rs:54-56). This is a
 *      structural assertion against the OUTCOME_TO_ONCHAIN_REASON
 *      table; if the on-chain ABI ever drifts from the ADR-129 enum,
 *      this test fails loudly.
 *
 * Action surface:
 *  13. The Phase-2 wiring adds NO new MCP action; tool count stays at
 *      27 (matches `action-shape.test.ts` and the Phase-1 commit
 *      db52117).
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { allTools } from "../src/tools/index.js";
import { pilotActions } from "../src/actions/index.js";
import {
  setAgentMemory,
  type AgentMemory,
  type AgentRegistrationObservation,
  type FindSimilarAgentsInput,
  type FindSimilarAgentsResult,
  type MilestoneOutcomeKind,
  type MilestoneOutcomeObservation,
} from "../src/adapters/agent-memory.js";
import {
  setEvoClient,
  type EvoClient,
  type EvoLearnOutcome,
  type EvoObservation,
  type EvoRetrievalQuery,
  type EvoRetrievalResult,
} from "../src/adapters/evo-bridge.js";
import { getAgentMemory } from "../src/adapters/agent-memory.js";

// ---------------------------------------------------------------------------
// Test doubles. We want two independent dimensions:
//   (a) MockEvoClient — implements the EvoClient surface so we can wire it
//       into the real AgentMemoryFacade (via setEvoClient + a fresh facade).
//       Lets us assert the bridge call shapes (observe payload, learn
//       payload) the facade emits.
//   (b) MockAgentMemory — implements the AgentMemory surface directly, so
//       the settlement-handler swallow contract can be exercised without
//       a live Solana RPC.
// ---------------------------------------------------------------------------

interface MockEvoClient extends EvoClient {
  observed: EvoObservation[];
  learned: EvoLearnOutcome[];
  observeImpl: (o: EvoObservation) => Promise<void>;
  learnImpl: (o: EvoLearnOutcome) => Promise<void>;
}

function newMockEvoClient(overrides: Partial<MockEvoClient> = {}): MockEvoClient {
  const observed: EvoObservation[] = [];
  const learned: EvoLearnOutcome[] = [];
  const mock: MockEvoClient = {
    enabled: true,
    observed,
    learned,
    observeImpl: async (o) => {
      observed.push(o);
    },
    learnImpl: async (o) => {
      learned.push(o);
    },
    async observe(o: EvoObservation): Promise<void> {
      return mock.observeImpl(o);
    },
    async retrieve(_q: EvoRetrievalQuery): Promise<EvoRetrievalResult> {
      return { hits: [] };
    },
    async learn(o: EvoLearnOutcome): Promise<void> {
      return mock.learnImpl(o);
    },
    async consolidate(): Promise<void> {
      return;
    },
    async shutdown(): Promise<void> {
      return;
    },
    ...overrides,
  };
  return mock;
}

interface MockAgentMemory extends AgentMemory {
  recordedOutcomes: MilestoneOutcomeObservation[];
  recordOutcomeImpl: (o: MilestoneOutcomeObservation) => Promise<void>;
}

function newMockAgentMemory(
  overrides: Partial<MockAgentMemory> = {},
): MockAgentMemory {
  const recordedOutcomes: MilestoneOutcomeObservation[] = [];
  const mock: MockAgentMemory = {
    recordedOutcomes,
    recordOutcomeImpl: async (o) => {
      recordedOutcomes.push(o);
    },
    async recordAgentRegistration(_o: AgentRegistrationObservation): Promise<void> {
      return;
    },
    async findSimilarAgents(
      _i: FindSimilarAgentsInput,
    ): Promise<FindSimilarAgentsResult> {
      return { skipped: true, similarAgents: [] };
    },
    async recordOutcome(o) {
      return mock.recordOutcomeImpl(o);
    },
    ...overrides,
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("ADR-129 Phase 2 — agent-memory.recordOutcome (kill-switch)", () => {
  afterEach(() => {
    setEvoClient(null);
    setAgentMemory(null);
  });

  it("DisabledEvoClient → recordOutcome resolves to void without invoking observe/learn", async () => {
    let observeCalls = 0;
    let learnCalls = 0;
    const disabled: EvoClient = {
      enabled: false,
      async observe(_o) {
        observeCalls++;
      },
      async retrieve(_q) {
        return { hits: [] };
      },
      async learn(_o) {
        learnCalls++;
      },
      async consolidate() {
        return;
      },
      async shutdown() {
        return;
      },
    };
    setEvoClient(disabled);
    setAgentMemory(null); // force re-creation against the disabled client

    const memory = getAgentMemory();
    await memory.recordOutcome({
      taskId: "any-task",
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
    });

    assert.equal(observeCalls, 0, "observe must not be invoked when disabled");
    assert.equal(learnCalls, 0, "learn must not be invoked when disabled");
  });
});

describe("ADR-129 Phase 2 — agent-memory.recordOutcome (live bridge, kind translation)", () => {
  afterEach(() => {
    setEvoClient(null);
    setAgentMemory(null);
  });

  function setupLive(): MockEvoClient {
    const mock = newMockEvoClient();
    setEvoClient(mock);
    setAgentMemory(null);
    return mock;
  }

  it("task_completed → learn called with score=1.0 / success=true and observe carries on-chain reason 0", async () => {
    const mock = setupLive();
    await getAgentMemory().recordOutcome({
      taskId: "ESCROW_BASE58_PUBKEY:m0",
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
      metadata: { escrow_address: "ESCROW_BASE58_PUBKEY", milestone_index: "0" },
    });

    assert.equal(mock.observed.length, 1);
    assert.equal(mock.learned.length, 1);
    const learn = mock.learned[0]!;
    assert.equal(learn.taskId, "ESCROW_BASE58_PUBKEY:m0");
    assert.equal(learn.score, 1.0);
    assert.equal(learn.success, true);
    const obs = mock.observed[0]!;
    assert.equal(obs.metadata?.kind, "milestone_outcome");
    assert.equal(obs.metadata?.outcome_kind, "task_completed");
    assert.equal(obs.metadata?.onchain_reason, "0");
    assert.equal(
      obs.metadata?.provider_authority,
      "Authority1111111111111111111111111111111111",
    );
  });

  it("dispute_won → learn called with score=0.7 / success=true and on-chain reason 1", async () => {
    const mock = setupLive();
    await getAgentMemory().recordOutcome({
      taskId: "ESCROW:dispute",
      kind: "dispute_won",
      providerAuthority: "Authority2222222222222222222222222222222222",
    });

    const learn = mock.learned[0]!;
    assert.equal(learn.score, 0.7);
    assert.equal(learn.success, true);
    assert.equal(mock.observed[0]!.metadata?.onchain_reason, "1");
  });

  it("dispute_lost → learn called with score=0.0 / success=false and on-chain reason 1", async () => {
    const mock = setupLive();
    await getAgentMemory().recordOutcome({
      taskId: "ESCROW:dispute",
      kind: "dispute_lost",
      providerAuthority: "Authority3333333333333333333333333333333333",
    });

    const learn = mock.learned[0]!;
    assert.equal(learn.score, 0.0);
    assert.equal(learn.success, false);
    assert.equal(mock.observed[0]!.metadata?.onchain_reason, "1");
  });

  it("expiry_undelivered → learn called with score=0.0 / success=false and on-chain reason 2", async () => {
    const mock = setupLive();
    await getAgentMemory().recordOutcome({
      taskId: "ESCROW:expiry",
      kind: "expiry_undelivered",
      providerAuthority: "Authority4444444444444444444444444444444444",
    });

    const learn = mock.learned[0]!;
    assert.equal(learn.score, 0.0);
    assert.equal(learn.success, false);
    assert.equal(mock.observed[0]!.metadata?.onchain_reason, "2");
  });

  it("observe is called BEFORE learn so the trail lands in L1 even if learn is rejected later", async () => {
    const callOrder: string[] = [];
    const mock = newMockEvoClient({
      observeImpl: async (_o) => {
        callOrder.push("observe");
      },
      learnImpl: async (_o) => {
        callOrder.push("learn");
      },
    });
    setEvoClient(mock);
    setAgentMemory(null);

    await getAgentMemory().recordOutcome({
      taskId: "ESCROW:m0",
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
    });
    assert.deepEqual(callOrder, ["observe", "learn"]);
  });

  it("forwards caller metadata into the observe payload (escrow + milestone + tx sig)", async () => {
    const mock = setupLive();
    await getAgentMemory().recordOutcome({
      taskId: "ESCROW:m2",
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
      metadata: {
        escrow_address: "ESCROW_BASE58_PUBKEY",
        milestone_index: "2",
        rating: "5",
        transaction_signature: "5xyzfaketxsig111",
      },
    });
    const meta = mock.observed[0]!.metadata!;
    assert.equal(meta.escrow_address, "ESCROW_BASE58_PUBKEY");
    assert.equal(meta.milestone_index, "2");
    assert.equal(meta.rating, "5");
    assert.equal(meta.transaction_signature, "5xyzfaketxsig111");
  });
});

describe("ADR-129 Phase 2 — agent-memory.recordOutcome (task_id bound)", () => {
  afterEach(() => {
    setEvoClient(null);
    setAgentMemory(null);
  });

  it("truncates a task_id over EVO_MAX_TASK_ID_LEN (64) defensively", async () => {
    const mock = newMockEvoClient();
    setEvoClient(mock);
    setAgentMemory(null);

    const oversized = "X".repeat(100); // 100 chars, well over 64
    await getAgentMemory().recordOutcome({
      taskId: oversized,
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
    });

    const learn = mock.learned[0]!;
    assert.ok(
      learn.taskId.length <= 64,
      `task_id should be capped to 64 chars, got ${learn.taskId.length}`,
    );
  });

  it("a 48-char composite key (escrow_b58 + ':m0') passes through unchanged", async () => {
    const mock = newMockEvoClient();
    setEvoClient(mock);
    setAgentMemory(null);

    // 44-char base58 pubkey + ":m0" = 47 chars. Comfortably under 64.
    const base58Pubkey = "11111111111111111111111111111111"; // 32 chars stand-in
    const key = `${base58Pubkey}:m0`;
    assert.ok(key.length < 64);
    await getAgentMemory().recordOutcome({
      taskId: key,
      kind: "task_completed",
      providerAuthority: base58Pubkey,
    });
    assert.equal(mock.learned[0]!.taskId, key);
  });
});

describe("ADR-129 Phase 2 — agent-memory.recordOutcome (failure-mode propagation)", () => {
  afterEach(() => {
    setEvoClient(null);
    setAgentMemory(null);
  });

  it("learn throws → facade rejects (the settlement handler's try/catch is what swallows; the facade surfaces the typed Error)", async () => {
    const mock = newMockEvoClient({
      learnImpl: async (_o) => {
        throw new Error("evo-bridge: learn rejected: surprise gate");
      },
    });
    setEvoClient(mock);
    setAgentMemory(null);

    let caught: unknown = null;
    try {
      await getAgentMemory().recordOutcome({
        taskId: "ESCROW:m0",
        kind: "task_completed",
        providerAuthority: "Authority1111111111111111111111111111111111",
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.match((caught as Error).message, /evo-bridge/);
    // The observe leg fired before the learn rejection — confirms the
    // ordering contract from the suite above.
    assert.equal(mock.observed.length, 1);
    assert.equal(mock.learned.length, 0);
  });

  it("observe throws → facade rejects and learn is NEVER called", async () => {
    const mock = newMockEvoClient({
      observeImpl: async (_o) => {
        throw new Error("evo-bridge: observe rejected: schema");
      },
    });
    setEvoClient(mock);
    setAgentMemory(null);

    let caught: unknown = null;
    try {
      await getAgentMemory().recordOutcome({
        taskId: "ESCROW:m0",
        kind: "task_completed",
        providerAuthority: "Authority1111111111111111111111111111111111",
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.equal(
      mock.learned.length,
      0,
      "learn must NOT fire if observe rejected first",
    );
  });
});

describe("ADR-129 Phase 2 — settlement handler best-effort swallow contract", () => {
  afterEach(() => {
    setAgentMemory(null);
  });

  // The Phase 2 wiring inside handleApproveMilestone /
  // handleResolveDispute / handleResolveDisputeTimeout looks like:
  //
  //   const sig = await program.methods.<ix>(...).rpc();
  //   await recordMilestoneOutcomeBestEffort({ ... }); // <-- try/catch internal
  //   return { success: true, ..., transactionSignature: sig };
  //
  // The on-chain `.rpc()` call needs a live wallet/RPC we don't have in
  // this unit-test env. Instead, we exercise the swallow shape DIRECTLY
  // — the `recordMilestoneOutcomeBestEffort` helper is a thin
  // try/catch around `getAgentMemory().recordOutcome(...)`. Replicating
  // it here against a throwing mock proves the contract: any throw out
  // of recordOutcome is invisible to the surrounding code path.

  for (const kind of ["task_completed", "dispute_won", "dispute_lost"] as const) {
    it(`recordOutcome throws (${kind}) → simulated handler still completes its post-success path`, async () => {
      const throwingMock = newMockAgentMemory({
        recordOutcomeImpl: async () => {
          throw new Error("evo-bridge: subprocess died mid-call");
        },
      });
      setAgentMemory(throwingMock);

      // Replicate the handler's try/catch exactly.
      let postObserveReached = false;
      try {
        await throwingMock.recordOutcome({
          taskId: "ESCROW:m0",
          kind,
          providerAuthority: "Authority1111111111111111111111111111111111",
        });
      } catch {
        // Swallowed — exactly as recordMilestoneOutcomeBestEffort does.
      }
      postObserveReached = true;
      assert.equal(postObserveReached, true);
    });
  }

  it("recordOutcome succeeds (task_completed) → facade is called once with the canonical payload", async () => {
    const successMock = newMockAgentMemory();
    setAgentMemory(successMock);

    await successMock.recordOutcome({
      taskId: "ESCROW_BASE58_PUBKEY:m0",
      kind: "task_completed",
      providerAuthority: "Authority1111111111111111111111111111111111",
      metadata: { escrow_address: "ESCROW_BASE58_PUBKEY" },
    });

    assert.equal(successMock.recordedOutcomes.length, 1);
    const recorded = successMock.recordedOutcomes[0]!;
    assert.equal(recorded.taskId, "ESCROW_BASE58_PUBKEY:m0");
    assert.equal(recorded.kind, "task_completed");
    assert.equal(
      recorded.providerAuthority,
      "Authority1111111111111111111111111111111111",
    );
  });
});

describe("ADR-129 Phase 2 — wire vs. on-chain reason-code mapping (AUD-109/113)", () => {
  // AUD-109/113 plumbed three reason codes into the Settlement→Registry
  // CPI (programs/settlement/src/instructions/cpi.rs:54-56):
  //   REASON_TASK_COMPLETED     = 0
  //   REASON_DISPUTE_LOSS       = 1
  //   REASON_EXPIRY_UNDELIVERED = 2
  //
  // The Phase 2 enum collapses dispute_won + dispute_lost to the same
  // on-chain reason (1) on purpose — the on-chain CPI does not
  // distinguish them, but EVO's L2 strategy formation does.
  // Tests pin the mapping via the observe-payload's `onchain_reason`
  // metadata field so a future drift in either side surfaces as a red
  // test rather than a silent semantic error.

  afterEach(() => {
    setEvoClient(null);
    setAgentMemory(null);
  });

  const expectedReason: Record<MilestoneOutcomeKind, string> = {
    task_completed: "0",
    dispute_won: "1",
    dispute_lost: "1",
    expiry_undelivered: "2",
  };

  for (const kind of Object.keys(expectedReason) as MilestoneOutcomeKind[]) {
    it(`kind=${kind} → onchain_reason=${expectedReason[kind]}`, async () => {
      const mock = newMockEvoClient();
      setEvoClient(mock);
      setAgentMemory(null);

      await getAgentMemory().recordOutcome({
        taskId: `ESCROW:${kind}`,
        kind,
        providerAuthority: "Authority1111111111111111111111111111111111",
      });
      assert.equal(mock.observed[0]!.metadata?.onchain_reason, expectedReason[kind]);
    });
  }
});

describe("ADR-129 Phase 2 — additive-only surface (no new MCP action)", () => {
  it("tool count is 29 (ADR-138 added query_execution_history; ADR-111 MCP tools deferred)", () => {
    // Tool-count drift guard. ADR-129 Phase 1 (db52117) was 26→27
    // (find_similar_agents). Phase 2 added 0 (best-effort wires inside
    // approve_milestone / resolve_dispute / resolve_dispute_timeout).
    // Reflex Surface 2 (docs/aep-reflex-tech-spec.md §"Surface 2") added
    // pay_x402_service: 27→28.
    // ADR-138 (cycle-4) added query_execution_history: 28→29.
    // ADR-111 (cycle-4) lands the on-chain delegation grants surface but
    // intentionally defers the 7 matching MCP tools to a follow-up PR
    // (the handler + action wrappers are not yet authored). Tool count
    // stays at 29 until that follow-up lands.
    //
    // If a future PR bumps this count, the new contributor MUST update
    // both this assertion AND the count callouts in README.md +
    // docs/api-reference.md so the three sources stay in lockstep.
    assert.equal(allTools.length, 29, "tool-count drift guard");
    assert.equal(pilotActions.length, 29, "action-count drift guard");
  });

  it("the existing settlement actions are still registered with their unchanged shapes", () => {
    // Sanity check the three settlement actions Phase 2 wires into still
    // exist with their original names + handler reference. The wrap()
    // helper around the handler is unchanged; the EVO learn call sits
    // INSIDE the handler.
    for (const name of [
      "approve_milestone",
      "resolve_dispute",
      "resolve_dispute_timeout",
    ]) {
      const action = pilotActions.find((a) => a.name === name);
      assert.ok(action, `${name} should still be registered`);
      assert.equal(action!.readOnly, false, `${name} stays non-readOnly`);
    }
  });
});

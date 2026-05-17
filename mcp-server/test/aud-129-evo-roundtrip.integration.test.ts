/**
 * AUD-129 — ADR-129 Phase 1 real-binary roundtrip integration test.
 *
 * Why this exists
 * ===============
 * Every other test in `mcp-server/test/` for the EVO bridge runs against
 * a fake child process and canned stdout — they verify the transport's
 * resilience contract (timeout, queue, breaker, restart) but never speak
 * to a real `evo` binary. That gap let a real protocol skew land:
 * `parseRetrievalResult` was reading `result.results` / `entry.id`
 * indefinitely while real EVO was emitting `result.memories` /
 * `entry.node_id`, dropping 100% of retrieval hits silently. The audit
 * trail (MCP-300..307 closures) was correct against the fake fixtures
 * and wrong against the real binary.
 *
 * What this test pins
 * ===================
 * 1. The `createEvoClient()` -> spawn -> handshake -> observe ->
 *    consolidate -> retrieve path actually works against a real binary.
 * 2. EVO emits its post-ADR-196 wire shape and our adapter parses it.
 * 3. ONNX-embedded retrieval ranks semantically — "auth" content
 *    outranks unrelated content for an auth-themed query.
 *
 * Skip semantics
 * ==============
 * This test is conditionally skipped when either the EVO binary or the
 * ONNX model directory is absent. CI without the binary skips cleanly;
 * local development with `AEP_EVO_BINARY` + `AEP_EVO_MODEL_DIR` runs the
 * full roundtrip. BLAKE3-fallback mode would still satisfy the shape
 * assertions but not the semantic ranking, so we require ONNX for the
 * full run.
 *
 * How to run locally
 * ==================
 *   AEP_EVO_BINARY=$HOME/.cargo/bin/evo \
 *   AEP_EVO_MODEL_DIR=$HOME/.cache/evo/models/all-MiniLM-L6-v2 \
 *   npm --workspace @agenomics/aep-mcp test -- \
 *     test/aud-129-evo-roundtrip.integration.test.ts
 *
 * If you don't have an `evo` binary handy: clone EVO, then
 *   cargo install --path crates/evo --force
 *
 * Runs under `node --import tsx --test`.
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createEvoClient, type EvoClient } from "../src/adapters/evo-bridge.js";

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

function resolvePrereqs(): {
  available: boolean;
  binaryPath: string | null;
  modelDir: string | null;
  reason: string;
} {
  const binaryPath = process.env.AEP_EVO_BINARY;
  const modelDir = process.env.AEP_EVO_MODEL_DIR;
  if (!binaryPath) {
    return {
      available: false,
      binaryPath: null,
      modelDir: null,
      reason: "AEP_EVO_BINARY not set",
    };
  }
  if (!fs.existsSync(binaryPath)) {
    return {
      available: false,
      binaryPath: null,
      modelDir: null,
      reason: `AEP_EVO_BINARY=${binaryPath} does not exist`,
    };
  }
  if (!modelDir) {
    return {
      available: false,
      binaryPath,
      modelDir: null,
      reason:
        "AEP_EVO_MODEL_DIR not set — BLAKE3 fallback would invalidate the semantic-ranking assertion",
    };
  }
  if (!fs.existsSync(modelDir)) {
    return {
      available: false,
      binaryPath,
      modelDir: null,
      reason: `AEP_EVO_MODEL_DIR=${modelDir} does not exist`,
    };
  }
  return { available: true, binaryPath, modelDir, reason: "" };
}

const prereqs = resolvePrereqs();

describe("AUD-129 — EVO real-binary roundtrip", { skip: !prereqs.available ? prereqs.reason : false }, () => {
  let tmpDir: string;
  let client: EvoClient;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aud-129-evo-"));
    client = createEvoClient({
      env: {
        ...process.env,
        AEP_EVO_ENABLED: "true",
        AEP_EVO_BINARY: prereqs.binaryPath!,
        AEP_EVO_DB: path.join(tmpDir, "agent-memory.db"),
        AEP_EVO_MODEL_DIR: prereqs.modelDir!,
      },
    });
  });

  after(async () => {
    if (client) {
      await client.shutdown();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("client.enabled is true with all three env vars set to real values", () => {
    assert.equal(client.enabled, true);
  });

  it("observe -> consolidate -> retrieve round-trips through real EVO and adapter parses memories[]", async () => {
    // Three distinct topics. EVO assigns one node per observation, embeds
    // via ONNX MiniLM, and the L1 HNSW index stores them. Retrieval against
    // an auth-themed query should rank both auth observations above the
    // vision observation.
    //
    // EVO accepts metadata on `observe_text` (stored under the node) but
    // **does not echo it back on `retrieve_text`** — see ADR-129
    // §"Contracts" for the gap this opens in `findSimilarAgents`, which
    // currently assumes metadata.authority / metadata.agent_profile_address
    // survive a round-trip. That's a Phase 1.1 fix; we keep this test
    // focused on the shape + ranking contract this PR closes and assert
    // on content substrings (which DO survive) for the semantic check.
    await client.observe({
      content: "JWT authentication and OAuth2 token flows",
      metadata: { agent_id: "auth-agent-A" },
    });
    await client.observe({
      content: "image classification with vision transformers and CNNs",
      metadata: { agent_id: "vision-agent-B" },
    });
    await client.observe({
      content: "OAuth2 bearer tokens for API authorization",
      metadata: { agent_id: "auth-agent-C" },
    });

    // Consolidate is no-op for fresh observations on EVO HEAD but the
    // facade calls it in the production write path; exercising it here
    // proves the JSONL transport survives a no-result-list command.
    await client.consolidate();

    const result = await client.retrieve({
      query: "authentication tokens and credentials",
      topK: 5,
      tokenBudget: 4096,
      minSimilarity: 0.0,
    });

    // Shape assertions — these are the ones that were silently failing
    // before the parseRetrievalResult fix.
    assert.ok(Array.isArray(result.hits), "result.hits must be an array");
    assert.ok(
      result.hits.length >= 2,
      `expected at least 2 hits, got ${result.hits.length}`,
    );
    for (const hit of result.hits) {
      assert.ok(typeof hit.id === "string" && hit.id.length > 0, "hit.id non-empty");
      assert.ok(hit.id.startsWith("node:"), `EVO emits node:* ids, got ${hit.id}`);
      assert.ok(
        Number.isFinite(hit.score),
        `hit.score must be a finite number, got ${hit.score}`,
      );
      assert.ok(typeof hit.content === "string", "hit.content must be a string");
    }

    // Semantic ranking — auth content must rank above vision content. We
    // assert on content substrings since EVO doesn't echo metadata
    // (documented in the comment above).
    const authHits = result.hits.filter((h) => /OAuth|JWT|authentication/i.test(h.content));
    const visionHits = result.hits.filter((h) => /vision|image|CNN/i.test(h.content));
    assert.ok(
      authHits.length >= 2,
      `both auth observations should retrieve, got ${authHits.length}`,
    );
    if (visionHits.length > 0) {
      const minAuthScore = Math.min(...authHits.map((h) => h.score));
      const maxVisionScore = Math.max(...visionHits.map((h) => h.score));
      assert.ok(
        minAuthScore > maxVisionScore,
        `auth (min=${minAuthScore}) must outrank vision (max=${maxVisionScore})`,
      );
    }
  });

  it("retrieve survives a query with no relevant content (returns empty without error)", async () => {
    // Use a high min_similarity so nothing matches — but the call must
    // still resolve cleanly (no rejection, no thrown error).
    const result = await client.retrieve({
      query: "quantum chromodynamics gluon field interactions",
      topK: 1,
      tokenBudget: 256,
      minSimilarity: 0.99,
    });
    assert.ok(Array.isArray(result.hits));
    assert.equal(result.hits.length, 0);
  });
});

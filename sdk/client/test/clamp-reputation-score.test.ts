/**
 * AUD-112 (cycle-2 reciprocal SDK helper): unit tests for
 * `clampReputationScore`, the presentation-layer clamp that defends
 * SDK consumers reading a profile during the
 * `propose_reputation_delta` self-heal window.
 *
 * On-chain source of truth: `MAX_REPUTATION_SCORE = 100`
 * (`programs/agent-registry/src/lib.rs:17`, ADR-094). The handler
 * doc-comment landed in commit `d5df7ad` (cycle-2). Roadmap §3 B10
 * specifies this SDK-side reciprocal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REPUTATION_SCORE,
  clampReputationScore,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Constant pinning — guards against accidental drift between this SDK
// constant and the on-chain `MAX_REPUTATION_SCORE`. If the on-chain
// constant ever changes, both must be updated in lockstep.
// ---------------------------------------------------------------------------

test("MAX_REPUTATION_SCORE matches the on-chain constant (= 100)", () => {
  assert.equal(MAX_REPUTATION_SCORE, 100);
});

// ---------------------------------------------------------------------------
// In-range inputs — pass-through, no clamping.
// ---------------------------------------------------------------------------

test("clampReputationScore returns the numeric equivalent for an in-range BigInt", () => {
  assert.equal(clampReputationScore(0n), 0);
  assert.equal(clampReputationScore(1n), 1);
  assert.equal(clampReputationScore(50n), 50);
  assert.equal(clampReputationScore(99n), 99);
});

test("clampReputationScore returns a number, not a bigint", () => {
  // Presentation-layer consumers expect a primitive `number` for
  // arithmetic and template-literal rendering. Returning a `bigint`
  // would silently break `${score}/100` interpolation for some hosts
  // and fail strict-equality checks downstream.
  assert.equal(typeof clampReputationScore(42n), "number");
  assert.equal(typeof clampReputationScore(0n), "number");
  assert.equal(typeof clampReputationScore(MAX_REPUTATION_SCORE_BI()), "number");
});

// ---------------------------------------------------------------------------
// Edge cases — exact bounds.
// ---------------------------------------------------------------------------

test("clampReputationScore at the lower bound returns 0", () => {
  assert.equal(clampReputationScore(0n), 0);
});

test("clampReputationScore at the upper bound returns MAX_REPUTATION_SCORE", () => {
  assert.equal(
    clampReputationScore(MAX_REPUTATION_SCORE_BI()),
    MAX_REPUTATION_SCORE,
  );
});

// ---------------------------------------------------------------------------
// Below-range inputs — defensive clamp to lower bound. The on-chain
// `reputation_score` field is `u64` so it cannot be negative on-chain,
// but the helper is total over `bigint` and must not throw on negative
// input (a defensive presentation-layer helper that throws would defeat
// its own purpose).
// ---------------------------------------------------------------------------

test("clampReputationScore clamps a below-range BigInt to 0", () => {
  assert.equal(clampReputationScore(-1n), 0);
  assert.equal(clampReputationScore(-100n), 0);
});

test("clampReputationScore clamps a very-negative BigInt to 0 (no throw)", () => {
  // Two's-complement-style "i64::MIN-ish" sentinel; the helper must
  // clamp, not throw, even for pathological negative inputs.
  const i64Min = -(2n ** 63n);
  assert.equal(clampReputationScore(i64Min), 0);
});

// ---------------------------------------------------------------------------
// Above-range inputs — the AUD-112 transitional-window case. Pre-
// migration profiles can carry a legacy `reputation_score` above
// `MAX_REPUTATION_SCORE` until the first post-migration call self-
// heals the field; this is the helper's primary defensive use-case.
// ---------------------------------------------------------------------------

test("clampReputationScore clamps an above-range BigInt to MAX_REPUTATION_SCORE", () => {
  assert.equal(clampReputationScore(101n), MAX_REPUTATION_SCORE);
  assert.equal(clampReputationScore(500n), MAX_REPUTATION_SCORE);
  assert.equal(clampReputationScore(10_000n), MAX_REPUTATION_SCORE);
});

test("clampReputationScore clamps a u64::MAX-ish BigInt safely (no throw)", () => {
  // `u64::MAX = 2^64 - 1` is far above `Number.MAX_SAFE_INTEGER`
  // (= 2^53 - 1). The clamp must compare in bigint-space *before*
  // the Number() coercion, so the lossy Number() conversion only
  // ever runs on values that round-trip exactly. If the helper
  // ever inverts that order, this assertion would fail (or worse,
  // silently lose precision and return a truncated finite Number).
  const u64Max = 2n ** 64n - 1n;
  assert.equal(clampReputationScore(u64Max), MAX_REPUTATION_SCORE);
});

test("clampReputationScore clamps a BigInt above Number.MAX_SAFE_INTEGER", () => {
  // Explicit precision-safety pin: a BigInt one above
  // Number.MAX_SAFE_INTEGER must clamp, not coerce-then-clamp
  // (which would lose precision on the comparison side).
  const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  assert.equal(clampReputationScore(tooBig), MAX_REPUTATION_SCORE);
});

// ---------------------------------------------------------------------------
// Helper: hoist the BigInt form of MAX_REPUTATION_SCORE so the test
// names read cleanly without inline coercion at every call site.
// ---------------------------------------------------------------------------

function MAX_REPUTATION_SCORE_BI(): bigint {
  return BigInt(MAX_REPUTATION_SCORE);
}

// ADR-061 §4 merge-convention helper tests — detectDisagreement,
// scoreFreshness, renderSideBySide.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  detectDisagreement,
  renderSideBySide,
  scoreFreshness,
  type RegistryReputationView,
} from "../src/index.js";
import type { AttestationReputation } from "../src/types.js";

const NOW = 1_700_000_000;

function registry(overrides: Partial<RegistryReputationView> = {}): RegistryReputationView {
  return {
    reputation_score: 8200,
    total_tasks_completed: 124,
    ...overrides,
  };
}

function sas(overrides: Partial<AttestationReputation> = {}): AttestationReputation {
  return {
    score: 8600,
    completed_tasks: 118,
    dispute_ratio_bps: 150,
    last_updated: NOW - 7 * 86_400, // 7 days ago
    signer: "abcdefghij1234567890abcdefghij0000000000",
    credential: "CRED" + "X".repeat(36),
    ...overrides,
  };
}

describe("merge helpers", () => {
  describe("scoreFreshness", () => {
    it("returns 'fresh' inside 30 days", () => {
      assert.equal(scoreFreshness(NOW - 29 * 86_400, NOW), "fresh");
      assert.equal(scoreFreshness(NOW, NOW), "fresh");
    });

    it("returns 'aging' between 30d and 90d", () => {
      assert.equal(scoreFreshness(NOW - 31 * 86_400, NOW), "aging");
      assert.equal(scoreFreshness(NOW - 90 * 86_400, NOW), "aging");
    });

    it("returns 'stale' past 90 days", () => {
      assert.equal(scoreFreshness(NOW - 91 * 86_400, NOW), "stale");
      assert.equal(scoreFreshness(NOW - 365 * 86_400, NOW), "stale");
    });

    it("treats future timestamps as fresh (clock skew tolerance)", () => {
      // `now < last_updated` — max(0, negative) clamps to 0.
      assert.equal(scoreFreshness(NOW + 10, NOW), "fresh");
    });
  });

  describe("detectDisagreement", () => {
    it("is false when scores are within 2000 bps", () => {
      assert.equal(detectDisagreement(registry({ reputation_score: 8000 }), sas({ score: 9000 })), false);
    });

    it("is true when scores diverge by more than 2000 bps", () => {
      assert.equal(detectDisagreement(registry({ reputation_score: 3000 }), sas({ score: 9000 })), true);
    });

    it("is false when the SAS signal is absent", () => {
      assert.equal(detectDisagreement(registry(), undefined), false);
    });

    it("handles boundary case (exactly 2000 bps) as non-divergent", () => {
      // Threshold is strict `>` 2000 — exactly 2000 bps does not trip.
      assert.equal(detectDisagreement(registry({ reputation_score: 5000 }), sas({ score: 7000 })), false);
      assert.equal(detectDisagreement(registry({ reputation_score: 5000 }), sas({ score: 7001 })), true);
    });
  });

  describe("renderSideBySide", () => {
    it("renders both lines when both signals are present", () => {
      const out = renderSideBySide(registry(), sas(), NOW);
      assert.match(out.line1, /Registry: 8200\/10000 \(124 tasks\)/);
      assert.match(out.line2, /SAS:\s+8600\/10000 \(fresh, 118 tasks, signer=abcd…0000\)/);
    });

    it("renders 'no attestation' when SAS is absent", () => {
      const out = renderSideBySide(registry(), undefined, NOW);
      assert.match(out.line1, /Registry/);
      assert.match(out.line2, /SAS:\s+\(no attestation\)/);
    });

    it("renders 'aging' for 60-day-old attestations", () => {
      const out = renderSideBySide(registry(), sas({ last_updated: NOW - 60 * 86_400 }), NOW);
      assert.match(out.line2, /\(aging,/);
    });

    it("renders 'stale' for 200-day-old attestations", () => {
      const out = renderSideBySide(registry(), sas({ last_updated: NOW - 200 * 86_400 }), NOW);
      assert.match(out.line2, /\(stale,/);
    });
  });
});

// ADR-139 — resolver helper `resolveAgenomicsReputation` tests.
//
// Covers the verify pass-through, the issuer-allowlist guard, the
// cache-hit / cache-miss path, and the structured `reasons[]` surface
// on failure.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  resolveAgenomicsReputation,
  InMemoryCache,
} from "../src/index.js";
import {
  issueAttestation,
  issuerKeypairFromSecret,
  type AgentProfileSnapshot,
} from "@agenomics/reputation-attestor";

function snapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    agent_id: "AgentPubkey1111111111111111111111111111111AA",
    authority: "AuthorityPubkey1111111111111111111111111111A",
    manifest_hash: "f".repeat(64),
    reputation_score: 73,
    slash_count: 0,
    reputation_stake_lamports: 1_000_000_000n,
    registration_nonce: 4n,
    snapshot_slot: 184_729_103n,
    snapshot_timestamp: 1_731_543_123,
    ...overrides,
  };
}

function issuer() {
  return issuerKeypairFromSecret(new Uint8Array(32).fill(0x42));
}

describe("ADR-139 resolveAgenomicsReputation", () => {
  it("verifies and surfaces the payload", async () => {
    const cred = issueAttestation(snapshot(), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const result = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      now: () => snapshot().snapshot_timestamp,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.reputation_score, 73);
      assert.equal(result.value.fromCache, false);
    }
  });

  it("returns structured reasons on a non-allowlisted issuer", async () => {
    const real = issuer();
    const forger = issuerKeypairFromSecret(new Uint8Array(32).fill(0x99));
    const cred = issueAttestation(snapshot(), {
      issuer: forger,
      issuerUrl: "https://attacker.example",
    });
    const result = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [real.publicKey],
      now: () => snapshot().snapshot_timestamp,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        (result.error.reasons ?? []).some((r) => r.code === "ISSUER_NOT_ALLOWED"),
      );
    }
  });

  it("caches a successful resolve and reports fromCache=true on hit", async () => {
    const cred = issueAttestation(snapshot(), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const cache = new InMemoryCache();
    const a = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      now: () => snapshot().snapshot_timestamp,
    });
    assert.equal(a.ok, true);
    if (a.ok) assert.equal(a.fromCache ?? a.value.fromCache, false);

    const b = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      now: () => snapshot().snapshot_timestamp,
    });
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.value.fromCache, true);
  });

  it("respects forceFresh by bypassing the cache", async () => {
    const cred = issueAttestation(snapshot(), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const cache = new InMemoryCache();
    await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      now: () => snapshot().snapshot_timestamp,
    });
    const b = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      now: () => snapshot().snapshot_timestamp,
      forceFresh: true,
    });
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.value.fromCache, false);
  });

  it("respects cache TTL", async () => {
    const cred = issueAttestation(snapshot(), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    let t = 1_000;
    const cache = new InMemoryCache({ now: () => t });
    await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      cacheTtlMs: 5_000,
      now: () => snapshot().snapshot_timestamp,
    });
    t += 6_000;
    const b = await resolveAgenomicsReputation(cred, {
      allowedIssuers: [issuer().publicKey],
      cache,
      cacheTtlMs: 5_000,
      now: () => snapshot().snapshot_timestamp,
    });
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.value.fromCache, false, "TTL elapsed → cache miss");
  });
});

// ADR-139 — snapshot-freshness + on-chain cross-check tests.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  issueAttestation,
  issuerKeypairFromSecret,
  verifyAttestation,
  verifyAttestationWithChain,
  type AgentProfileSnapshot,
  type OnChainProfileFetcher,
  type OnChainProfileView,
} from "../src/index.js";

function snapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
  return {
    agent_id: "AgentPubkey1111111111111111111111111111111AA",
    authority: "AuthorityPubkey1111111111111111111111111111A",
    manifest_hash: "c".repeat(64),
    reputation_score: 50,
    slash_count: 1,
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

describe("ADR-139 snapshot freshness", () => {
  it("flags STALE_SNAPSHOT when snapshot is older than tolerance", () => {
    const cred = issueAttestation(snapshot({ snapshot_timestamp: 1000 }), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = verifyAttestation(cred, {
      now: () => 1_000 + 3600 + 1,
      maxSnapshotAgeSeconds: 3600,
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.reasons.some((r) => r.code === "STALE_SNAPSHOT"));
    }
  });

  it("accepts a snapshot inside the freshness window", () => {
    const cred = issueAttestation(snapshot({ snapshot_timestamp: 1000 }), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = verifyAttestation(cred, {
      now: () => 1500,
      maxSnapshotAgeSeconds: 3600,
    });
    assert.equal(v.ok, true);
  });

  it("ignores freshness when maxSnapshotAgeSeconds is undefined", () => {
    const cred = issueAttestation(snapshot({ snapshot_timestamp: 1 }), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = verifyAttestation(cred, { now: () => 9_999_999_999 });
    assert.equal(v.ok, true);
  });
});

describe("ADR-139 on-chain cross-check", () => {
  function makeFetcher(view: OnChainProfileView | null): OnChainProfileFetcher {
    return {
      async fetch(_agentId: string) {
        return view;
      },
    };
  }

  it("passes when on-chain matches snapshot exactly", async () => {
    const snap = snapshot();
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const view: OnChainProfileView = {
      authority: snap.authority,
      reputation_score: snap.reputation_score,
      slash_count: snap.slash_count,
      registration_nonce: snap.registration_nonce,
    };
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher(view),
    });
    assert.equal(v.ok, true);
  });

  it("passes when on-chain slash_count has advanced past snapshot (monotonic)", async () => {
    const snap = snapshot({ slash_count: 1 });
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher({
        authority: snap.authority,
        reputation_score: snap.reputation_score,
        slash_count: 2,
        registration_nonce: snap.registration_nonce,
      }),
    });
    assert.equal(v.ok, true);
  });

  it("fails ONCHAIN_DIVERGENCE when slash_count regresses (suggests forged credential)", async () => {
    const snap = snapshot({ slash_count: 2 });
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher({
        authority: snap.authority,
        reputation_score: snap.reputation_score,
        slash_count: 1,
        registration_nonce: snap.registration_nonce,
      }),
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.reasons.some((r) => r.code === "ONCHAIN_DIVERGENCE"));
    }
  });

  it("fails ONCHAIN_DIVERGENCE when registration_nonce regresses (Sybil reuse)", async () => {
    const snap = snapshot({ registration_nonce: 5n });
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher({
        authority: snap.authority,
        reputation_score: snap.reputation_score,
        slash_count: snap.slash_count,
        registration_nonce: 4n,
      }),
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.reasons.some((r) => r.code === "ONCHAIN_DIVERGENCE"));
    }
  });

  it("fails ONCHAIN_DIVERGENCE when authority diverges", async () => {
    const snap = snapshot();
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher({
        authority: "OtherAuthority1111111111111111111111111111A",
        reputation_score: snap.reputation_score,
        slash_count: snap.slash_count,
        registration_nonce: snap.registration_nonce,
      }),
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.reasons.some((r) => r.code === "ONCHAIN_DIVERGENCE"));
    }
  });

  it("fails ONCHAIN_LOOKUP_FAILED when fetcher returns null", async () => {
    const cred = issueAttestation(snapshot(), {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher(null),
    });
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.ok(v.reasons.some((r) => r.code === "ONCHAIN_LOOKUP_FAILED"));
    }
  });

  it("tolerates reputation_score drift between snapshot and on-chain", async () => {
    // ADR-094 ±10 deltas are legitimate; the cross-check intentionally
    // does NOT enforce score equality.
    const snap = snapshot({ reputation_score: 50 });
    const cred = issueAttestation(snap, {
      issuer: issuer(),
      issuerUrl: "https://reputation.agenomics.io",
    });
    const v = await verifyAttestationWithChain(cred, {
      onChain: makeFetcher({
        authority: snap.authority,
        reputation_score: 60, // drifted upward
        slash_count: snap.slash_count,
        registration_nonce: snap.registration_nonce,
      }),
    });
    assert.equal(v.ok, true);
  });
});

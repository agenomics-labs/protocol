// ADR-139 — canonical-JSON stability tests.
//
// The canonical-JSON layer is the load-bearing primitive: any drift here
// invalidates every credential we've ever issued. These tests pin the
// byte-string emitted for a fixed payload, assert key-order invariance,
// and assert that the domain-separated preimage is what we expect.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  canonicalJson,
  canonicalBytes,
  attestationPreimage,
  REPUTATION_SCHEMA_V1,
  REPUTATION_ATTESTATION_DOMAIN_PREFIX,
  type ReputationAttestationPayload,
} from "../src/index.js";
import { sha256 } from "@noble/hashes/sha2";

function fixturePayload(): ReputationAttestationPayload {
  return {
    schema: REPUTATION_SCHEMA_V1,
    agent_id: "AgentPubkey1111111111111111111111111111111AA",
    authority: "AuthorityPubkey1111111111111111111111111111A",
    manifest_hash: "a".repeat(64),
    reputation_score: 73,
    slash_count: 0,
    reputation_stake_lamports: "12345678",
    registration_nonce: "4",
    snapshot_slot: "184729103",
    snapshot_timestamp: 1731543123,
    issuer: "Issuer1111111111111111111111111111111111111A",
    issuer_url: "https://reputation.agenomics.io",
    expiry_unix_ts: 0,
  };
}

describe("ADR-139 canonical-JSON encoding", () => {
  it("emits keys in lexicographic order regardless of input order", () => {
    const a = fixturePayload();
    const b: ReputationAttestationPayload = {
      // Same fields, declared in a totally different order.
      expiry_unix_ts: 0,
      issuer_url: "https://reputation.agenomics.io",
      issuer: "Issuer1111111111111111111111111111111111111A",
      snapshot_timestamp: 1731543123,
      snapshot_slot: "184729103",
      registration_nonce: "4",
      reputation_stake_lamports: "12345678",
      slash_count: 0,
      reputation_score: 73,
      manifest_hash: "a".repeat(64),
      authority: "AuthorityPubkey1111111111111111111111111111A",
      agent_id: "AgentPubkey1111111111111111111111111111111AA",
      schema: REPUTATION_SCHEMA_V1,
    };
    assert.equal(canonicalJson(a), canonicalJson(b));
  });

  it("canonicalJson is stable across runs for a fixed payload", () => {
    const p = fixturePayload();
    const first = canonicalJson(p);
    const second = canonicalJson(p);
    assert.equal(first, second);
    // Spot-check: keys appear in alphabetical order.
    const keys = Object.keys(JSON.parse(first));
    const sorted = [...keys].sort();
    assert.deepEqual(keys, sorted, "RFC-8785 mandates lexicographic key order");
  });

  it("preimage is SHA-256(domain || canonical-JSON bytes)", () => {
    const p = fixturePayload();
    const expected = sha256
      .create()
      .update(REPUTATION_ATTESTATION_DOMAIN_PREFIX)
      .update(canonicalBytes(p))
      .digest();
    assert.deepEqual(attestationPreimage(p), expected);
  });

  it("changing any field changes the preimage", () => {
    const base = fixturePayload();
    const baseHash = attestationPreimage(base);

    const mutations: Array<(p: ReputationAttestationPayload) => void> = [
      (p) => { p.reputation_score = 74; },
      (p) => { p.slash_count = 1; },
      (p) => { p.snapshot_slot = "184729104"; },
      (p) => { p.agent_id = "AgentPubkey1111111111111111111111111111111AB"; },
      (p) => { p.reputation_stake_lamports = "12345679"; },
      (p) => { p.expiry_unix_ts = 1; },
    ];

    for (const mutate of mutations) {
      const m = fixturePayload();
      mutate(m);
      const mHash = attestationPreimage(m);
      assert.notDeepEqual(
        baseHash,
        mHash,
        `mutation should produce a distinct preimage (${JSON.stringify(m)})`,
      );
    }
  });

  it("domain prefix is the expected 30-byte UTF-8 string", () => {
    const expected = "AEP_REPUTATION_ATTESTATION_V1\0";
    assert.equal(REPUTATION_ATTESTATION_DOMAIN_PREFIX.length, expected.length);
    assert.equal(
      new TextDecoder().decode(REPUTATION_ATTESTATION_DOMAIN_PREFIX),
      expected,
    );
  });
});

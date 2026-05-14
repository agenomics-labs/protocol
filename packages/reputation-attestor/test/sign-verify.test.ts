// ADR-139 — sign / verify round-trip + tampering tests.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  issueAttestation,
  issuerKeypairFromSecret,
  verifyAttestation,
  REPUTATION_SCHEMA_V1,
  type AgentProfileSnapshot,
  type ReputationCredential,
  decodeBase58,
  encodeBase58,
} from "../src/index.js";

function fixtureSnapshot(): AgentProfileSnapshot {
  return {
    agent_id: "AgentPubkey1111111111111111111111111111111AA",
    authority: "AuthorityPubkey1111111111111111111111111111A",
    manifest_hash: "b".repeat(64),
    reputation_score: 73,
    slash_count: 0,
    reputation_stake_lamports: 5_000_000_000n,
    registration_nonce: 4n,
    snapshot_slot: 184_729_103n,
    snapshot_timestamp: 1_731_543_123,
  };
}

function freshIssuer(seedByte = 0x42): { issuer: ReturnType<typeof issuerKeypairFromSecret>; secret: Uint8Array } {
  const secret = new Uint8Array(32).fill(seedByte);
  return { issuer: issuerKeypairFromSecret(secret), secret };
}

describe("ADR-139 sign / verify round-trip", () => {
  it("round-trips a valid credential", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
    });

    assert.equal(cred.schema, REPUTATION_SCHEMA_V1);
    assert.equal(cred.payload.schema, REPUTATION_SCHEMA_V1);
    assert.equal(cred.payload.reputation_score, 73);
    assert.equal(cred.payload.slash_count, 0);
    assert.equal(cred.payload.reputation_stake_lamports, "5000000000");
    assert.equal(cred.payload.issuer, issuer.publicKey);

    const verified = verifyAttestation(cred);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.payload.reputation_score, 73);
    }
  });

  it("rejects a flipped-signature credential", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
    });
    const tampered: ReputationCredential = {
      ...cred,
      signature: cred.signature.replace(/^./, (c) => (c === "f" ? "e" : "f")),
    };
    const verified = verifyAttestation(tampered);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.ok(
        verified.reasons.some((r) => r.code === "SIGNATURE_INVALID"),
        "expected SIGNATURE_INVALID reason",
      );
    }
  });

  it("rejects a payload that has been mutated post-signing", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
    });
    const tampered: ReputationCredential = {
      ...cred,
      payload: { ...cred.payload, reputation_score: 100 },
    };
    const verified = verifyAttestation(tampered);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.ok(verified.reasons.some((r) => r.code === "SIGNATURE_INVALID"));
    }
  });

  it("rejects when the schema discriminator is wrong", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
    });
    const wrong = {
      ...cred,
      schema: "agenomics.reputation.v2",
      payload: { ...cred.payload, schema: "agenomics.reputation.v2" },
    };
    const verified = verifyAttestation(wrong);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.ok(verified.reasons.some((r) => r.code === "SHAPE_INVALID"));
    }
  });

  it("rejects an unsigned-issuer credential", () => {
    const { issuer: real } = freshIssuer(0x42);
    const { issuer: forger, secret: forgerSecret } = freshIssuer(0x99);
    void forgerSecret;
    const credByForger = issueAttestation(fixtureSnapshot(), {
      issuer: forger,
      issuerUrl: "https://attacker.example",
    });
    const verified = verifyAttestation(credByForger, {
      allowedIssuers: [real.publicKey],
    });
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.ok(
        verified.reasons.some((r) => r.code === "ISSUER_NOT_ALLOWED"),
        "expected ISSUER_NOT_ALLOWED reason",
      );
    }
  });

  it("rejects an expired credential", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
      expiryUnixTs: 1_000,
    });
    const verified = verifyAttestation(cred, { now: () => 2_000 });
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.ok(verified.reasons.some((r) => r.code === "EXPIRED"));
    }
  });

  it("allows a perpetual credential with expiry_unix_ts === 0", () => {
    const { issuer } = freshIssuer();
    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
      expiryUnixTs: 0,
    });
    const verified = verifyAttestation(cred, { now: () => 9_999_999_999 });
    assert.equal(verified.ok, true);
  });

  it("issuer public key in payload matches the curve-derived key", () => {
    const { issuer, secret } = freshIssuer();
    const derived = encodeBase58(ed25519.getPublicKey(secret));
    assert.equal(issuer.publicKey, derived);

    const cred = issueAttestation(fixtureSnapshot(), {
      issuer,
      issuerUrl: "https://reputation.agenomics.io",
    });
    assert.equal(cred.payload.issuer, derived);

    const decoded = decodeBase58(cred.payload.issuer);
    assert.equal(decoded.length, 32);
  });
});

// ADR-139 — issuer key-loading + producer validation tests.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIssuerKeypair,
  issuerKeypairFromSecret,
  issueAttestation,
  type AgentProfileSnapshot,
} from "../src/index.js";
import { ed25519 } from "@noble/curves/ed25519";

function makeSolanaKeypairBytes(secret: Uint8Array): number[] {
  const pub = ed25519.getPublicKey(secret);
  const out = new Uint8Array(64);
  out.set(secret, 0);
  out.set(pub, 32);
  return Array.from(out);
}

function snapshot(): AgentProfileSnapshot {
  return {
    agent_id: "AgentPubkey1111111111111111111111111111111AA",
    authority: "AuthorityPubkey1111111111111111111111111111A",
    manifest_hash: "d".repeat(64),
    reputation_score: 42,
    slash_count: 0,
    reputation_stake_lamports: 0n,
    registration_nonce: 0n,
    snapshot_slot: 100n,
    snapshot_timestamp: 1_000,
  };
}

describe("ADR-139 loadIssuerKeypair", () => {
  it("loads a keypair from KEYPAIR_PATH (solana-keygen format)", () => {
    const secret = new Uint8Array(32).fill(0x10);
    const arr = makeSolanaKeypairBytes(secret);
    const dir = mkdtempSync(join(tmpdir(), "repattestor-"));
    const path = join(dir, "key.json");
    writeFileSync(path, JSON.stringify(arr));

    try {
      const kp = loadIssuerKeypair({
        REPUTATION_ATTESTOR_KEYPAIR_PATH: path,
      } as NodeJS.ProcessEnv);
      const fromSecret = issuerKeypairFromSecret(secret);
      assert.equal(kp.publicKey, fromSecret.publicKey);
      assert.equal(kp.secretKey.length, 32);
    } finally {
      try {
        unlinkSync(path);
      } catch {
        // best effort
      }
    }
  });

  it("loads a keypair from KEYPAIR_B64 (base64 raw bytes)", () => {
    const secret = new Uint8Array(32).fill(0x20);
    const fullBytes = Uint8Array.from(makeSolanaKeypairBytes(secret));
    const b64 = Buffer.from(fullBytes).toString("base64");
    const kp = loadIssuerKeypair({
      REPUTATION_ATTESTOR_KEYPAIR_B64: b64,
    } as NodeJS.ProcessEnv);
    assert.equal(kp.publicKey, issuerKeypairFromSecret(secret).publicKey);
  });

  it("throws a clear error when KMS_URI is set without an adapter", () => {
    assert.throws(
      () =>
        loadIssuerKeypair({
          REPUTATION_ATTESTOR_KMS_URI: "aws-kms://us-east-1/alias/agenomics",
        } as NodeJS.ProcessEnv),
      /KMS adapter/,
    );
  });

  it("throws when no env var is set", () => {
    assert.throws(
      () => loadIssuerKeypair({} as NodeJS.ProcessEnv),
      /no issuer key material/,
    );
  });

  it("throws on a malformed KEYPAIR_B64", () => {
    assert.throws(
      () =>
        loadIssuerKeypair({
          REPUTATION_ATTESTOR_KEYPAIR_B64: Buffer.from(new Uint8Array(10)).toString("base64"),
        } as NodeJS.ProcessEnv),
      /length must be 64/,
    );
  });
});

describe("ADR-139 issuer validation guards", () => {
  it("rejects out-of-range reputation_score", () => {
    const issuer = issuerKeypairFromSecret(new Uint8Array(32).fill(0x42));
    assert.throws(
      () =>
        issueAttestation(
          { ...snapshot(), reputation_score: 101 },
          { issuer, issuerUrl: "https://x" },
        ),
      /reputation_score/,
    );
  });

  it("rejects negative lamports", () => {
    const issuer = issuerKeypairFromSecret(new Uint8Array(32).fill(0x42));
    assert.throws(
      () =>
        issueAttestation(
          { ...snapshot(), reputation_stake_lamports: -1n },
          { issuer, issuerUrl: "https://x" },
        ),
      /reputation_stake_lamports/,
    );
  });

  it("rejects malformed manifest_hash", () => {
    const issuer = issuerKeypairFromSecret(new Uint8Array(32).fill(0x42));
    assert.throws(
      () =>
        issueAttestation(
          { ...snapshot(), manifest_hash: "not-hex" },
          { issuer, issuerUrl: "https://x" },
        ),
      /manifest_hash/,
    );
  });

  it("rejects missing issuerUrl", () => {
    const issuer = issuerKeypairFromSecret(new Uint8Array(32).fill(0x42));
    assert.throws(
      () =>
        issueAttestation(snapshot(), {
          issuer,
          issuerUrl: "" as unknown as string,
        }),
      /issuerUrl/,
    );
  });
});

// ADR-061 §2 schema-layer tests — AEP_AGENT_REPUTATION_v1 codec +
// SAS attestation-account header codec. These tests exercise the
// decoder/encoder in isolation from the resolver so a layout
// regression surfaces at the schema layer rather than as a
// resolver-level "absent" result.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  AEP_AGENT_REPUTATION_V1_SIZE,
  parseAttestationAccount,
  parseReputationData,
  toAttestationReputation,
} from "../src/index.js";
import {
  encodeAttestationAccount,
  encodeReputationData,
  encodeBase58,
} from "./fixtures.js";

describe("AEP_AGENT_REPUTATION_v1 codec", () => {
  it("round-trips all fields at their max values", () => {
    const fields = {
      score: 10_000,
      completed_tasks: 2 ** 32 - 1,
      dispute_ratio_bps: 10_000,
      last_updated: 1_700_000_000,
    };
    const bytes = encodeReputationData(fields);
    assert.equal(bytes.length, AEP_AGENT_REPUTATION_V1_SIZE);
    assert.deepEqual(parseReputationData(bytes), fields);
  });

  it("rejects oversize score / dispute_ratio", () => {
    assert.throws(() =>
      encodeReputationData({
        score: 10_001,
        completed_tasks: 0,
        dispute_ratio_bps: 0,
        last_updated: 0,
      }),
    );
    assert.throws(() =>
      encodeReputationData({
        score: 0,
        completed_tasks: 0,
        dispute_ratio_bps: 10_001,
        last_updated: 0,
      }),
    );
  });

  it("rejects a short buffer at decode", () => {
    assert.throws(() => parseReputationData(new Uint8Array(10)), /too short/);
  });

  it("rejects decoded values outside declared ranges (defense-in-depth)", () => {
    // Hand-build a 16-byte buffer with score=65535 — decoder must catch it
    // regardless of what the encoder would or wouldn't produce.
    const buf = new Uint8Array(16);
    const view = new DataView(buf.buffer);
    view.setUint16(0, 65_535, true); // score > 10000
    assert.throws(() => parseReputationData(buf), /score out of range/);
  });
});

describe("SAS attestation account codec", () => {
  it("round-trips a full attestation account with reputation data", () => {
    const subject = new Uint8Array(32).fill(0x11);
    const credential = new Uint8Array(32).fill(0x22);
    const schema = new Uint8Array(32).fill(0x33);
    const signer = new Uint8Array(32).fill(0x44);
    const nonce = new Uint8Array(32).fill(0x55);
    const data = encodeReputationData({
      score: 7500,
      completed_tasks: 42,
      dispute_ratio_bps: 250,
      last_updated: 1_699_000_000,
    });

    const bytes = encodeAttestationAccount({
      nonce,
      credential,
      schema,
      subject,
      signer,
      expiry: 1_800_000_000,
      data,
    });

    const raw = parseAttestationAccount(bytes);
    assert.deepEqual(raw.subject, subject);
    assert.deepEqual(raw.credential, credential);
    assert.deepEqual(raw.schema, schema);
    assert.deepEqual(raw.signer, signer);
    assert.deepEqual(raw.nonce, nonce);
    assert.equal(raw.expiry, 1_800_000_000);
    assert.deepEqual(raw.data, data);

    const rep = toAttestationReputation(parseReputationData(raw.data), {
      signer: encodeBase58(raw.signer),
      credential: encodeBase58(raw.credential),
      expiry: raw.expiry,
    });
    assert.equal(rep.score, 7500);
    assert.equal(rep.completed_tasks, 42);
    assert.equal(rep.dispute_ratio_bps, 250);
    assert.equal(rep.last_updated, 1_699_000_000);
    assert.equal(rep.expiry, 1_800_000_000);
  });

  it("rejects a truncated header", () => {
    assert.throws(() => parseAttestationAccount(new Uint8Array(100)), /too short/);
  });

  it("rejects a wrong discriminator byte", () => {
    const bytes = encodeAttestationAccount({
      nonce: new Uint8Array(32),
      credential: new Uint8Array(32),
      schema: new Uint8Array(32),
      subject: new Uint8Array(32),
      signer: new Uint8Array(32),
      expiry: 0,
      data: new Uint8Array(16),
    });
    bytes[0] = 99; // stomp the discriminator
    assert.throws(() => parseAttestationAccount(bytes), /discriminator mismatch/);
  });

  it("rejects a truncated data section (data_len > bytes)", () => {
    const bytes = encodeAttestationAccount({
      nonce: new Uint8Array(32),
      credential: new Uint8Array(32),
      schema: new Uint8Array(32),
      subject: new Uint8Array(32),
      signer: new Uint8Array(32),
      expiry: 0,
      data: new Uint8Array(16),
    });
    // Rewrite data_len to claim 9999 bytes — past the actual buffer end.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(169, 9_999, true);
    assert.throws(() => parseAttestationAccount(bytes), /truncated/);
  });

  it("maps expiry=0 to undefined in the public reputation shape", () => {
    const rep = toAttestationReputation(
      { score: 1, completed_tasks: 1, dispute_ratio_bps: 1, last_updated: 1 },
      { signer: "S".repeat(32), credential: "C".repeat(32), expiry: 0 },
    );
    assert.equal(rep.expiry, undefined);
  });
});

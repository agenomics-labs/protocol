// Test-only producer helpers for @agenomics/sas-resolver.
//
// These helpers live here (not in `src/`) because they are only used by
// the test harness — exposing them as part of the shipped public
// surface would lock the package into the exact byte layout forever
// (DEEP-AUDIT-2026-04-22 Audit 2 blockers #1 + #2). Real attestation
// producers go through SAS itself, not this package.
//
// The helpers wrap `encodeBase58` / `base58Decode` / `base64Encode` /
// `base64Decode` from `../src/resolver.js` so the test round-trips run
// against the exact same codec the resolver consumes — any drift would
// surface as a decode failure immediately.

import {
  encodeBase58,
  base58Decode,
  base64Encode,
  base64Decode,
} from "../src/resolver.js";

/** AEP_AGENT_REPUTATION_v1 — 16 bytes, little-endian, ADR-061 §2. */
export const AEP_AGENT_REPUTATION_V1_SIZE = 16;

/** SAS attestation account tag (discriminator byte at offset 0). */
const ATTESTATION_ACCOUNT_TAG = 2;
/** Fixed header prefix preceding the data blob. */
const ATTESTATION_HEADER_SIZE = 173;

export interface ReputationDataFields {
  score: number;
  completed_tasks: number;
  dispute_ratio_bps: number;
  last_updated: number;
}

/**
 * Producer helper — encode the 16-byte AEP_AGENT_REPUTATION_v1 data
 * slice. Mirrors `parseReputationData` in `src/schema.ts`.
 */
export function encodeReputationData(
  fields: ReputationDataFields,
): Uint8Array {
  if (fields.score > 10_000 || fields.score < 0) {
    throw new Error(`score out of range: ${fields.score}`);
  }
  if (fields.dispute_ratio_bps > 10_000 || fields.dispute_ratio_bps < 0) {
    throw new Error(
      `dispute_ratio_bps out of range: ${fields.dispute_ratio_bps}`,
    );
  }
  const buf = new Uint8Array(AEP_AGENT_REPUTATION_V1_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint16(0, fields.score, true);
  view.setUint32(2, fields.completed_tasks, true);
  view.setUint16(6, fields.dispute_ratio_bps, true);
  view.setBigInt64(8, BigInt(fields.last_updated), true);
  return buf;
}

/**
 * Producer helper — encode a raw SAS attestation account. Mirrors
 * `parseAttestationAccount` in `src/schema.ts`. Consumers producing
 * real attestations go through SAS itself; this is only used in the
 * test harness.
 */
export function encodeAttestationAccount(params: {
  nonce: Uint8Array;
  credential: Uint8Array;
  schema: Uint8Array;
  subject: Uint8Array;
  signer: Uint8Array;
  expiry: number;
  data: Uint8Array;
}): Uint8Array {
  assertLen(params.nonce, 32, "nonce");
  assertLen(params.credential, 32, "credential");
  assertLen(params.schema, 32, "schema");
  assertLen(params.subject, 32, "subject");
  assertLen(params.signer, 32, "signer");

  const total = ATTESTATION_HEADER_SIZE + params.data.length;
  const buf = new Uint8Array(total);
  buf[0] = ATTESTATION_ACCOUNT_TAG;
  buf.set(params.nonce, 1);
  buf.set(params.credential, 33);
  buf.set(params.schema, 65);
  buf.set(params.subject, 97);
  buf.set(params.signer, 129);

  const view = new DataView(buf.buffer);
  view.setBigInt64(161, BigInt(params.expiry), true);
  view.setUint32(169, params.data.length, true);
  buf.set(params.data, ATTESTATION_HEADER_SIZE);
  return buf;
}

function assertLen(bytes: Uint8Array, expected: number, name: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// Re-export the codec helpers so tests only import from `./fixtures.js`.
export { encodeBase58, base58Decode, base64Encode, base64Decode };

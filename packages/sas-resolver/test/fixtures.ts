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

/**
 * Fixed-overhead bytes in a SAS attestation account — the sum of every
 * field that isn't the variable-length `data` blob. Layout per
 * sas-lib@1.0.10's `getAttestationDecoder` codec:
 *
 *   discriminator(1) + nonce(32) + credential(32) + schema(32)
 *     + data_len(4) + data(N)
 *     + signer(32) + expiry(8) + tokenAccount(32)
 *
 * Total account size is `ATTESTATION_FIXED_OVERHEAD + N`. For our
 * AEP_AGENT_REPUTATION_v1 attestations N = 16, giving 189 bytes.
 */
const ATTESTATION_FIXED_OVERHEAD = 1 + 32 + 32 + 32 + 4 + 32 + 8 + 32;

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
 * `parseAttestationAccount` in `src/schema.ts`, which in turn mirrors
 * `sas-lib@1.0.10`'s `getAttestationEncoder` exactly.
 *
 * Layout (offsets are relative; data is variable-length so all fields
 * after `data` shift by N):
 *
 *   0          discriminator (= 2)        u8
 *   1          nonce                      Address(32)
 *   33         credential                 Address(32)
 *   65         schema                     Address(32)
 *   97         data_len                   u32 LE
 *   101        data                       data_len bytes (= N)
 *   101 + N    signer                     Address(32)
 *   133 + N    expiry                     i64 LE
 *   141 + N    tokenAccount               Address(32)
 *
 * There is no separate `subject` field in the SAS account. Per
 * ADR-061 §2 / our bootstrap-sas-attestation-devnet.ts convention,
 * the subject of an AEP attestation is encoded as the `nonce`. The
 * resolver compares its `subjectAuthority` parameter against
 * `attestation.nonce` for SUBJECT_MISMATCH detection.
 *
 * `tokenAccount` is unused by `@agenomics/sas-resolver` and defaults
 * to all zeros if omitted; the field is preserved here only so the
 * round-trip byte layout matches what SAS actually writes on-chain.
 *
 * Consumers producing real attestations go through SAS itself; this
 * helper is only used in the test harness.
 */
export function encodeAttestationAccount(params: {
  nonce: Uint8Array;
  credential: Uint8Array;
  schema: Uint8Array;
  signer: Uint8Array;
  expiry: number;
  data: Uint8Array;
  tokenAccount?: Uint8Array;
}): Uint8Array {
  assertLen(params.nonce, 32, "nonce");
  assertLen(params.credential, 32, "credential");
  assertLen(params.schema, 32, "schema");
  assertLen(params.signer, 32, "signer");
  const tokenAccount = params.tokenAccount ?? new Uint8Array(32);
  assertLen(tokenAccount, 32, "tokenAccount");

  const total = ATTESTATION_FIXED_OVERHEAD + params.data.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  buf[0] = ATTESTATION_ACCOUNT_TAG;
  buf.set(params.nonce, 1);
  buf.set(params.credential, 33);
  buf.set(params.schema, 65);
  view.setUint32(97, params.data.length, true);
  buf.set(params.data, 101);

  const signerOffset = 101 + params.data.length;
  buf.set(params.signer, signerOffset);
  view.setBigInt64(signerOffset + 32, BigInt(params.expiry), true);
  buf.set(tokenAccount, signerOffset + 40);

  return buf;
}

function assertLen(bytes: Uint8Array, expected: number, name: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${name} must be ${expected} bytes, got ${bytes.length}`);
  }
}

// Re-export the codec helpers so tests only import from `./fixtures.js`.
export { encodeBase58, base58Decode, base64Encode, base64Decode };

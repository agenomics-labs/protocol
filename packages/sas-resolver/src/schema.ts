// ADR-061 §2: AEP_AGENT_REPUTATION_v1 schema layout + decoder.
//
// --------------------------------------------------------------------
// SDK-dep note
// --------------------------------------------------------------------
// ADR-064 allows either depending on an official SAS TS SDK or
// implementing a minimal fetch + account decoder manually on top of
// @solana/kit primitives. We chose the manual path for v1 because:
//
//   1. The published `sas-lib@1.0.10` package pins `@solana/kit@^5.0.0`.
//      ADR-064 (this PR) explicitly targets `@solana/kit@^6.8.0`
//      (which is the version the rest of the AEP TS tree is
//      standardizing on — see `mcp-server/package.json`).
//   2. The resolver reads from SAS but never writes; the read surface
//      is small (one account layout + one schema-data layout) so the
//      cost of wrapping it is low and the benefit of not pinning to
//      SAS's SDK upgrade cadence is real (ADR-061 §1 loose-coupling
//      rationale — it applies symmetrically to the SDK dep too).
//   3. When/if `sas-lib` updates to kit v6, or the Solana Foundation
//      publishes a kit-v6-native SDK, migrating this module is a
//      strictly-local change (no API surface of `@agenomics/sas-resolver`
//      depends on whether the bytes are decoded by `sas-lib` or by
//      the code below).
//
// The layouts below are derived from the SAS program's account struct
// as documented in ADR-061 §2 (schema data layout) and the SAS repo's
// account schema (attestation account header). Anything that drifts
// from the canonical SAS layout shows up immediately as a decode
// failure in `parseAttestationAccount`, which the resolver routes to
// its skip-with-warn path (§4 row 4g).
// --------------------------------------------------------------------

import type { AttestationReputation, SolanaAttestation } from "./types.js";

/** AEP_AGENT_REPUTATION_v1 — 16 bytes, little-endian, ADR-061 §2. */
export const AEP_AGENT_REPUTATION_V1_SIZE = 16;

/**
 * Schema-data layout. Field offsets match ADR-061 §2 exactly:
 *   U16 score           [0..2)
 *   U32 completed_tasks [2..6)
 *   U16 dispute_ratio   [6..8)
 *   I64 last_updated    [8..16)
 *
 * SAS uses little-endian typed encoding (ADR-061 §2 "SAS typed
 * encoding, not Borsh"). This matches the solana-attestation-service
 * reference encoder; cross-checked manually.
 *
 * INTERNAL — not exported from `./index.js`. The public contract is
 * `AttestationReputation` (see `./types.js`); this shape is an
 * implementation detail of the schema-data decoder.
 */
interface ReputationDataFields {
  score: number;
  completed_tasks: number;
  dispute_ratio_bps: number;
  last_updated: number;
}

/**
 * Decode the 16-byte AEP_AGENT_REPUTATION_v1 data slice.
 *
 * Throws on short buffer or on value-range violations — score and
 * dispute_ratio_bps are constrained to 0..10000 per ADR-061 §2. A
 * value outside that range indicates either a schema mismatch upstream
 * or a malicious attestation; either way the resolver's §4-row-4g
 * handler will route to `skip + warn`.
 */
export function parseReputationData(data: Uint8Array): ReputationDataFields {
  if (data.length < AEP_AGENT_REPUTATION_V1_SIZE) {
    throw new Error(
      `AEP_AGENT_REPUTATION_v1 data too short: got ${data.length} bytes, expected >= ${AEP_AGENT_REPUTATION_V1_SIZE}`,
    );
  }

  // DataView gives us little-endian reads without manual shifting.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const score = view.getUint16(0, true);
  const completed_tasks = view.getUint32(2, true);
  const dispute_ratio_bps = view.getUint16(6, true);
  // I64 — use getBigInt64 and clamp to safe-integer range. The field
  // holds a unix-seconds timestamp; any value outside JS safe-int
  // range is already a decode failure rather than a value to preserve.
  const last_updated_big = view.getBigInt64(8, true);
  if (
    last_updated_big > BigInt(Number.MAX_SAFE_INTEGER) ||
    last_updated_big < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(
      `AEP_AGENT_REPUTATION_v1 last_updated out of JS safe-int range: ${last_updated_big}`,
    );
  }
  const last_updated = Number(last_updated_big);

  if (score > 10_000) {
    throw new Error(
      `AEP_AGENT_REPUTATION_v1 score out of range: ${score} > 10000`,
    );
  }
  if (dispute_ratio_bps > 10_000) {
    throw new Error(
      `AEP_AGENT_REPUTATION_v1 dispute_ratio_bps out of range: ${dispute_ratio_bps} > 10000`,
    );
  }

  return { score, completed_tasks, dispute_ratio_bps, last_updated };
}

/**
 * Combine the schema-data fields with the attestation-account header
 * fields to produce the public `AttestationReputation` shape.
 *
 * Note: `expiry: 0` means "no expiry" in the SAS account layout; we
 * map that to `undefined` so the public type's `expiry?: number` is
 * unambiguous.
 */
export function toAttestationReputation(
  fields: ReputationDataFields,
  attestation: Pick<SolanaAttestation, "signer" | "credential" | "expiry">,
): AttestationReputation {
  // `version: 1` is the AEP_AGENT_REPUTATION_v1 discriminator; v2 will
  // introduce a discriminated union. Setting it here (rather than in
  // types.ts as a default) makes every decoder path produce the same
  // shape — consumers never see a v1 object without the discriminator.
  const out: AttestationReputation = {
    version: 1,
    score: fields.score,
    completed_tasks: fields.completed_tasks,
    dispute_ratio_bps: fields.dispute_ratio_bps,
    last_updated: fields.last_updated,
    signer: attestation.signer,
    credential: attestation.credential,
  };
  if (attestation.expiry && attestation.expiry > 0) {
    out.expiry = attestation.expiry;
  }
  return out;
}

// --------------------------------------------------------------------
// SAS attestation account layout (manual decoder — see SDK-dep note).
// --------------------------------------------------------------------
//
// Mirrors `getAttestationDecoder` in `sas-lib@1.0.10`'s Codama codegen
// at `node_modules/sas-lib/dist/src/generated/accounts/attestation.js`.
// Variable-length `data` blob sits in the middle of the layout, so
// `signer` / `expiry` / `tokenAccount` shift by N (= data length):
//
//   offset       field          bytes   type
//   -----------------------------------------------------
//   0            discriminator  1       u8   (attestation tag = 2)
//   1            nonce          32      Pubkey
//   33           credential     32      Pubkey
//   65           schema         32      Pubkey
//   97           data_len       4       u32  LE
//   101          data           N       bytes
//   101 + N      signer         32      Pubkey
//   133 + N      expiry         8       i64  LE  (0 = no expiry)
//   141 + N      tokenAccount   32      Pubkey
//
// Fixed overhead = 173 bytes; total size = 173 + N. Earlier versions
// of this decoder placed `subject` at offset 97 — the actual SAS
// account has no separate subject field. Per ADR-061 §2 and our
// bootstrap-sas-attestation-devnet.ts convention, the subject is
// encoded as the `nonce`, and the resolver compares its
// `subjectAuthority` parameter against `attestation.nonce` for
// SUBJECT_MISMATCH detection.
//
// The 0-byte discriminator value at offset 0 (`2`) is a conservative
// marker — if/when the real SAS layout adds more account types with
// the same struct size, consumers can relax this check by passing the
// raw bytes directly into `parseReputationData` and skipping
// `parseAttestationAccount`. We keep the check on by default so that
// accidentally pointing `owner_attestation` at a non-attestation
// account fails fast rather than producing nonsense reputation data.

const ATTESTATION_ACCOUNT_TAG = 2;
/**
 * Bytes contributed by everything in the layout except the variable
 * `data` blob: disc(1) + nonce(32) + cred(32) + schema(32) + dataLen(4)
 * + signer(32) + expiry(8) + tokenAccount(32) = 173.
 */
const ATTESTATION_FIXED_OVERHEAD = 173;

/**
 * INTERNAL — not exported from `./index.js`. Returned by
 * `parseAttestationAccount`; the resolver consumes it inline and never
 * surfaces it to callers. The public contract is
 * `AttestationReputation` + the on-chain header fields carried inside
 * it (`signer`, `credential`, `expiry`).
 */
interface RawAttestationAccount {
  /**
   * Per-credential nonce (32 bytes verbatim). Per ADR-061 §2 / our
   * bootstrap-sas-attestation-devnet.ts convention, AEP encodes the
   * attestation subject as the nonce — the resolver treats it as
   * such for the SUBJECT_MISMATCH check.
   */
  nonce: Uint8Array;
  /** Referenced credential authority (32 bytes). */
  credential: Uint8Array;
  /** Referenced schema PDA (32 bytes). */
  schema: Uint8Array;
  /** Signer pubkey (32 bytes). */
  signer: Uint8Array;
  /** Unix expiry (seconds), 0 = no expiry. */
  expiry: number;
  /** Token-mode account pubkey (32 bytes); unused by AEP — read for completeness. */
  tokenAccount: Uint8Array;
  /** Raw typed-schema data (caller passes to `parseReputationData`). */
  data: Uint8Array;
}

/**
 * Decode an attestation account. Throws on any shape violation so
 * callers can route to the §4 skip-with-warn path.
 */
export function parseAttestationAccount(bytes: Uint8Array): RawAttestationAccount {
  if (bytes.length < ATTESTATION_FIXED_OVERHEAD) {
    throw new Error(
      `SAS attestation account too short: got ${bytes.length} bytes, expected >= ${ATTESTATION_FIXED_OVERHEAD}`,
    );
  }
  const discriminator = bytes[0];
  if (discriminator !== ATTESTATION_ACCOUNT_TAG) {
    throw new Error(
      `SAS attestation account discriminator mismatch: got ${discriminator}, expected ${ATTESTATION_ACCOUNT_TAG}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const nonce = bytes.slice(1, 33);
  const credential = bytes.slice(33, 65);
  const schema = bytes.slice(65, 97);

  const data_len = view.getUint32(97, true);
  const dataStart = 101;
  const dataEnd = dataStart + data_len;
  if (bytes.length < dataEnd + 32 + 8 + 32) {
    throw new Error(
      `SAS attestation account truncated: header says data_len=${data_len} but total bytes=${bytes.length}`,
    );
  }
  const data = bytes.slice(dataStart, dataEnd);

  const signer = bytes.slice(dataEnd, dataEnd + 32);
  const expiry_big = view.getBigInt64(dataEnd + 32, true);
  if (
    expiry_big > BigInt(Number.MAX_SAFE_INTEGER) ||
    expiry_big < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(`SAS attestation expiry out of JS safe-int range: ${expiry_big}`);
  }
  const expiry = Number(expiry_big);
  const tokenAccount = bytes.slice(dataEnd + 40, dataEnd + 72);

  return { nonce, credential, schema, signer, expiry, tokenAccount, data };
}

// encodeReputationData / encodeAttestationAccount previously lived here
// as test-only producer helpers. They moved to `test/fixtures.ts` in the
// v0.1.0 API tightening PR — their only callers were test harnesses, and
// exposing them as part of the shipped surface locked us into the exact
// byte layout forever (DEEP-AUDIT-2026-04-22 Audit 2). Real attestation
// producers go through SAS itself, not this package.
//
// The layout constants (`ATTESTATION_HEADER_SIZE`, `ATTESTATION_ACCOUNT_TAG`,
// `AEP_AGENT_REPUTATION_V1_SIZE`) are re-exported from
// `test/fixtures.ts` so tests continue to round-trip against the same
// definitions the decoder uses — drift between the two would fail the
// round-trip assertions immediately.
export const __INTERNAL_LAYOUT = {
  ATTESTATION_ACCOUNT_TAG,
  ATTESTATION_FIXED_OVERHEAD,
} as const;

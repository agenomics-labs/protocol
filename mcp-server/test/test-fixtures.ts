/**
 * Test-only producer helpers for mcp-server smoke tests.
 *
 * These helpers previously lived in the public surface of
 * `@agenomics/sas-resolver` and `@agenomics/capability-manifest-validator`
 * (as `encodeBase58` / `base58Decode` / `base64Encode` /
 * `encodeReputationData` / `encodeAttestationAccount` /
 * `canonicalJson` / `canonicalBytes`). They were demoted to
 * internal / `unstable_` prefixed in the v0.1.0 API tightening
 * (DEEP-AUDIT-2026-04-22 Audit 2).
 *
 * The mcp-server smoke test is a consumer — it cannot reach into the
 * resolver's internal codec exports without widening the public surface
 * again, and we deliberately do not. Instead, this file vendors the
 * minimal codec helpers so the smoke test can keep minting mock SAS
 * attestation accounts and canonical-JSON bytes without adding shipped
 * helpers.
 *
 * The logic is intentionally identical to the helpers in
 * `packages/sas-resolver/test/fixtures.ts` — if the resolver's parser
 * drifts, the smoke test's round-trip assertions will fail immediately.
 */

// --------------------------------------------------------------------
// Base58 codec — 32-byte Solana pubkeys, no dep.
// --------------------------------------------------------------------

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHABET[rem]! + out;
  }
  for (let i = 0; i < zeros; i++) out = "1" + out;
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  let num = 0n;
  for (const ch of s) {
    const v = B58_MAP[ch];
    if (v === undefined) throw new Error(`invalid base58 character: ${ch}`);
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

// --------------------------------------------------------------------
// Base64 codec — Node Buffer path (tests always run under Node).
// --------------------------------------------------------------------

export function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function base64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

// --------------------------------------------------------------------
// AEP_AGENT_REPUTATION_v1 + SAS attestation-account producer helpers.
// Mirror of `packages/sas-resolver/src/schema.ts` decoders.
// --------------------------------------------------------------------

export const AEP_AGENT_REPUTATION_V1_SIZE = 16;
const ATTESTATION_ACCOUNT_TAG = 2;
/**
 * Fixed-overhead bytes in a SAS attestation account — the sum of every
 * field that isn't the variable-length `data` blob, per sas-lib@1.0.10's
 * `getAttestationDecoder`:
 *
 *   discriminator(1) + nonce(32) + credential(32) + schema(32)
 *     + data_len(4) + data(N)
 *     + signer(32) + expiry(8) + tokenAccount(32)
 *
 * Total account size = `ATTESTATION_FIXED_OVERHEAD + N`.
 */
const ATTESTATION_FIXED_OVERHEAD = 1 + 32 + 32 + 32 + 4 + 32 + 8 + 32;

export interface ReputationDataFields {
  score: number;
  completed_tasks: number;
  dispute_ratio_bps: number;
  last_updated: number;
}

export function encodeReputationData(fields: ReputationDataFields): Uint8Array {
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
 * Mirrors `packages/sas-resolver/test/fixtures.ts:encodeAttestationAccount`,
 * which in turn matches `sas-lib@1.0.10`'s `getAttestationEncoder`.
 *
 * Layout:
 *   0          discriminator (= 2)        u8
 *   1          nonce                      Address(32)
 *   33         credential                 Address(32)
 *   65         schema                     Address(32)
 *   97         data_len                   u32 LE
 *   101        data                       N bytes
 *   101 + N    signer                     Address(32)
 *   133 + N    expiry                     i64 LE
 *   141 + N    tokenAccount               Address(32)
 *
 * SAS has no separate `subject` field on-chain — per ADR-061 §2 the
 * subject is encoded as the `nonce`. The resolver compares its
 * `subjectAuthority` parameter against `attestation.nonce` for
 * SUBJECT_MISMATCH detection. `tokenAccount` is unused by AEP and
 * defaults to all-zeros if omitted.
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

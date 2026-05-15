// ADR-139 — verifier-side helpers.
//
// `verifyAttestation(credential, opts)` runs the full check sequence:
//   1. Shape: payload + signature parse against the Zod schema.
//   2. Schema: `payload.schema === REPUTATION_SCHEMA_V1`.
//   3. Issuer scope: optional pinned allowlist of accepted issuer keys.
//   4. Signature: Ed25519 verify against the canonical-JSON preimage.
//   5. Expiry: if `expiry_unix_ts > 0`, reject if `now > expiry`.
//   6. Freshness: optional `maxSnapshotAgeSeconds` — reject snapshots
//      older than the caller's tolerance.
//
// Returns a structured `VerifyResult` with `reasons[]` so callers can
// surface every failed check. Per ADR-139 §7, NEVER short-circuit on
// the first failure — a malicious credential should expose every angle
// of attack to the operator.
//
// The "optional cross-check against current on-chain state" path lives
// in `crossCheckOnChain()` — verifiers that want it must provide an
// `OnChainProfileFetcher` and pass it via `opts.onChain`. The default
// path is signature-only and stateless.

import { ed25519 } from "@noble/curves/ed25519";
import {
  ReputationCredentialSchema,
  REPUTATION_SCHEMA_V1,
  type ReputationAttestationPayload,
  type ReputationCredential,
} from "./schema.js";
import { attestationPreimage } from "./canonical.js";
import { decodeBase58, hexDecode } from "./util.js";

/** Reasons a verification can fail. Stable across minor versions. */
export type VerifyReasonCode =
  | "SHAPE_INVALID"
  | "SCHEMA_MISMATCH"
  | "ISSUER_NOT_ALLOWED"
  | "SIGNATURE_INVALID"
  | "EXPIRED"
  | "STALE_SNAPSHOT"
  | "ONCHAIN_DIVERGENCE"
  | "ONCHAIN_LOOKUP_FAILED";

export interface VerifyReason {
  code: VerifyReasonCode;
  message: string;
  details?: unknown;
}

export interface VerifyResultOk {
  ok: true;
  payload: ReputationAttestationPayload;
  /** Diagnostic reasons collected during a successful verify (e.g. STALE warnings). */
  reasons: VerifyReason[];
}

export interface VerifyResultErr {
  ok: false;
  payload?: ReputationAttestationPayload;
  reasons: VerifyReason[];
}

export type VerifyResult = VerifyResultOk | VerifyResultErr;

/**
 * On-chain profile fetcher contract — caller-provided.
 *
 * The verifier never reaches the network directly. A consumer that
 * wants the optional cross-check (ADR-139 §3 verifier step 6) supplies
 * a fetcher that returns the current canonical view, or `null` if the
 * profile cannot be fetched. Returning `null` is treated as
 * `ONCHAIN_LOOKUP_FAILED` so the credential's other invariants still
 * surface to the operator.
 */
export interface OnChainProfileFetcher {
  fetch(agentId: string): Promise<OnChainProfileView | null>;
}

export interface OnChainProfileView {
  reputation_score: number;
  slash_count: number;
  registration_nonce: bigint;
  authority: string;
}

export interface VerifyOptions {
  /** Optional issuer allowlist; if set, `payload.issuer` must be present. */
  allowedIssuers?: readonly string[];
  /**
   * Maximum snapshot age in seconds. If set and the snapshot is older,
   * the verifier emits `STALE_SNAPSHOT` and (by default) fails the
   * credential. Set `0` or `undefined` to skip the freshness check.
   *
   * ADR-139 §7: even a perpetual credential needs a snapshot-freshness
   * guard at the verifier site — otherwise a 5-year-old "perfect score"
   * snapshot becomes a permanent ticket through every reputation gate.
   */
  maxSnapshotAgeSeconds?: number;
  /**
   * Unix-seconds clock for expiry / freshness. Defaults to `Date.now()`.
   * Tests freeze this; production callers should leave it unset.
   */
  now?: () => number;
  /** Optional on-chain cross-check. */
  onChain?: OnChainProfileFetcher;
}

/** Synchronous verification — no on-chain check. */
export function verifyAttestation(
  credential: unknown,
  opts: VerifyOptions = {},
): VerifyResult {
  const reasons: VerifyReason[] = [];

  // Stage 1 — shape.
  const parsed = ReputationCredentialSchema.safeParse(credential);
  if (!parsed.success) {
    reasons.push({
      code: "SHAPE_INVALID",
      message: "credential failed shape validation",
      details: { issues: parsed.error.issues },
    });
    return { ok: false, reasons };
  }
  const cred: ReputationCredential = parsed.data;
  const payload = cred.payload;

  // Stage 2 — schema.
  if (payload.schema !== REPUTATION_SCHEMA_V1 || cred.schema !== REPUTATION_SCHEMA_V1) {
    reasons.push({
      code: "SCHEMA_MISMATCH",
      message: `expected schema ${REPUTATION_SCHEMA_V1}, got ${payload.schema}`,
    });
    // Keep going — surface every reason.
  }

  // Stage 3 — issuer scope.
  if (
    opts.allowedIssuers &&
    opts.allowedIssuers.length > 0 &&
    !opts.allowedIssuers.includes(payload.issuer)
  ) {
    reasons.push({
      code: "ISSUER_NOT_ALLOWED",
      message: `issuer ${payload.issuer} is not in the allowed-issuer set`,
      details: { allowedCount: opts.allowedIssuers.length },
    });
  }

  // Stage 4 — signature.
  let sigOk = false;
  try {
    const sig = hexDecode(cred.signature);
    const pub = decodeBase58(payload.issuer);
    const preimage = attestationPreimage(payload);
    sigOk = ed25519.verify(sig, preimage, pub);
  } catch (e) {
    reasons.push({
      code: "SIGNATURE_INVALID",
      message: `Ed25519 verification threw: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
  if (!sigOk && !reasons.some((r) => r.code === "SIGNATURE_INVALID")) {
    reasons.push({
      code: "SIGNATURE_INVALID",
      message: "Ed25519 signature did not verify against the issuer pubkey",
    });
  }

  // Stage 5 — expiry.
  const now = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  if (payload.expiry_unix_ts > 0 && now > payload.expiry_unix_ts) {
    reasons.push({
      code: "EXPIRED",
      message: `credential expired at ${payload.expiry_unix_ts} (now ${now})`,
    });
  }

  // Stage 6 — snapshot freshness.
  if (
    typeof opts.maxSnapshotAgeSeconds === "number" &&
    opts.maxSnapshotAgeSeconds > 0
  ) {
    const age = now - payload.snapshot_timestamp;
    if (age > opts.maxSnapshotAgeSeconds) {
      reasons.push({
        code: "STALE_SNAPSHOT",
        message: `snapshot age ${age}s exceeds tolerance ${opts.maxSnapshotAgeSeconds}s`,
        details: { age, tolerance: opts.maxSnapshotAgeSeconds },
      });
    }
  }

  const hardFail = reasons.some(
    (r) =>
      r.code === "SCHEMA_MISMATCH" ||
      r.code === "ISSUER_NOT_ALLOWED" ||
      r.code === "SIGNATURE_INVALID" ||
      r.code === "EXPIRED" ||
      r.code === "STALE_SNAPSHOT",
  );

  if (hardFail) {
    return { ok: false, payload, reasons };
  }
  return { ok: true, payload, reasons };
}

/**
 * Async wrapper that runs `verifyAttestation` and, on success, performs
 * an optional on-chain cross-check. The on-chain values are compared
 * against the snapshot fields that should be monotonic between snapshot
 * and `now`:
 *
 *   - `slash_count`: on-chain MUST be >= snapshot (slashing is monotonic;
 *     ADR-094). A lower value indicates a forged credential.
 *   - `registration_nonce`: on-chain MUST be >= snapshot. A nonce that
 *     went backwards means the profile was closed-and-reopened (Sybil
 *     reuse defence in ADR-097), and the credential is referring to a
 *     previous incarnation.
 *   - `authority`: MUST match exactly — the same identity.
 *
 * `reputation_score` is intentionally NOT a cross-check field: it
 * fluctuates legitimately under ADR-094 ±10 deltas. The snapshot is the
 * point-in-time value; verifiers that need a current value should issue
 * a fresh attestation instead.
 */
export async function verifyAttestationWithChain(
  credential: unknown,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const base = verifyAttestation(credential, opts);
  if (!base.ok) return base;
  if (!opts.onChain) return base;

  const payload = base.payload;
  let view: OnChainProfileView | null;
  try {
    view = await opts.onChain.fetch(payload.agent_id);
  } catch (e) {
    return {
      ok: false,
      payload,
      reasons: [
        ...base.reasons,
        {
          code: "ONCHAIN_LOOKUP_FAILED",
          message: `on-chain fetch threw: ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      ],
    };
  }
  if (view === null) {
    return {
      ok: false,
      payload,
      reasons: [
        ...base.reasons,
        {
          code: "ONCHAIN_LOOKUP_FAILED",
          message: `agent profile ${payload.agent_id} not found on-chain`,
        },
      ],
    };
  }

  const divergences: string[] = [];
  if (view.authority !== payload.authority) {
    divergences.push(
      `authority diverged: snapshot=${payload.authority}, on-chain=${view.authority}`,
    );
  }
  if (view.slash_count < payload.slash_count) {
    divergences.push(
      `slash_count regressed: snapshot=${payload.slash_count}, on-chain=${view.slash_count}`,
    );
  }
  const snapshotNonce = BigInt(payload.registration_nonce);
  if (view.registration_nonce < snapshotNonce) {
    divergences.push(
      `registration_nonce regressed: snapshot=${payload.registration_nonce}, on-chain=${view.registration_nonce.toString()}`,
    );
  }

  if (divergences.length > 0) {
    return {
      ok: false,
      payload,
      reasons: [
        ...base.reasons,
        {
          code: "ONCHAIN_DIVERGENCE",
          message: "on-chain state diverges from snapshot in a way that invalidates the credential",
          details: { divergences },
        },
      ],
    };
  }
  return base;
}

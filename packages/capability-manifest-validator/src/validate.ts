// ADR-060: reference validator entry point.
//
// Takes the already-fetched manifest body, the on-chain integrity
// commitment (hash + Ed25519 signature), and the agent authority
// pubkey; returns a Result<CapabilityManifest>. IPFS / Arweave
// fetching is out of scope for this crate — a future indexer service
// owns that layer.

import { ed25519 } from "@noble/curves/ed25519";
import {
  CapabilityManifestSchema,
  type CapabilityManifest,
} from "./schema.js";
import { manifestHash } from "./canonical.js";

/**
 * Known validation error codes.
 *
 * Extensible: new values may be added in minor releases.
 */
export type KnownValidationErrorCode =
  | "SCHEMA_INVALID"
  | "HASH_MISMATCH"
  | "SIGNATURE_MISMATCH"
  | "INVALID_INPUT";

/**
 * Extensible: new values may be added in minor releases.
 *
 * Consumers performing exhaustive `switch` over this type should keep a
 * `default` branch. The `(string & {})` tail preserves the known
 * literal completions in editors while letting TS accept unknown codes
 * without a breaking type error.
 */
export type ValidationErrorCode = KnownValidationErrorCode | (string & {});

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  details?: unknown;
}

export type ValidationResult =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; error: ValidationError };

export interface ValidateInput {
  /** Raw parsed JSON object (unknown shape until schema-validated). */
  manifest: unknown;
  /** On-chain `AgentProfile.manifest_hash` (32 bytes, SHA-256). */
  onChainHash: Uint8Array;
  /** On-chain `AgentProfile.manifest_signature` (64 bytes, Ed25519). */
  onChainSignature: Uint8Array;
  /** On-chain `AgentProfile.authority` (32 bytes, Ed25519 pubkey). */
  authorityPubkey: Uint8Array;
}

/**
 * Validate an off-chain capability manifest against its on-chain
 * integrity commitment.
 *
 * Validation stages (fail-fast):
 *   1. Input shape: hash is 32 bytes, signature is 64 bytes,
 *      pubkey is 32 bytes.
 *   2. Schema: `manifest` conforms to ADR-060 §2 v1.0.
 *   3. Hash: SHA-256(RFC-8785(manifest)) === onChainHash.
 *   4. Signature: Ed25519.verify(onChainSignature, onChainHash, authorityPubkey) === true.
 *
 * Returns a typed `Result` so callers don't have to try/catch — the
 * crate is consumed by indexers and the MCP server where structured
 * errors are preferable to exceptions.
 */
export function validateManifest(input: ValidateInput): ValidationResult {
  const { manifest, onChainHash, onChainSignature, authorityPubkey } = input;

  // Stage 1: input shape.
  if (!(onChainHash instanceof Uint8Array) || onChainHash.length !== 32) {
    return fail("INVALID_INPUT", "onChainHash must be a 32-byte Uint8Array");
  }
  if (!(onChainSignature instanceof Uint8Array) || onChainSignature.length !== 64) {
    return fail(
      "INVALID_INPUT",
      "onChainSignature must be a 64-byte Uint8Array",
    );
  }
  if (!(authorityPubkey instanceof Uint8Array) || authorityPubkey.length !== 32) {
    return fail(
      "INVALID_INPUT",
      "authorityPubkey must be a 32-byte Uint8Array",
    );
  }

  // Stage 2: schema.
  const parsed = CapabilityManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return fail("SCHEMA_INVALID", "manifest failed schema validation", {
      issues: parsed.error.issues,
    });
  }

  // Stage 3: hash. Hash the ORIGINAL manifest (before Zod strip), since
  // that's the bytes the agent signed — re-serializing `parsed.data`
  // would silently drop unknown forward-compat fields and hash to a
  // different value.
  const computedHash = manifestHash(manifest);
  if (!bytesEqual(computedHash, onChainHash)) {
    return fail(
      "HASH_MISMATCH",
      "canonical-JSON hash of manifest does not match on-chain manifest_hash",
      {
        computed: toHex(computedHash),
        onChain: toHex(onChainHash),
      },
    );
  }

  // Stage 4: Ed25519 signature.
  // @noble/curves returns a boolean — any exception (bad encoding,
  // point-not-on-curve) is caught and mapped to a clean error.
  let sigOk: boolean;
  try {
    sigOk = ed25519.verify(onChainSignature, onChainHash, authorityPubkey);
  } catch (e) {
    return fail(
      "SIGNATURE_MISMATCH",
      `Ed25519 verification threw: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!sigOk) {
    return fail(
      "SIGNATURE_MISMATCH",
      "Ed25519 signature did not verify against authority pubkey",
    );
  }

  return { ok: true, manifest: parsed.data };
}

function fail(
  code: ValidationErrorCode,
  message: string,
  details?: unknown,
): ValidationResult {
  return { ok: false, error: { code, message, details } };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Re-export types and helpers for consumer convenience.
export { manifestHash } from "./canonical.js";

// DEEP-AUDIT-2026-04-22 Audit 2: canonicalJson / canonicalBytes were
// previously public. Demoted to `unstable_` prefixed aliases because
// exposing them locks the package into RFC-8785-via-`canonicalize`
// forever. Callers that need them should be aware that swapping to
// a faster canonicalization implementation is a SemVer-minor change;
// this prefix documents that.
export {
  canonicalJson as unstable_canonicalJson,
  canonicalBytes as unstable_canonicalBytes,
} from "./canonical.js";

export {
  CapabilityManifestSchema,
  MANIFEST_SCHEMA_V1_URL,
  type CapabilityManifest,
  type Capability,
  type CostEstimate,
  type RequiredCapability,
  type PreflightGate,
  type KnownPreflightGate,
  type SideEffect,
  type KnownSideEffect,
  type Stability,
  type KnownStability,
} from "./schema.js";

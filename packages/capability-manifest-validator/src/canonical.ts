// ADR-060 §3: RFC 8785 canonical JSON encoding.
//
// The manifest is serialized to RFC-8785 canonical JSON before hashing
// so that whitespace / key-order variations don't invalidate the
// on-chain hash. We delegate to the `canonicalize` npm package, which
// implements the RFC (https://datatracker.ietf.org/doc/html/rfc8785).
//
// ADR-092: a domain separator is prepended to the canonical JSON bytes
// before hashing to prevent cross-context hash collisions. The preimage
// is now: SHA-256(MANIFEST_HASH_DOMAIN_PREFIX || canonicalJsonBytes).

import canonicalize from "canonicalize";
import { sha256 } from "@noble/hashes/sha2";

/**
 * Domain separator prepended to canonical JSON bytes before SHA-256.
 *
 * Format: UTF-8 encoding of "AEP_CAPABILITY_MANIFEST_V1\0" (27 bytes).
 * The null byte terminates the fixed-length prefix and prevents
 * length-extension ambiguity between adjacent version strings.
 *
 * ADR-092: exported so callers can reference the exact prefix used when
 * building independent verification tooling.
 *
 * BREAKING (v0.2.0): hashes computed without this prefix (prior to ADR-092)
 * will not match. Stored on-chain `manifest_hash` values must be recomputed.
 */
export const MANIFEST_HASH_DOMAIN_PREFIX: Uint8Array =
  new TextEncoder().encode("AEP_CAPABILITY_MANIFEST_V1\0");

/**
 * Serialize an object to RFC-8785 canonical JSON.
 * @throws if the input contains cycles or non-JSON-representable values.
 */
export function canonicalJson(obj: unknown): string {
  const out = canonicalize(obj);
  if (typeof out !== "string") {
    // canonicalize() returns undefined for `undefined` inputs; AEP
    // manifests are always objects, so this is a usage error.
    throw new Error(
      "canonicalJson: input is not serializable to canonical JSON",
    );
  }
  return out;
}

/**
 * Encode `obj` as canonical JSON and return SHA-256 of its UTF-8 bytes,
 * domain-separated per ADR-092.
 *
 * Preimage: SHA-256(MANIFEST_HASH_DOMAIN_PREFIX || UTF-8(canonicalJson(obj)))
 *
 * This is exactly the preimage signed by the agent's authority and
 * stored on-chain as `AgentProfile.manifest_hash`.
 */
export function manifestHash(obj: unknown): Uint8Array {
  const canonical = canonicalJson(obj);
  const bytes = new TextEncoder().encode(canonical);
  return sha256
    .create()
    .update(MANIFEST_HASH_DOMAIN_PREFIX)
    .update(bytes)
    .digest();
}

/**
 * Canonical-JSON round-trip helper — useful for tests and for producers
 * that want to publish the exact byte-string that was hashed.
 */
export function canonicalBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(obj));
}

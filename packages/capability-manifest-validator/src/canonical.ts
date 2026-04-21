// ADR-060 §3: RFC 8785 canonical JSON encoding.
//
// The manifest is serialized to RFC-8785 canonical JSON before hashing
// so that whitespace / key-order variations don't invalidate the
// on-chain hash. We delegate to the `canonicalize` npm package, which
// implements the RFC (https://datatracker.ietf.org/doc/html/rfc8785).

import canonicalize from "canonicalize";
import { sha256 } from "@noble/hashes/sha2";

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
 * Encode `obj` as canonical JSON and return SHA-256 of its UTF-8 bytes.
 * This is exactly the preimage signed by the agent's authority and
 * stored on-chain as `AgentProfile.manifest_hash`.
 */
export function manifestHash(obj: unknown): Uint8Array {
  const canonical = canonicalJson(obj);
  const bytes = new TextEncoder().encode(canonical);
  return sha256(bytes);
}

/**
 * Canonical-JSON round-trip helper — useful for tests and for producers
 * that want to publish the exact byte-string that was hashed.
 */
export function canonicalBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(obj));
}

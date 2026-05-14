// ADR-139 §3 — RFC 8785 canonical-JSON encoding for the reputation
// attestation preimage.
//
// We use the same `canonicalize` package and the same domain-separation
// pattern as `@agenomics/capability-manifest-validator`'s `canonical.ts`
// (ADR-060 / ADR-092). The literal domain prefix is different — see
// `schema.ts` `REPUTATION_ATTESTATION_DOMAIN_PREFIX` — so a manifest
// signature can never accidentally be re-interpreted as a reputation
// attestation signature, even if the canonical-JSON bytes coincide.

import canonicalize from "canonicalize";
import { sha256 } from "@noble/hashes/sha2";
import {
  REPUTATION_ATTESTATION_DOMAIN_PREFIX,
  type ReputationAttestationPayload,
} from "./schema.js";

/**
 * Serialise a `ReputationAttestationPayload` to RFC-8785 canonical JSON.
 * @throws if the input is not serialisable (cycles, non-JSON values).
 */
export function canonicalJson(payload: ReputationAttestationPayload): string {
  const out = canonicalize(payload as unknown as Record<string, unknown>);
  if (typeof out !== "string") {
    throw new Error(
      "canonicalJson: payload is not serialisable to canonical JSON",
    );
  }
  return out;
}

/** UTF-8 encoded canonical-JSON bytes. Useful for direct hashing / diffing. */
export function canonicalBytes(
  payload: ReputationAttestationPayload,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(payload));
}

/**
 * Compute the domain-separated SHA-256 preimage that the issuer signs.
 *
 *   preimage = SHA-256( REPUTATION_ATTESTATION_DOMAIN_PREFIX || canonicalJsonBytes )
 *
 * This is what Ed25519 ultimately verifies against — the wire-format
 * `signature` is `Ed25519.sign(issuerKey, preimage)`.
 *
 * Domain-separating the preimage prevents an issuer's signature over a
 * manifest body, or any other AEP signing context, from being replayed
 * as a reputation attestation.
 */
export function attestationPreimage(
  payload: ReputationAttestationPayload,
): Uint8Array {
  const bytes = canonicalBytes(payload);
  return sha256
    .create()
    .update(REPUTATION_ATTESTATION_DOMAIN_PREFIX)
    .update(bytes)
    .digest();
}

export { REPUTATION_ATTESTATION_DOMAIN_PREFIX } from "./schema.js";

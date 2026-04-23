// ADR-061 §3 + ADR-076: credential-authority allowlist handling.
//
// The v1 AEP-published credentials are `AEP_PROTOCOL` and
// `AEP_VALIDATORS` — but their concrete pubkeys are environment-
// specific (devnet / mainnet-beta may bind different authorities
// during the bootstrap ceremony, tracked as ADR-063). This package
// therefore does NOT hardcode the pubkeys; consumers inject them via
// `ResolverConfig.allowedCredentials`.
//
// ADR-076 (drafted alongside this PR per DEEP-AUDIT-2026-04-22 SEC-3)
// expands the entry shape from "bare authority pubkey" to "authority +
// optional signer list + optional authorized-schema list" so a leaked
// credential-authority key cannot mint attestations for any schema,
// and cannot be bypassed by an unintended signer. The flat v0 shape
// (`string[]` → `Set<string>`) is still accepted for back-compat — it
// maps to `{ authority, signers: undefined, authorizedSchemas: undefined }`
// ("any signer, any schema"), which is v1's behaviour.
//
// This module provides:
//   - `buildAllowlist(...)` — canonical builder, returns a keyed Map so
//     the resolver can look up per-credential scoping in O(1).
//   - `normalizeAllowlist(...)` — accepts either shape (Set or Map)
//     and yields a single canonical Map; used inside the resolver.
//   - `isAllowed(map, credential)` — presence check, preserved for
//     back-compat with tests.
//
// Validation happens synchronously on the way in so typos surface at
// config time, not at the first attestation. Every pubkey string
// passes a base58 shape check.

import type { AllowedCredential } from "./types.js";

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AllowlistEntry {
  /** Base58 credential authority pubkey. */
  pubkey: string;
  /** Optional human label ("AEP_PROTOCOL", "AEP_VALIDATORS", ...). */
  label?: string;
}

/**
 * Build an allowlist from a heterogeneous list of entries.
 *
 * Accepted input forms:
 *   - `"CredPubkeyBase58"` — flat v0 shape. Maps to "any signer,
 *     any schema".
 *   - `{ pubkey: "...", label: "..." }` — the legacy
 *     `AllowlistEntry` shape, no scoping.
 *   - `{ authority: "...", signers?: [...], authorizedSchemas?: [...] }`
 *     — the ADR-076 `AllowedCredential` shape, with per-credential
 *     scoping.
 *
 * Returns a canonical `Map<authority, AllowedCredential>`. Duplicate
 * authorities throw — a second `AEP_VALIDATORS` entry with different
 * scoping is almost always a config bug. Invalid base58 (authority or
 * any signer / schema pubkey) throws synchronously.
 */
export function buildAllowlist(
  entries: ReadonlyArray<string | AllowlistEntry | AllowedCredential>,
): Map<string, AllowedCredential> {
  const out = new Map<string, AllowedCredential>();
  for (const entry of entries) {
    const canon = canonicalize(entry);
    if (out.has(canon.authority)) {
      throw new Error(
        `buildAllowlist: duplicate credential authority: ${canon.authority}`,
      );
    }
    out.set(canon.authority, canon);
  }
  return out;
}

/**
 * Normalize `ResolverConfig.allowedCredentials` to the canonical Map
 * shape. Accepts either form (`Set<string>` — flat v0 — or
 * `Map<string, AllowedCredential>` — scoped v1) and returns a Map.
 *
 * Invoked by the resolver constructor so both shapes work as config.
 */
export function normalizeAllowlist(
  input: Set<string> | Map<string, AllowedCredential>,
): Map<string, AllowedCredential> {
  if (input instanceof Map) {
    // Validate every entry even if the caller already built the Map —
    // cheap, and catches drift between `buildAllowlist` and hand-rolled
    // Maps.
    for (const entry of input.values()) {
      validateCredential(entry);
    }
    return input;
  }
  if (input instanceof Set) {
    const out = new Map<string, AllowedCredential>();
    for (const pubkey of input) {
      if (typeof pubkey !== "string" || !BASE58_REGEX.test(pubkey)) {
        throw new Error(
          `normalizeAllowlist: invalid base58 credential pubkey: ${JSON.stringify(pubkey)}`,
        );
      }
      out.set(pubkey, { authority: pubkey });
    }
    return out;
  }
  throw new Error(
    "normalizeAllowlist: input must be a Set<string> or Map<string, AllowedCredential>",
  );
}

/**
 * Is the given credential pubkey present in the allowlist?
 *
 * Accepts either a canonical Map (new shape) or a Set (flat v0) so
 * legacy tests keep working. For per-credential scoping (signer /
 * schema), consumers go through `SasResolver.resolve` — this helper
 * only answers the presence question.
 */
export function isAllowed(
  allowlist: Set<string> | Map<string, AllowedCredential>,
  credential: string,
): boolean {
  return allowlist.has(credential);
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

function canonicalize(
  entry: string | AllowlistEntry | AllowedCredential,
): AllowedCredential {
  if (typeof entry === "string") {
    requireBase58(entry, "authority");
    return { authority: entry };
  }
  if (entry && typeof entry === "object") {
    // Distinguish `AllowlistEntry` (legacy, `pubkey`) from
    // `AllowedCredential` (new, `authority`). Prefer `authority`.
    const maybeAuthority =
      "authority" in entry && typeof (entry as AllowedCredential).authority === "string"
        ? (entry as AllowedCredential).authority
        : "pubkey" in entry && typeof (entry as AllowlistEntry).pubkey === "string"
          ? (entry as AllowlistEntry).pubkey
          : undefined;
    if (!maybeAuthority) {
      throw new Error(
        `buildAllowlist: entry must have 'authority' or 'pubkey': ${JSON.stringify(entry)}`,
      );
    }
    requireBase58(maybeAuthority, "authority");
    const signers =
      "signers" in entry && (entry as AllowedCredential).signers !== undefined
        ? (entry as AllowedCredential).signers
        : undefined;
    const authorizedSchemas =
      "authorizedSchemas" in entry &&
      (entry as AllowedCredential).authorizedSchemas !== undefined
        ? (entry as AllowedCredential).authorizedSchemas
        : undefined;
    if (signers !== undefined) {
      if (!Array.isArray(signers)) {
        throw new Error(
          `buildAllowlist: signers must be an array of base58 pubkey strings`,
        );
      }
      for (const s of signers) requireBase58(s, "signer");
    }
    if (authorizedSchemas !== undefined) {
      if (!Array.isArray(authorizedSchemas)) {
        throw new Error(
          `buildAllowlist: authorizedSchemas must be an array of base58 pubkey strings`,
        );
      }
      for (const s of authorizedSchemas) {
        requireBase58(s, "authorizedSchema");
      }
    }
    const out: AllowedCredential = {
      authority: maybeAuthority,
      ...(signers !== undefined ? { signers: [...signers] } : {}),
      ...(authorizedSchemas !== undefined
        ? { authorizedSchemas: [...authorizedSchemas] }
        : {}),
    };
    return out;
  }
  throw new Error(`buildAllowlist: unsupported entry shape: ${JSON.stringify(entry)}`);
}

function validateCredential(c: AllowedCredential): void {
  requireBase58(c.authority, "authority");
  if (c.signers) {
    for (const s of c.signers) requireBase58(s, "signer");
  }
  if (c.authorizedSchemas) {
    for (const s of c.authorizedSchemas) requireBase58(s, "authorizedSchema");
  }
}

function requireBase58(value: unknown, field: string): void {
  if (typeof value !== "string" || !BASE58_REGEX.test(value)) {
    throw new Error(
      `buildAllowlist: invalid base58 ${field}: ${JSON.stringify(value)}`,
    );
  }
}

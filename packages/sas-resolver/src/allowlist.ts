// ADR-061 §3: credential authority allowlist handling.
//
// The v1 AEP-published credentials are `AEP_PROTOCOL` and
// `AEP_VALIDATORS` — but their concrete pubkeys are environment-
// specific (devnet / mainnet-beta may bind different authorities
// during the bootstrap ceremony, tracked as ADR-063). This package
// therefore does NOT hardcode the pubkeys; consumers inject them via
// `ResolverConfig.allowedCredentials`.
//
// This module provides:
//   - `buildAllowlist(...)` — validates base58 shape on the way in so
//     a typo surfaces at config time, not at the first attestation.
//   - `isAllowed(set, credential)` — the check used by the resolver
//     (simple `Set<string>.has`, wrapped so the comparison surface is
//     a single function for future extension: tag-based matching,
//     revocation cache, etc.).

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface AllowlistEntry {
  /** Base58 credential authority pubkey. */
  pubkey: string;
  /** Optional human label ("AEP_PROTOCOL", "AEP_VALIDATORS", ...). */
  label?: string;
}

/**
 * Build an allowlist from a list of credential-authority pubkeys.
 *
 * Accepts either plain base58 strings or `{ pubkey, label }` objects.
 * Duplicates are collapsed. Invalid base58 throws synchronously so
 * the caller sees a config error at boot, not an attestation miss at
 * steady state.
 */
export function buildAllowlist(entries: Array<string | AllowlistEntry>): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    const pubkey = typeof entry === "string" ? entry : entry.pubkey;
    if (typeof pubkey !== "string" || !BASE58_REGEX.test(pubkey)) {
      throw new Error(
        `buildAllowlist: invalid base58 credential pubkey: ${JSON.stringify(pubkey)}`,
      );
    }
    out.add(pubkey);
  }
  return out;
}

/**
 * Is the given credential pubkey present in the allowlist?
 *
 * Wrapped so a future enhancement (tag-based resolution, revocation
 * hooks, tiered trust levels — see ADR-061 §3 "Explicitly not blessed
 * in v1") is a one-file change. Callers should go through this
 * function instead of poking `Set.has` directly.
 */
export function isAllowed(allowlist: Set<string>, credential: string): boolean {
  return allowlist.has(credential);
}

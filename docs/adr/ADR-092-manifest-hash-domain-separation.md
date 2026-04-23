# ADR-092 — Capability Manifest Hash Domain Separation

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-04-23 |

## Context

The capability-manifest-validator computes SHA-256 over canonical manifest JSON
without a domain separator. This creates a cross-context collision risk: identical
canonical bytes from different protocol objects (e.g. a future credential type)
would produce the same hash.

Concretely, if a future AEP object type (such as an agent credential or a
settlement record) serialises to the same RFC-8785 canonical JSON as a capability
manifest, both objects share the same SHA-256 preimage and therefore the same
hash. An attacker who can craft such a collision could substitute one object type
for the other in contexts that rely on the hash alone (e.g. on-chain
`manifest_hash` storage, off-chain caches, or audit logs).

## Decision

Prepend the domain separator `"AEP_CAPABILITY_MANIFEST_V1\x00"` (UTF-8 encoded,
null-byte terminated) to the canonical JSON bytes before hashing:

```
hash = SHA-256(domainPrefix || canonicalJson)
```

where `domainPrefix = Buffer.from("AEP_CAPABILITY_MANIFEST_V1\0", "utf8")` (27 bytes).

The null byte terminates the domain string, preventing length-extension ambiguity:
a future prefix `"AEP_CAPABILITY_MANIFEST_V12"` (no null) cannot be made to
collide by prepending `"AEP_CAPABILITY_MANIFEST_V1\0..."` bytes.

The constant `MANIFEST_HASH_DOMAIN_PREFIX` is exported from the package so
callers can reference it when building their own verification tooling.

This is a breaking change for any stored hashes; callers must rehash on upgrade.

## Alternatives

- **HMAC with a shared key**: stronger isolation guarantee but requires key
  management infrastructure. Overkill for a domain-separation problem where the
  separator is public by design.
- **Version field in JSON**: softer separation — the field only prevents
  collisions if both objects parse each other's schema. Does not prevent
  hash collisions before field validation runs.
- **Separate hash function per type**: combinatorially complex to manage as the
  number of AEP object types grows.

## Consequences

- **Breaking:** existing on-chain `manifest_hash` fields computed without the
  prefix are invalid after this change. Any stored hash computed by
  `manifestHash()` prior to v0.2.0 will not match the output of the updated
  function.
- **Migration:** re-upload manifests or emit both old and new hashes during a
  transition window. Indexers must re-index all stored manifests.
- **Future versions:** a future manifest schema version increments the prefix
  string (e.g. `"AEP_CAPABILITY_MANIFEST_V2\0"`), ensuring each version has an
  isolated hash space.

## References

- Architecture Audit 2026-04-23, Item 17, Sec 6.3
- ADR-060 (capability manifest spec)
- ADR-026 (3-tier model routing)

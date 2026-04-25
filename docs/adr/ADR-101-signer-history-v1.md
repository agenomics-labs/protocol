# ADR-101 — Per-credential SignerHistoryV1: hard-fail on undefined signers

## Status

Accepted

## Date

2026-04-23

## Context
The SAS resolver processes credential entries that include a `signers` field
tracking historical signers. When `entry.signers === undefined`, the resolver
currently silently bypasses signer validation, allowing unsigned or history-free
credentials to pass. This is a silent security failure mode.

Specifically, in `packages/sas-resolver/src/resolver.ts` the guard at the
per-credential signer scoping step reads:

```typescript
if (entry.signers && !entry.signers.includes(signer)) {
  // skip-with-warn
}
```

When `entry.signers` is `undefined` (or `[]`), the condition short-circuits and
signer validation is skipped entirely. A credential configured without a signer
list passes validation regardless of who signed the attestation.

## Decision
(Option B — hard-fail, simpler than full on-chain SignerHistoryV1 account)
When `entry.signers` is `undefined` or empty, the resolver throws
`SignerHistoryMissingError` with a descriptive message. Callers must handle
this error explicitly. The error is exported so callers can distinguish it
from general resolution failures.

The guard becomes:

```typescript
if (!entry.signers || entry.signers.length === 0) {
  throw new SignerHistoryMissingError(entry.authority ?? "unknown");
}
if (!entry.signers.includes(signer)) {
  // existing skip-with-warn
}
```

## Alternatives
- Option A: Per-credential on-chain `SignerHistoryV1` account — correct long-term
  but requires new on-chain state and program changes. Deferred to post-v0.1.0.
- Silent fallback: status quo — unacceptable for a security-critical check.

## Consequences
- Any credential without signer history now hard-fails instead of silently passing.
- Callers that previously relied on the silent pass must be updated.
- Error is typed and exported so callers can catch specifically.
- The flat v0 shape (`Set<string>` of bare pubkeys, which maps to
  `{ authority, signers: undefined }`) will now throw when a signer check is
  required. Consumers using the flat shape must migrate to the scoped
  `AllowedCredential` shape with an explicit `signers` list.

## References
- Architecture Audit 2026-04-23, Item 24, Sec 3.1 / 3.2
- ADR-076 §3 (per-credential signer scoping)
- DEEP-AUDIT-2026-04-22 SEC-3

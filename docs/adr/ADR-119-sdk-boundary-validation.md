# ADR-119: SDK boundary validation and PDA derivation completion

## Status
Proposed

## Date
2026-04-24

## Context

`@agenomics/client` (ADR-098, PR #51) and `@agenomics/idl` (ADR-099,
PR #50) are both shipping with gaps that re-audit surfaced:

- **R-offchain-03.** `sdk/client/src/index.ts:42-49`
  `deriveAgentProfilePda(ownerPubkey, nonce?)` is a stub throwing
  "not implemented" at runtime. Callers get no compile-time signal —
  the method is typed as returning `string`. `ownerPubkey: string` is
  not validated (empty string, non-base58, wrong-length all accepted
  into the method body).
- **R-offchain-04.** `sdk/idl/src/index.ts:27-29` `getProgramIds`
  indexes a `Record<Cluster, ProgramIds>` with the untyped
  `cluster` parameter. Typos (`"mainnit-beta"`) silently return
  `undefined`; callers crash on `.agentRegistry` deref.

Both PRs are also failing the `Anchor Build & IDL Diff` CI check. The
build failure itself is a separate investigation (workspace setup
mismatch likely), but regardless of how it lands, the SDK surface
ships with thin validation.

## Decision

Two small hardening changes, one per SDK package. Both land as follow-ups
to PR #50 and PR #51 respectively (or as in-place amendments if the
PRs haven't merged).

### `@agenomics/client`

1. **Implement `deriveAgentProfilePda` properly.** Use the existing
   Anchor seed derivation `[authorityPubkey.toBytes(),
   b"agent-profile", nonceBytes]`, matching `agent-registry`'s
   on-chain PDA (ADR-097 nonce-seed).
2. **Validate inputs at the module boundary.**
   `isValidPublicKey(ownerPubkey: string): PublicKey` throws a typed
   `InvalidInputError` on malformed input. Every exported method
   passes its pubkey args through this first.
3. **Error surface:** export `InvalidInputError`, `NotInitializedError`,
   `ProgramIdMismatchError` as typed classes so SDK consumers can
   `instanceof` them.

### `@agenomics/idl`

1. **Cluster guard.** `getProgramIds(cluster: Cluster): ProgramIds`
   throws `UnknownClusterError` if the key is missing from
   `PROGRAM_IDS`. TypeScript already narrows at compile time for
   well-typed callers; the runtime guard handles JS callers or
   runtime-string callers (config files, env vars).
2. **Version-pin the vendored IDL.** Add a `version` field at the top
   of each IDL JSON (if not already present) and a test that asserts
   it matches the on-chain program's `Cargo.toml` version.
3. **Drift detector.** Add a `npm run check:drift` script that
   compares the vendored IDL SHA-256 with the
   `target/idl/*.json` produced by `anchor build`. CI invokes this
   after `anchor build` in the same job.

Both changes are minimally invasive — they add validation surface,
they do not change existing method signatures.

## Consequences

- PR #50 and PR #51 close with a usable SDK surface, not a stub.
- Invalid inputs fail fast at the SDK boundary rather than as a
  cryptic RPC error three layers in.
- Drift between vendored IDL and on-chain layout surfaces in CI
  instead of at third-party integration time.
- Forward-compat: future registry/vault method additions flow
  through `isValidPublicKey` with no per-method repetition.

## References

- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-offchain-03, R-offchain-04.
- `docs/adr/ADR-088-typed-anchor-program-clients.md` (parent pattern).
- `docs/adr/ADR-098-sdk-client-package.md`.
- `docs/adr/ADR-099-sdk-idl-package.md`.
- `sdk/client/src/index.ts:42-49`.
- `sdk/idl/src/index.ts:27-29`.

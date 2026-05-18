# ADR-141: Codama-generated Anchor clients (replace hand-written SDK wrappers)

## Status

Accepted

## Date

2026-05-18

## Context

`@agenomics/client@0.1.0` (ADR-098) ships **hand-written** Anchor wrappers
for the three on-chain programs: `AgentRegistryClient`, `AgentVaultClient`,
`SettlementClient`. Each wrapper hand-codes:

- PDA seed derivation (`profilePda`, `vaultPda`, `escrowPda`, `ownerNoncePda`)
- typed account fetchers (`fetchProfile`, `fetchVault`, `fetchEscrow`)
- a small set of high-level helpers (`clampReputationScore`,
  `vaultIdentityBindMessage`, `buildVaultIdentityBindInstruction`)

ADR-098 explicitly **defers instruction builders** (`registerAgent`,
`initializeVault`, `createEscrow`, `acceptTask`, etc.) to a later
release. The current `examples/register-agent.ts` is read-only by
admission, and the README tells consumers to "build a `registerAgent`
transaction against the agent-registry program" themselves. This is the
single largest gap in the builder experience surfaced by the 2026-04-30
DX audit (this branch's prior turn): every Solana-SDK competitor ships
typed instruction builders on day one.

Three converging signals make hand-written wrappers the wrong shape:

1. **Drift risk.** `idl/*.json` is the source of truth (per ADR-082
   parity hook + `scripts/sync-idl.sh`). Hand-written wrappers mirror
   the IDL by convention only; a field rename or seed reorder lands in
   `idl/*.json` and silently diverges from the SDK until a consumer
   notices.
2. **Codama is now the Solana ecosystem default.** Helius, Metaplex,
   Squads, Drift, Marinade, Jupiter, Light Protocol have all migrated
   from hand-written clients to Codama-generated ones. Codama
   (formerly Kinobi) consumes Anchor IDL and emits typed JS/TS clients
   targeting either `@solana/kit` or `@solana/web3.js`.
3. **Zero-cost instruction builders.** Codama emits a typed builder
   per instruction — `getRegisterAgentInstruction({...})` — with full
   account inference, encoder generation, and discriminator wiring. The
   work ADR-098 deferred is what Codama produces by default.

Adjacent ADRs that bear on this decision:

- ADR-088 (typed Anchor program clients) — applied in mcp-server but
  flagged Drifted in `sdk/client/` (`(program.account as any)` casts).
  Codama generation is a stricter form of the same intent.
- ADR-099 (`@agenomics/idl` package) — already vendors `idl/*.json` and
  exports cluster-keyed program IDs. Codama consumes exactly that.
- ADR-087 (Solana Kit dual-stack) — Codama can target either v1
  (`@solana/web3.js`) or v2 (`@solana/kit`); we can dual-target.
- ADR-133 (handlers-v2 wave deferral) — independent. Codama generation
  is orthogonal to the v1 → v2 migration of mcp-server handlers.

## Decision

**Adopt Codama as the source-of-truth → typed-client codegen pipeline
for `@agenomics/client@0.2.0`. The hand-written wrappers from ADR-098
become a thin ergonomic veneer over Codama-generated primitives;
instruction builders ship via codegen, not by hand.**

### What ships

- New tooling: `sdk/client/codama.config.mjs` + `npm run codegen` script
  consuming `idl/agent_vault.json`, `idl/agent_registry.json`,
  `idl/settlement.json` and emitting typed clients to
  `sdk/client/src/generated/{registry,vault,settlement}/`. Output is
  **committed**, not produced at install time, so consumers do not
  pull Codama as a peer dep.
- `@agenomics/client@0.2.0` re-exports the generated namespace plus
  the existing ergonomic helpers (`clampReputationScore`,
  `vaultIdentityBindMessage`, `AgentRegistryClient` thin façade).
- New entry points (per program): `accounts/`, `instructions/`,
  `pdas/`, `types/`, `errors/`. Tree-shakable; consumers pay only for
  the surface they import.
- CI gate (`.github/workflows/ci.yml`): `npm run codegen && git diff
  --exit-code sdk/client/src/generated/` so a stale generated tree
  fails the build. Mirrors the spirit of the ADR-082 IDL parity hook.
- `examples/register-agent.ts` extended to a real `registerAgent`
  transaction using the generated builder — the file becomes
  write-side as promised.

### Generation target

- **v1 (`@solana/web3.js`) target first**, matching `@coral-xyz/anchor
  ^0.31`'s peer (per ADR-133's "Anchor v2 not shipped" finding). The
  v2 (`@solana/kit`) target is opt-in via a second Codama renderer
  config (`codama.config.kit.mjs`) and emitted to
  `sdk/client/src/generated-kit/`. We do not flip the default until
  ADR-133's re-evaluation triggers fire.
- The v2 generated tree is published as a sibling export
  (`@agenomics/client/kit`) so the dual-stack policy from ADR-087 is
  preserved without forcing it on consumers.

### Backward compatibility

- The `AgentRegistryClient` / `AgentVaultClient` / `SettlementClient`
  classes from ADR-098 remain exported, internally backed by Codama
  generated PDA helpers + account decoders. Their public method
  signatures (`profilePda`, `fetchProfile`, etc.) are preserved
  byte-for-byte.
- Consumers of `0.1.0` upgrade with no source changes; the new
  surfaces (`getRegisterAgentInstruction`, etc.) are additive.

### What this supersedes

- **ADR-098 §"Out of scope" (instruction builders)**: closed by codegen.
- **ADR-088 SDK drift** (the `(program.account as any)` casts at
  vault:83, registry:108,124, settlement:118,135 cited in
  ADR-INVENTORY): Codama emits properly typed account fetchers, so
  the residual `as any` casts are deleted, not preserved. ADR-088
  remains the canonical typing decision; this ADR closes its SDK-side
  drift verdict.

## Consequences

### Positive

- **Idempotent IDL → SDK sync.** Field renames, account additions,
  and seed reorders propagate with `npm run codegen` + commit. The
  ADR-082 IDL parity hook plus the new codegen-diff CI gate catch
  drift on the same commit that introduces it.
- **Instruction builders ship for free.** `registerAgent`,
  `initializeVault`, `createEscrow`, `acceptTask`, `submitMilestone`,
  `approveMilestone`, `rejectMilestone`, `raiseDispute`,
  `resolveDispute`, `cancelEscrow`, all 25-ish IXs across the three
  programs — no hand-written builders to maintain.
- **Type-safe end-to-end.** Generated types pin field encodings,
  PDA seeds, instruction discriminators. The ADR-088 drift class
  stops being possible.
- **Aligns with ecosystem.** Onboarding a Solana-native dev becomes a
  zero-surprise experience because the SDK shape matches Helius,
  Metaplex, Squads.

### Negative

- **Larger generated surface.** `sdk/client/src/generated/` adds
  ~3–6 KLOC of committed code. We mitigate by (a) gitignoring the
  intermediate Codama IR, (b) committing only the rendered output,
  (c) keeping a separate `tsconfig.generated.json` so the linter
  does not police vendor code.
- **One more build step.** `npm run codegen` becomes a pre-build
  step in `sdk/client/`. The CI diff-gate makes it self-enforcing,
  but local dev needs to know about it; the README and
  `CONTRIBUTING.md` document the loop.
- **Codama version churn.** Codama is at `1.x` and still evolving;
  pinning the major in `package.json` and recording any rendering
  surprises in this ADR's References section is how we manage
  spillover.
- **Two render targets to keep in sync** during the dual-stack window
  (v1 default, v2 opt-in). Mitigated by single Codama IR feeding
  both renderers; no hand-divergence point.

### Follow-ups

- ADR-135 (Zod ↔ MCP tool mirroring) lands the same source-of-truth
  discipline on the off-chain side. Together they close the "input
  contract" of the protocol.
- ADR-138 (`@agenomics/react`) consumes the generated builders —
  `useRegisterAgent`, `useCreateEscrow` are thin React hooks over
  Codama output.
- ADR-139 (`create-agenomics-app`) ships a template that imports the
  generated builders directly; it is the smoke test that the
  builder-experience claim holds.
- ADR-098 status transitions to `Superseded by ADR-141` when this
  ADR is Accepted. The hand-written-wrapper rationale stays in the
  ADR-098 file as history; consumers follow the link.

## Alternatives Considered

**Keep hand-written wrappers + add instruction builders by hand.**
Rejected. Equivalent to taking on the maintenance load Codama exists
to eliminate, with the IDL-drift class still wide open. The ADR-088
SDK drift is a live demonstration of how this pattern fails.

**Anchor's `target/types` only (no Codama).** Anchor's emitted types
give us account decoders and IDL TypeScript shapes, but not typed
instruction builders or PDA helpers. The `Program<X>.methods.foo({...})`
DSL is not a generated typed builder — it's a Proxy at runtime — and
the ADR-088 drift comments confirm consumers reach for `as any` to
satisfy it. Codama is strictly broader; we do not lose the Anchor
shape (Codama renders `Program<IDL>`-compatible decoders too).

**Generate at install time, not at commit time.** Rejected. Forces
Codama into the consumer dependency graph, balloons install time,
and breaks tree-shaking for downstream tooling. The ecosystem norm
is committed generated trees with a CI diff-gate.

**Solita / `@metaplex-foundation/solita`.** The previous Metaplex
codegen, now superseded by Codama upstream. Picking the abandoned
fork would create a divergence we'd have to undo within a year.

## Implementation (2026-05-18)

Shipped on `feat/adr-141-codama`. What was actually built, including two
deviations from the Decision text that were design calls, not bulldozes:

### What shipped

- `sdk/client/codama.config.mjs` — programmatic codegen: `rootNodeFromAnchor`
  (`@codama/nodes-from-anchor`) → `createFromRoot` (`codama`) →
  `getRenderMapVisitor` (`@codama/renderers-js`) → `writeRenderMap`
  (`@codama/renderers-core`), one deterministic pass over the three
  committed IDLs in `sdk/idl/src/idl/{agent_registry,agent_vault,
  settlement}.json`, emitting to `sdk/client/src/generated/{registry,
  vault,settlement}/`. 100 generated `.ts` files, committed.
- `npm run codegen` + `npm run codegen:check` (regenerate then
  `git diff --exit-code -- src/generated`). The CI job
  `typescript-check-sdk-client` runs `codegen:check` before tsc — the
  ADR-082-style drift gate.
- Codama pinned in `sdk/client/package.json` devDependencies
  (`codama@^1.6.0`, `@codama/nodes-from-anchor@^1.4.1`,
  `@codama/renderers-js@^2.2.0`, `@codama/renderers-core@^1.0.34`);
  `@solana/program-client-core@^6.9.0` added as the one new runtime dep
  the generated instruction builders need.
- The `AgentRegistryClient` / `AgentVaultClient` / `SettlementClient`
  façades keep byte-identical public signatures; PDA derivation now
  delegates to generated `findOwnerNoncePda` / `findVaultPda` /
  `findEscrowPda` / `findProtocolConfigPda`. The hand-written seed
  *string literals* (the SDK-F2 trust-root weakness) are deleted.
- Generated trees re-exported additively under per-program namespaces
  (`export * as registry|vault|settlement`) — the instruction builders
  ADR-098 deferred now ship; `0.1.0` consumers upgrade with no source
  changes (the index/pda-equivalence/seed-parity suites — 69 tests —
  all pass unchanged in public behaviour).
- `seed-parity.test.ts` extended with an ADR-141 block asserting the
  generated `find*Pda` helpers agree byte-for-byte with both the façade
  and an independent on-chain-Rust-sourced derivation.

### Deviation 1 — kit (v2) renderer, not web3.js (v1)

The Decision's "Generation target" says "v1 (`@solana/web3.js`) target
first". **Codama publishes no web3.js-v1 JS renderer** (verified
2026-05-18: there is no `@codama/renderers-js-legacy`;
`@codama/renderers-js@2` is `@solana/kit`-only; the only other renderer
is the Umi one). The SDK's public PDA/encoding surface has been
kit-native since ADR-087, so the kit renderer is the *faithful,
non-regressing* target and the v1-first text is moot. The `generated-kit`
sibling tree and `codama.config.kit.mjs` in the Decision are therefore
unnecessary — there is one tree, kit-native. No v1↔v2 sync burden.

### Deviation 2 — two PDAs have no static codegen (by IDL design)

`agent-profile` (registry) and `delegation` (vault) have a seed that is
a *runtime/cross-account* value: `agent_profile`'s third seed is
`{ kind: "account", path: "owner_nonce.nonce" }` and `delegation`'s
fourth seed is a runtime u8 `nonce` instruction arg. Codama correctly
emits **no** `findAgentProfilePda` / `findDelegationGrantPda` for a seed
it cannot resolve statically (ADR-097 deliberately exposes `nonce` as an
explicit caller arg). This is a real IDL-shape boundary, not a codama
gap to bulldoze. Resolution: `profilePda(authority, nonce)` and
`delegationGrantPda(vault, grantee, nonce)` remain thin hand-derivations
**composed from the identical `@solana/kit` seed encoders the generated
code uses** (`getAddressEncoder`, `getBytesEncoder`, `getU64Encoder`);
their trust root stays `seed-parity.test.ts`, which reads the on-chain
Rust source and fails on a rename. The other four PDAs are fully
codegen-sourced. SDK-F2 is closed for the four generated PDAs by the
codegen-diff gate, and for all six by the (kept + extended) seed-parity
test. This boundary is acceptable and needs no human escalation.

### Rendering surprise managed in-repo

`@codama/renderers-js@2` emits extensionless relative imports (bundler
resolution); `@agenomics/client` compiles `NodeNext`. The codegen script
runs a pure-syntactic, idempotent post-pass adding `.js` /
`/index.js` so the committed tree is NodeNext-correct and the
diff-gate is stable. No upstream patch, no separate
`tsconfig.generated.json` (generated code passes the package's existing
strict `tsc` clean — the ADR's "linter does not police vendor code"
mitigation proved unnecessary).

### ADR-098 transition

ADR-098 should now transition to `Superseded by ADR-141` per its
Follow-ups; tracked, not done in this PR (separate ADR edit, keeps this
PR scoped to the SDK + gate).

## References

- ADR-082 — IDL parity CI gate (the precedent for "generated
  artifact under CI diff-gate").
- ADR-087 — Solana Kit dual-stack adapter; defines how v1 + v2
  coexist in the SDK.
- ADR-088 — typed Anchor program clients; Codama is the strict
  superset.
- ADR-098 — hand-written `@agenomics/client`; this ADR closes its
  deferred-instruction-builder gap.
- ADR-099 — `@agenomics/idl` package; the input to Codama.
- ADR-103 — standardized Result shape; Codama-generated builders
  return raw Anchor types, ergonomic façade returns the action-runtime
  Result. No conflict.
- ADR-133 — handlers-v2 wave deferral; explains why v1 is the
  default codegen target today.
- Codama upstream: https://github.com/codama-idl/codama (consumed
  via `@codama/cli`, `@codama/renderers-js`, `@codama/renderers-js-umi`
  — pinned at `^1` for first integration).
- Ecosystem precedents: `@solana-program/token`, `@metaplex-foundation/mpl-*`,
  `@drift-labs/sdk`, `@helius-labs/helius-sdk` — all Codama-generated
  as of Q1 2026.

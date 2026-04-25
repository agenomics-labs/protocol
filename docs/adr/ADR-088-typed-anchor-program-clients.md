# ADR-088: Typed Anchor program clients in `mcp-server`

## Status

Accepted

## Date

2026-04-23

**Audit-item:** ARCHITECTURE-AUDIT-2026-04-23 → 🟠 High → item 12
**Source-finding:** Code-quality audit §3.1

## Context

`mcp-server` is the off-chain Anchor client that constructs and dispatches every
on-chain transaction the protocol exposes via MCP. It loads three Anchor IDL
JSON files at runtime (`target/idl/{agent_registry,agent_vault,settlement}.json`)
and constructs `@coral-xyz/anchor` `Program` instances against each.

Until this ADR, the constructed instances were typed as the unparameterised
`Program` (i.e. `Program<Idl>`). Because Anchor's typed surface
(`AccountNamespace<IDL>`, `MethodsBuilder<IDL>`, …) is keyed on the IDL type
parameter, an unparameterised `Program` reduces every account fetch and every
methods-builder call to the bare `Idl` shape — which means:

1. `program.account.agentProfile` is **not a known property** on `Program<Idl>`
   (the namespace key set is empty by default). Every call site had to widen
   it back: `(program.account as any).agentProfile.fetch(...)`.
2. Numeric account fields typed as `u64` / `i64` come out as `BN` at runtime,
   but the static type was `unknown`. Every read turned into
   `(field as any).toNumber()`.
3. `handlers/reputation.ts` defined three duck-typed coercers — `numLike`,
   `stringLike`, `byteArrayLike` — to recover the shape that the Anchor type
   would have given for free, because the optional ADR-060 manifest fields
   on `AgentProfile` were typed as `unknown`.

The end state was 44 `as any` casts in `mcp-server/src/`, of which 37 were
in v1 handler files (`registry.ts`, `vault.ts`, `settlement.ts`,
`reputation.ts`) and existed solely because the IDL type parameter wasn't
threaded through.

The cost is **silent IDL drift**:

- Adding a field to an on-chain account in the Rust program updates the IDL,
  which updates `target/types/*.ts` — but a handler reading that field as
  `(profile.newField as any).toNumber()` continues to compile. Misnamed reads
  (`profile.reputaionScore` — note the typo) compile fine because the type
  is `any`.
- Renaming an instruction parameter, removing an account from a Context, or
  changing an enum variant ripples through `target/types/*.ts` immediately,
  but the handlers don't see it until the on-chain RPC call fails at runtime
  (often only on devnet during integration tests, weeks after the on-chain
  change merged).

`tsconfig.json` was carrying `"noImplicitAny": false` to permit the resulting
shape, which dragged the same exception across every other file in the
package — including the action runtime (`src/types/action.ts`) and the MCP
adapter — making it impossible to gate "no new untyped surface" via the
compiler.

Anchor 0.31's tooling already generates the camelCase `.ts` type files
(`target/types/*.ts`) in lockstep with the IDL JSON. They've existed
unconsumed since `anchor build` first ran. Wiring them in is a near-zero-cost
typing improvement that converts every IDL drift from a runtime failure into
a build-time error.

## Decision

1. **Consume the Anchor-generated type files** (`target/types/*.ts`) as the
   canonical typing surface for `Program` in `mcp-server`:
   - `import type { AgentRegistry } from "../../target/types/agent_registry"`
   - `import type { AgentVault } from "../../target/types/agent_vault"`
   - `import type { Settlement } from "../../target/types/settlement"`

2. **Parameterise the cached `Program` singletons** in
   `mcp-server/src/solana.ts`:
   ```ts
   let _vaultProgram: Program<AgentVault> | null = null;
   let _registryProgram: Program<AgentRegistry> | null = null;
   let _settlementProgram: Program<Settlement> | null = null;
   ```
   Each accessor returns the parameterised type
   (`getRegistryProgram(): Program<AgentRegistry>`, etc.). Construction at
   runtime is unchanged — `new Program<IDL>(idlJson, provider)` accepts the
   IDL JSON as `any` per Anchor's constructor signature; only the static
   type changes.

3. **Cascade through the handler files** — every handler that calls
   `program.account.X.fetch(...)` or reads a typed account field now uses
   the typed surface directly, with no `as any` widening. The
   duck-typed coercers (`numLike`, `stringLike`, `byteArrayLike`) in
   `handlers/reputation.ts` are deleted: the type tells us
   `manifestCid` is `number[]` (length 64) and `reputationScore` is `BN`,
   so the decoders become straight conditionals.

4. **`tsconfig.json` flips `"noImplicitAny": true`.** This restores the
   default TypeScript safety net for every file in `mcp-server/src/`, not
   just the handlers. New code cannot reintroduce an implicit `any` without
   the compiler rejecting it.

5. **Surviving `as any` casts must carry a `// TODO(typed):` comment**
   explaining why — typically Kit message-builder generics in
   `handlers-v2/vault.ts`, the `wallet as any` cast for the v2-shaped
   `AnchorProvider` constructor in `solana.ts`, and the
   `zodToJsonSchema(... as any)` widening in `adapters/mcp.ts` (a library
   compatibility issue tracked separately). These are the legitimate
   exceptions and must not grow.

6. **Build-time dependency on `target/types/*.ts`.** Because `mcp-server`'s
   `tsc` invocation now imports type files from outside its `rootDir`, two
   things follow:
   - `tsconfig.json` widens `include` to cover `../target/types/*.ts` (and
     drops `rootDir` so cross-directory imports resolve cleanly).
   - **CI must run `anchor build` before `npm --prefix mcp-server run build`.**
     The existing CI Anchor Build job already produces `target/types/*.ts`;
     downstream TypeScript jobs depend on the produced artifact (or rerun
     `anchor build` themselves).

## Alternatives

- **Keep `noImplicitAny: false`, suppress the casts with eslint disables.**
  Same drift exposure, slightly cleaner at the call sites. Rejected: the
  underlying problem is the missing type parameter, not the cast syntax.
- **Generate a hand-written interface mirror of each account in
  `mcp-server/src/types/`.** Pure duplication; drifts the moment the IDL
  changes. Anchor already generates the canonical version.
- **Use `Program.at<IDL>(programId, provider)` (the static fetch-from-chain
  helper).** Adds an RPC round-trip on every cold start of the MCP server
  and makes startup depend on devnet/mainnet reachability. Rejected.
- **Move the IDL types into `@agenomics/idl` (the planned SDK package, ADR-099).**
  Correct long-term; out of scope for this refactor. ADR-099 is the
  follow-up. Until then, `target/types/*` is the in-monorepo source.

## Consequences

### Positive

- **44 `as any` casts removed from v1 handlers.** Concretely:
  registry handler 12 → 0, vault handler 10 → 0, settlement handler 12 → 0,
  reputation handler 3 → 0, plus the `(program.account as any)` cast in
  `solana.ts`. The 6 surviving casts (5 in `handlers-v2/vault.ts` for Kit's
  message-builder generics, 1 in `adapters/mcp.ts` for `zodToJsonSchema`)
  are tagged with `// TODO(typed):` and tracked.
- **`noImplicitAny: true` is on package-wide.** Any new untyped surface
  fails the build.
- **Adding/renaming an on-chain account field is a build-time error in
  `mcp-server`.** Drift is no longer silent.
- **The duck-typed adapters in `handlers/reputation.ts` are gone.** The 50
  lines of `numLike` / `stringLike` / `byteArrayLike` collapse to direct
  field reads against the Anchor type. The Anchor type for `manifest_cid`
  (declared `[u8; 64]`) lands as `number[]` of length 64 — exactly what the
  decoder needs.

### Negative / cost

- **`mcp-server` build requires `target/types/*.ts` to exist.** Fresh
  checkouts must run `anchor build` once before `npm --prefix mcp-server
  run build`. CI is already structured this way; the local-developer
  bootstrap docs (`README.md` in mcp-server) note the dependency.
- **Importing across `rootDir` requires `tsconfig` adjustment.** The chosen
  approach is to drop `rootDir` and widen `include` to list the three IDL
  type files alongside `src/**/*`. The Anchor tooling owns that directory's
  lifecycle, so `tsc` should not assume sole ownership of the source tree
  anyway. Type-only imports emit no JS, so the dist layout is unchanged.
- **The on-chain Rust program's IDL is now part of the off-chain TS API
  contract.** This is the point — it converts an implicit dependency into
  an explicit one. The flip side: trivial Rust refactors that produce
  semantically-identical IDLs (renaming a private struct field, reordering
  an enum) become breaking changes in `mcp-server`. Reviewers must check
  the `target/types/*.ts` diff in any program PR.

### Out of scope (for follow-up)

- **`mcp-handlers.test.ts` is not in the test runner** (audit item L3).
  This refactor does not bring it under CI; that is a separate decision.
  The file's own `(vaultProgram.account as any).vault.fetch(...)` casts
  remain because the file is not exercised by `npm test` and its
  imports/setup mirror the live-validator pattern. ADR follow-up: bring
  it under CI or delete it.
- **`@agenomics/idl` SDK package** (ADR-099): factor `target/types/*.ts`
  into a publishable package so external consumers (action runtime, third-
  party SDKs) get the same typed surface without copying file paths.
- **The 5 Kit-message-builder casts in `handlers-v2/vault.ts`** persist
  because Kit's `appendTransactionMessageInstruction` etc. are typed
  pipe-style and TypeScript can't track the message generic across the
  reassignment. The TODO points at upstream Kit's open issue.

## References

- `ARCHITECTURE-AUDIT-2026-04-23.md` — punch-list item 12.
- Code-quality audit (in conversation history) §3.1 — the original 44-cast
  finding.
- `mcp-server/src/solana.ts:71-73, 187-215` — the unparameterised `Program`
  declarations replaced by this ADR.
- `mcp-server/src/handlers/reputation.ts:276-328` — the `numLike` /
  `stringLike` / `byteArrayLike` adapters deleted by this ADR.
- ADR-013 — Anchor 0.31 upgrade (the version this ADR depends on for
  `target/types/*.ts` to be generated).
- ADR-099 (planned) — `@agenomics/idl` SDK package extraction.
- Anchor `Program<IDL>` source:
  `node_modules/@coral-xyz/anchor/dist/cjs/program/index.d.ts:38`,
  `…/program/namespace/account.d.ts:32-35`.

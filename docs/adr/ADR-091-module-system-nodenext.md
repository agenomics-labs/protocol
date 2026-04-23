# ADR-091: Module system — mcp-server moves to ESM via NodeNext; workspace policy formalized

## Status
Accepted

## Date
2026-04-23

## Context

The TypeScript surface of the protocol consists of three module-system camps as of 2026-04-22:

| Workspace | `package.json#type` | `tsconfig#module` | `tsconfig#moduleResolution` |
|-----------|---------------------|-------------------|-----------------------------|
| `packages/capability-manifest-validator` | `"module"` | `NodeNext` | `NodeNext` |
| `packages/sas-resolver` | `"module"` | `NodeNext` | `NodeNext` |
| `mcp-server` | (default = "commonjs") | `commonjs` | `node` |
| `src/indexer` | (default) | `commonjs` | `node` |
| `src/x402-relay` | (default) | `commonjs` | `node` |
| `dashboard` | `"module"` | (Vite-managed; ESM) | (Vite-managed) |

mcp-server consumes the two `@agenomics/*` packages via `file:` deps. Both are ESM-only (`"type": "module"`), but mcp-server transpiles to CommonJS. A static `import` of an ESM-only package from a CJS file would, at build time, be re-emitted as `require()` — which fails at runtime because Node 16+ refuses to `require()` an ESM module.

The pre-existing workaround in `mcp-server/src/handlers/reputation.ts:44-50` and `mcp-server/test/smoke-integration.test.ts:34-35`:

```typescript
type DynImport = <T = unknown>(specifier: string) => Promise<T>;
const dynImport = new Function(
  "s",
  "return import(s);",
) as unknown as DynImport;
```

`new Function(...)` builds a function whose body is `return import(s);`. Because TypeScript never sees the `import()` syntax (it's a string literal), it is not down-compiled to `require()` at build time — so the ESM dynamic-import semantics survive. The shim works, but it is a brittle, hand-rolled escape hatch with three operational costs:

1. **Loses static analysis.** TypeScript can't follow the call into the imported module; the type assertion `as unknown as DynImport<T>` re-enters the type system blind.
2. **Confuses tooling.** Bundlers, ESLint custom rules, dependency analyzers, and source-map generators all see a string-literal `Function` constructor and skip it. The shim is invisible to "find all imports of `@agenomics/sas-resolver`" tools.
3. **Forces every ESM-only consumer through the same ritual.** Every new ESM dep added to mcp-server needs the shim; the Test suite duplicates it because the same constraint applies in tests.

The Architecture-Audit-2026-04-23 §6 surfacing: *"the dynImport shim is a load-bearing workaround for a single broken setting. Flip the setting; delete the shim."*

## Decision

### 1. mcp-server moves to NodeNext

`mcp-server/tsconfig.json` switches:

```diff
- "target": "ES2020",
- "module": "commonjs",
- "lib": ["ES2020"],
- "moduleResolution": "node",
+ "target": "ES2022",
+ "module": "NodeNext",
+ "moduleResolution": "NodeNext",
+ "lib": ["ES2022"],
```

`mcp-server/package.json` adds:

```json
"type": "module"
```

Effect:
- TypeScript emits ESM-shaped JavaScript (`import` / `export` survive into `dist/*.js`).
- `await import("@agenomics/sas-resolver")` is a real native dynamic import; the shim is no longer required.
- Static `import { foo } from "@agenomics/sas-resolver"` would also work (we keep the dynamic form for lazy-load semantics — see §4).
- `target: ES2022` + `lib: ES2022` give us native top-level `await`, optional chaining shorthand, and Error.cause without polyfills.

### 2. Delete the dynImport shim

Two call sites:

- `mcp-server/src/handlers/reputation.ts` — both `dynImport<typeof ...>(...)` calls become plain `await import("...")`. The type-only `import type` statements at the top remain (they emit no JS and are the source of `SasResolverClass`, `ResolvedReputation`, `CapabilityManifest`, `ValidationResult`).
- `mcp-server/test/smoke-integration.test.ts` — the `before()` block's `dynImport(...)` calls become `await import(...)`. The `Dyn` alias stays (the resolver's type surface is internal and not re-exported in a clean shape).

The accompanying jsdoc paragraphs in both files are rewritten — they used to explain why the shim existed; now they explain that ADR-091 made it unnecessary.

### 3. Sweep CJS-isms exposed by the migration

The flip surfaced four other CJS-only patterns in mcp-server source. Each is fixed once and documented:

- `mcp-server/src/index.ts:152` — `if (require.main === module)`. ESM has no `require`. Replaced with the standard ESM idiom:
  ```typescript
  import { pathToFileURL } from "node:url";
  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(...);
  }
  ```

- `mcp-server/src/pipeline/idempotency.ts:179` — `require("./idempotency-redis.js")` lazily. The synchronous `createIdempotencyStore()` factory must stay synchronous (its caller is a module-singleton accessor). Replaced with `createRequire(import.meta.url)` — the standard Node bridge for sync CJS-loading from ESM:
  ```typescript
  import { createRequire } from "node:module";
  const requireCJS = createRequire(import.meta.url);
  const mod = requireCJS("./idempotency-redis.js") as { ... };
  ```

- `mcp-server/src/pipeline/idempotency-redis.ts:159` — `require("ioredis")` lazily. Same `createRequire` treatment, same reason (sync constructor preserves call-site shape).

- `mcp-server/src/pipeline/idempotency-redis.ts:361` — `require("crypto")` for `randomUUID`. Replaced with a top-level `import { randomUUID } from "node:crypto"`. The try/catch fallback is now dead — `randomUUID` is in every supported Node (>=14.17).

- `mcp-server/test/pipeline.test.ts:29` — `require("ioredis-mock")`. Replaced with `import IoRedisMock from "ioredis-mock"`. Node's CJS-default-export interop resolves the constructor from the namespace correctly.

### 4. Workspace-wide module-system policy (formalized)

The architecture allows mixed module systems within the workspace. The decision matrix going forward:

| Workspace category | `package.json#type` | `tsconfig#module` | Notes |
|--------------------|---------------------|-------------------|-------|
| Published `@agenomics/*` packages (`packages/*`) | `"module"` | `NodeNext` | ESM-only — public API is forward-looking |
| Servers (`mcp-server`, `src/indexer`, `src/x402-relay`) | `"module"` | `NodeNext` | Internal services; freedom to consume ESM deps |
| `dashboard` | `"module"` | (Vite-managed) | Frontend; Vite owns the build |
| `scripts/*` (one-off ops scripts, e.g. `mainnet-deploy.ts`) | (any) | `commonjs` OR ESM | Per-script choice; `tsx` runs both |
| Test files | matches their package | matches their package | Tests inherit |

This ADR moves **mcp-server** from CommonJS to NodeNext immediately. **`src/indexer` and `src/x402-relay`** stay on CommonJS for now — they don't consume any ESM-only packages today, so the shim problem doesn't apply, and a separate ADR can migrate them if needed. The matrix above documents that they're allowed to migrate at any time without an additional architectural decision.

### 5. Tests prove the migration

Pre-migration: 96 tests pass (mcp-server `npm test`).
Post-migration: **112 tests pass** (96 baseline + 16 new ADR-090 logger tests). Same test runner (`node --import tsx --test`), same harness, same assertions — the module system flip is invisible to test code.

The dynImport shim's removal is verified by `grep -r 'new Function.*"return import' src test`:

```
mcp-server/src/handlers/reputation.ts: * end-to-end — the prior `new Function("s", "return import(s);")` shim
mcp-server/test/smoke-integration.test.ts: * `new Function("s", "return import(s);")` shim has been removed.
```

Only documentation references remain — both are jsdoc paragraphs explaining the migration.

## Alternatives Considered

### Alternative A: Move `@agenomics/*` packages from ESM to CJS

The other end of the mismatch. Rejected: the two packages are designed to be public-facing (npm-published — see ADR-088 / sas-resolver pre-publish work). ESM is the forward-looking choice for new TypeScript packages; downgrading to CJS to make mcp-server happy is the wrong direction.

### Alternative B: Keep CJS in mcp-server; expand the dynImport shim into a util module

Make the shim less ugly by hiding it behind `import { dyn } from "./util/dyn"`. Rejected: it's still the same workaround, just less visible. The audit's "load-bearing workaround for a single broken setting" critique applies regardless of where the shim lives.

### Alternative C: ESM everywhere immediately (indexer + x402-relay too)

Tempting for consistency. Rejected: out of scope for this ADR. Indexer and x402-relay don't have the dynImport problem because they don't consume the ESM-only `@agenomics/*` packages. Migrating them now would add risk (testing surface, ts-node-dev compatibility, the `if (require.main === module)` patterns at their entrypoints) without addressing the actual finding. Documented in §4 as a future ADR if needed.

### Alternative D: Use a bundler (esbuild / tsup) to flatten everything to one CJS file

Bundlers can paper over the ESM/CJS split. Rejected: introduces a build dep with its own quirks (esm interop bugs, stack-trace mapping issues, side-effects-from-imports differences between `tsc` and `esbuild`). The native Node module resolver is the source of truth; aligning with it is structurally simpler than building around it.

### Alternative E: Static `import` (not dynamic) for the @agenomics/* packages

After the NodeNext flip, `import { SasResolver } from "@agenomics/sas-resolver"` works. Rejected for `reputation.ts`: the lazy-load pattern was deliberate (see the original module header — "construction is deferred until the first call so the module loads cleanly in environments without SAS configured"). Switching to static import would pay the package-load cost even in dev shells without SAS, potentially throwing at module-load time on missing `@agenomics/sas-resolver` peer deps. Lazy `await import(...)` keeps the existing semantic. The smoke test in `before()` is fine either way; we kept dynamic for symmetry with the handler.

## Consequences

### Positive

- **dynImport shim deleted.** TypeScript sees the dynamic imports; tooling sees them; humans see them. The "what does this code actually load?" question gets a real answer.
- **Native `import.meta.url`** lands as a side benefit — `mcp-server/src/index.ts`'s entrypoint guard is now standard ESM, not a CJS-ism.
- **Aligned with @agenomics/* publish targets.** When the day comes to publish `@agenomics/mcp-server` to npm (out of v0.1.0 scope), the package shape already matches the modern Node package convention.
- **`target: ES2022`** unlocks top-level `await` (we don't use it yet, but it's available without a tsconfig revisit).
- **Workspace policy is documented.** Future contributors don't have to guess which workspace member is which module system; the matrix in §4 is the answer.

### Negative

- **createRequire is not pretty.** Three call sites in `idempotency.ts` / `idempotency-redis.ts` use `createRequire(import.meta.url)` to keep their constructors synchronous. This is intentional (the alternative is a sync→async refactor that ripples through callers), but it leaves three small CJS bridges. Documented in source.
- **Node version requirement firms up.** `import.meta.url`, `pathToFileURL`, `createRequire` all require Node 14+; we already require Node >=20 (per `tsconfig.lib`). No real regression, but worth noting.
- **CI cache keys may need invalidation.** A switch from CJS to ESM changes hashed `dist/*` outputs. The first PR run on this branch will repopulate caches; nothing breaks but nothing is reused either.
- **`ts-node` and similar loaders need `--esm` flag** if anyone runs mcp-server via ts-node. We use `tsx` which handles ESM transparently, so the `npm test` script is unchanged. A contributor using ts-node directly would hit a flag mismatch — documented in the new module-system policy.

### Neutral

- **No protocol behaviour change.** Module system is a build/runtime concern; nothing changes on chain.
- **No bundler introduced.** `tsc` still emits the dist; the resulting JS is just ESM-shaped.
- **`dashboard` is unaffected.** Already ESM under Vite.
- **Indexer + x402-relay are unaffected.** They stay on CommonJS until a separate decision moves them; the policy in §4 explicitly allows this.

## References

- `mcp-server/tsconfig.json` — module/moduleResolution flipped to NodeNext
- `mcp-server/package.json` — `"type": "module"` added
- `mcp-server/src/handlers/reputation.ts` — dynImport shim deleted, plain `await import(...)` in its place
- `mcp-server/test/smoke-integration.test.ts` — same
- `mcp-server/src/index.ts` — `require.main === module` → `import.meta.url === pathToFileURL(argv[1]).href`
- `mcp-server/src/pipeline/idempotency.ts` — `require()` → `createRequire(import.meta.url)`
- `mcp-server/src/pipeline/idempotency-redis.ts` — same; `randomUUID` lifted to top-level import
- `mcp-server/test/pipeline.test.ts` — `require("ioredis-mock")` → `import IoRedisMock from "ioredis-mock"`
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` items 15 / Code §6 — the audit findings this ADR closes
- `docs/adr/ADR-089-reproducible-installs.md` — the install surface shipped alongside
- `docs/adr/ADR-090-structured-logging.md` — orthogonal but shipped together
- ADR-091 supersedes the comment paragraphs in `reputation.ts` and `smoke-integration.test.ts` that documented the dynImport workaround

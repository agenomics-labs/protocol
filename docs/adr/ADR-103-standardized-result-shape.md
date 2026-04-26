# ADR-103 — Standardized TypeScript Result Shape

## Status

Accepted

## Date

2026-04-23

## Context
mcp-server and sas-resolver each define near-identical Result types and wrap()
helpers. Drift between these duplicates causes subtle inconsistencies.

## Decision
The canonical Result type is defined in `@agenomics/action-runtime` (ADR-100):
  type Result<T, E = Error> = {ok: true; value: T} | {ok: false; error: E}
All off-chain services import from that package. The local wrap() helpers are
replaced by the canonical one. A defineAction() builder standardizes MCP
action definitions.

## Alternatives
- Keep per-package: simpler short-term, drift long-term.
- Use fp-ts/neverthrow: heavier dependency, different ergonomics.

## Consequences
- Uniform error handling across all TypeScript services.
- action-runtime becomes a required dev dependency for mcp-server and sas-resolver.

## References
- Architecture Audit 2026-04-23, Item 26, Code §1.3 / §3.3
- ADR-100 (@agenomics/action-runtime)

## Revisions

- 2026-04-25 — Migration completed. mcp-server's `{ ok, data }`/AepError
  shape and sas-resolver's local-declared `{ ok, value }` both now
  import directly from `@agenomics/action-runtime`. AUD-013 closed
  via PR-T.

  Specifics:
  - `mcp-server/src/types/action.ts` — replaced the local `Result` /
    `ok` / `err` declarations with re-exports from action-runtime; the
    field name is now `value` (was `data`). The `AepError` interface is
    preserved as a structural POJO type (`{ code: AepErrorCode;
    message: string; details? }`) so existing `error.code` /
    `error.message` consumers and the JSON wire format used by
    `pipeline/idempotency-redis.ts` continue to work unchanged. A thin
    `err()` wrapper bound to `AepError` keeps the 40+ literal callsites
    type-checking without modification. `Result<T>` defaults to
    `Result<T, AepError>` to match the package's historical convention.
  - `mcp-server/src/util/result.ts` — collapsed to a re-export of
    `ok` / `err` / `wrap` / `defineAction` from action-runtime.
  - `mcp-server/src/index.ts` — single `result.data` callsite migrated
    to `result.value`.
  - `mcp-server/src/handlers-v2/vault.ts` — single `confirmResult.data`
    callsite migrated to `confirmResult.value`.
  - `mcp-server/test/pipeline.test.ts` — 14 `{ ok: true, data: X }`
    deepEqual assertions and 2 `r.data` checks migrated to `value`.
  - `mcp-server/test/handlers-v2-vault.test.ts` — 10 `result.data.*`
    field accesses migrated to `result.value.*`.
  - `packages/sas-resolver/src/util/result.ts` — orphaned local
    declaration replaced by a re-export. The package's main public
    `Result<T>` (declared in `types.ts` with the structured
    `ResolverError`) is unchanged: it is part of the documented
    resolver contract and is structurally compatible with the canonical
    shape.
  - `packages/sas-resolver/package.json` and `mcp-server/package.json`
    — added `@agenomics/action-runtime` as a workspace dependency.

- 2026-04-26 — Cycle-2 audit (AUD-201) caught capability-manifest-validator
  was missed by PR-T. Migrated. Three Result shapes is now actually two
  (canonical + AepError-typed mcp-server alias). Tracked toward "single
  shape" by gradual mcp-server consumer migration.

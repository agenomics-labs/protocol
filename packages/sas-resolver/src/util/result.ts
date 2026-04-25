/**
 * ADR-103 (PR-T, AUD-013): canonical Result shape and helpers.
 *
 * This module previously declared its own `{ ok: true; value: T } | { ok:
 * false; error: E }` union plus `ok` / `err` / `wrap` helpers, mirroring
 * the shape that lives in `@agenomics/action-runtime`. ADR-103 made
 * `@agenomics/action-runtime` the single source of truth for the
 * Result type across off-chain TypeScript packages, so this module is
 * now a thin re-export — keeping the import path stable for any
 * downstream caller while the actual symbols are sourced from the
 * canonical package.
 *
 * NOTE: the public surface of this package (`@agenomics/sas-resolver`)
 * uses a separate, narrower `Result<T>` declared in `./types.ts` whose
 * error type is `ResolverError` (a structured `{ code, message,
 * details }` POJO). That alias is preserved because it is part of the
 * resolver's documented contract; it is structurally compatible with
 * the canonical `Result<T, E>` from action-runtime (same `{ ok, value }
 * | { ok, error }` shape). This file is here for any caller that wants
 * the plain canonical helpers.
 */

export { ok, err, wrap } from "@agenomics/action-runtime";
export type { Result } from "@agenomics/action-runtime";

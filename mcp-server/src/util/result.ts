/**
 * ADR-103 (PR-T, AUD-013): canonical Result shape and helpers.
 *
 * Originally a parallel copy of the canonical shape that lived in
 * `@agenomics/action-runtime`. Now a thin re-export so the import
 * path `../util/result.js` keeps working for any caller while the
 * implementation lives in exactly one place.
 *
 * The neighbouring `../types/action.js` re-exports the same
 * `Result`/`ok`/`err` from the same source, narrowed at the type
 * level so `Result<T>` defaults to `Result<T, AepError>`. Use this
 * module when you want the un-narrowed canonical shape (the default
 * `E = Error`); use `../types/action.js` when you want the
 * AEP-action-error binding.
 */

// AUD-211 (cycle-2): `wrap` intentionally NOT re-exported. The
// canonical action-runtime `wrap` returns `Result<T, Error>`, but
// every mcp-server action that needs a try/catch wrapper
// (`actions/{vault,reputation,settlement}.ts`) ships its OWN local
// `wrap` that returns `Result<T, AepError>` with
// `code: "PROGRAM_ERROR"` mapped from the thrown Error. The two
// shapes are structurally incompatible — a contributor reaching for
// the canonical `wrap` from this module would produce a
// `Result<T, Error>` that the AepError-shaped action handlers cannot
// consume. Removing the re-export prevents that drift. The DRY
// consolidation (single shared AepError-shaped wrap across all
// actions/*) is tracked as cycle-3 follow-up.
export { ok, err, defineAction } from "@agenomics/action-runtime";
export type { Result } from "@agenomics/action-runtime";

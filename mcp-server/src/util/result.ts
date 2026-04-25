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

export { ok, err, wrap, defineAction } from "@agenomics/action-runtime";
export type { Result } from "@agenomics/action-runtime";

/**
 * ADR-103: Canonical Result shape for sas-resolver.
 *
 * Kept in sync with mcp-server/src/util/result.ts. Both packages maintain
 * a local copy because they are independently published; the shape is
 * identical so cross-package usage remains compatible.
 *
 * TODO(ADR-103): migrate to @agenomics/action-runtime once package is available
 */

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Construct a successful Result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Construct a failed Result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * Wrap an async function call in a Result, capturing thrown errors.
 * Strings and non-Error throws are coerced to `Error` objects.
 */
export async function wrap<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

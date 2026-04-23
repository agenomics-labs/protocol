/**
 * ADR-103: Canonical Result shape and helpers for TypeScript services.
 *
 * All off-chain packages (mcp-server, sas-resolver) converge on this
 * shape. When @agenomics/action-runtime is published (ADR-100), these
 * helpers will be replaced by imports from that package.
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

/**
 * ADR-103: defineAction() builder for standardised MCP action definitions.
 *
 * Wraps the handler in `wrap()` so every run() call returns a typed
 * Result<TOutput, Error> — no unhandled rejections at the call site.
 *
 * @example
 * const myAction = defineAction({
 *   name: "my_action",
 *   description: "Does something useful",
 *   handler: async (input: MyInput): Promise<MyOutput> => { ... },
 * });
 * const result = await myAction.run(input); // Result<MyOutput, Error>
 */
export function defineAction<TInput, TOutput>(spec: {
  name: string;
  description: string;
  handler: (input: TInput) => Promise<TOutput>;
}): {
  name: string;
  description: string;
  run: (input: TInput) => Promise<Result<TOutput, Error>>;
} {
  return {
    name: spec.name,
    description: spec.description,
    run: (input: TInput) => wrap(() => spec.handler(input)),
  };
}

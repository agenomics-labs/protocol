export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export async function wrap<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

export interface ActionSpec<TInput, TOutput> {
  name: string;
  description: string;
  handler: (input: TInput) => Promise<TOutput>;
}

export interface Action<TInput, TOutput> {
  name: string;
  description: string;
  run: (input: TInput) => Promise<Result<TOutput, Error>>;
}

export function defineAction<TInput, TOutput>(
  spec: ActionSpec<TInput, TOutput>,
): Action<TInput, TOutput> {
  return {
    name: spec.name,
    description: spec.description,
    run: (input) => wrap(() => spec.handler(input)),
  };
}

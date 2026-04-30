# @agenomics/action-runtime

A tiny `Result` type and `defineAction` builder for AEP capability handlers.

The runtime contract for capabilities advertised in an AEP capability
manifest (ADR-060). Provides a typed `Result<T, E>` discriminated union
with `ok` / `err` constructors, a `wrap` helper that converts any
`Promise`-returning function into a `Result`-returning one (so
exceptions never escape the action boundary), and a `defineAction`
builder that takes a plain async handler and produces an `Action` with
a uniform `run(input)` shape. Zero runtime dependencies — drop it into
any AEP capability without pulling Solana code into the action surface.

## Install

```sh
npm install @agenomics/action-runtime
```

_Not yet on npm; pre-publish 0.1.0. See `docs/SDK_PUBLISH.md` for the publish path._

## Quick example

```ts
import { defineAction, ok, err } from "@agenomics/action-runtime";
import type { Result } from "@agenomics/action-runtime";

const addAction = defineAction({
  name: "add",
  description: "Adds two numbers",
  handler: async (input: { a: number; b: number }) => input.a + input.b,
});

const result: Result<number, Error> = await addAction.run({ a: 3, b: 4 });
if (result.ok) {
  console.log("sum:", result.value); // sum: 7
} else {
  console.error("failed:", result.error.message);
}

// Manual constructors when you don't need a wrapped handler:
const success: Result<string> = ok("done");
const failure: Result<never, Error> = err(new Error("nope"));
```

## Key exports

- `Result<T, E = Error>` — discriminated union: `{ ok: true; value: T } | { ok: false; error: E }`. Narrows cleanly via `result.ok`.
- `ok(value)` / `err(error)` — single-line constructors for the two variants.
- `wrap(fn)` — runs a `() => Promise<T>`, captures any throw, and returns `Promise<Result<T, Error>>`. Non-`Error` throws (strings, numbers, etc.) are coerced to `Error` so consumers always get a stable `error.message`.
- `ActionSpec<TInput, TOutput>` — the input shape: `{ name, description, handler: (input) => Promise<TOutput> }`.
- `Action<TInput, TOutput>` — the produced shape: `{ name, description, run: (input) => Promise<Result<TOutput, Error>> }`.
- `defineAction(spec)` — builds an `Action` from a spec. The handler is wrapped with `wrap`, so `run` never throws.

## Related packages

- `@agenomics/client` — call on-chain reads (e.g. `fetchProfile`, `fetchVault`) inside an action handler; throws inside the handler become typed `err` results.
- `@agenomics/idl` — pull cluster-keyed program IDs into the same handler when you need to dispatch by network.
- `@agenomics/capability-manifest-validator` — declare each `defineAction` you ship in your published manifest's `capabilities[]` array; the validator confirms the manifest matches the on-chain commitment.
- `@agenomics/sas-resolver` — fetch reputation context for the requesting agent before running the action handler.

## Status

0.1.0 — pre-publish; private until license + READMEs land per `docs/SDK_PUBLISH.md`.

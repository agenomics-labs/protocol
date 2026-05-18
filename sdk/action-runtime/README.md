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
- `wrap(fn)` — runs a `() => Promise<T>`, captures any throw, and returns `Promise<Result<T, ActionError>>`. The thrown value is **never** returned verbatim: it is converted to a redacted `ActionError` (see Security boundary).
- `ActionSpec<TInput, TOutput>` — `{ name, description, validate?, handler }`.
- `Action<TInput, TOutput>` — `{ name, description, run: (input: unknown) => Promise<Result<TOutput, Error>> }`.
- `defineAction(spec)` — builds an `Action` from a spec. The handler is wrapped with `wrap`, so `run` never throws.
- `ActionError` — `extends Error`, adds a stable machine `code`. The only error type that ever crosses the action boundary back to a caller.
- `ValidationError` — throw from `validate` for invalid input; surfaces as `ActionError` with `code: "VALIDATION_ERROR"`.
- `setInternalErrorSink(fn)` — register a trusted server-side logger that receives the **raw, unredacted** error. Never wire this anywhere reachable by an untrusted caller.

## Security boundary (SDK-F3 — cycle-4 audit)

`defineAction` is a capability runtime, not a validator. Two contracts are
now explicit:

1. **No implicit input validation.** Without a `validate` hook the handler
   receives whatever the (possibly untrusted) caller passed — `TInput` is
   erased at runtime. For any handler that moves funds or touches signing
   material, supply `validate`; it runs *before* `handler` and must `throw`
   (e.g. `ValidationError`) on bad input.

2. **Error redaction.** RPC URLs, filesystem (keypair) paths, and
   key/secret-shaped blobs are stripped from the `error.message` returned
   to callers; the message is length-bounded; the raw `Error`/`.stack` is
   never returned; non-`Error` throws are reduced to a type tag (no value
   leak). The unredacted error is delivered only to `setInternalErrorSink`
   if one is registered.

## Related packages

- `@agenomics/client` — call on-chain reads (e.g. `fetchProfile`, `fetchVault`) inside an action handler; throws inside the handler become typed `err` results.
- `@agenomics/idl` — pull cluster-keyed program IDs into the same handler when you need to dispatch by network.
- `@agenomics/capability-manifest-validator` — declare each `defineAction` you ship in your published manifest's `capabilities[]` array; the validator confirms the manifest matches the on-chain commitment.
- `@agenomics/sas-resolver` — fetch reputation context for the requesting agent before running the action handler.

## Status

0.1.0 — pre-publish; private until license + READMEs land per `docs/SDK_PUBLISH.md`.

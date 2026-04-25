# ADR-117: x402-relay error redaction policy

## Status
Proposed

## Date
2026-04-24

## Context

Re-audit finding **R-offchain-01** — `src/x402-relay/index.ts:144-145`:

```ts
} catch (err) {
  return { valid: false, ..., error: `Verification error: ${err}` };
}
```

The template literal coerces an unknown exception type into the
response body. `getTransaction()` in `@solana/web3.js` can throw
errors whose `toString()` / `inspect()` includes the RPC endpoint URL,
the transaction signature, HTTP status details, or a stack trace.
Every unprivileged caller of `/verify-payment` (and any other route
with the same pattern) receives whatever that exception stringifies
into.

Security impact: information leakage. An attacker can map RPC
provider, topology, and internal state by probing the endpoint with
malformed input. Not exploitable for on-chain funds but undermines the
deployment's operational opacity.

ADR-017 (x402-relay architectural design) does not specify an error
model. ADR-090 (structured logging) established pino with correlation
IDs server-side, which is the right destination for raw exceptions.

## Decision

Adopt a two-surface error model for x402-relay:

1. **Server-side (pino):** log the raw exception at `error` level
   with the correlation ID. Use pino's built-in redaction policy
   to strip known-secret keys; raw stack is fine in logs.
2. **Client-side (JSON response):** return a typed error envelope
   `{ code: string, message: string, correlationId: string }` where
   `message` is a generic human-readable string keyed off `code`.
   Client-side never sees the underlying exception text.

Define a small `errorCode` enum covering the observed failure modes:

- `PAYMENT_NOT_FOUND` — tx signature missing from RPC.
- `PAYMENT_UNVERIFIED` — tx found but does not satisfy the claim.
- `PAYMENT_REPLAYED` — already-seen signature.
- `RPC_UNAVAILABLE` — transport error reaching the RPC.
- `INTERNAL` — anything else (catch-all, must log raw).

Implementation constraints:
- The `catch` block classifies the exception into a code, never the
  raw `err`.
- `correlationId` is the pino correlation ID; the client can quote it
  back to ops for post-hoc debugging.
- Apply the same pattern to every other `catch` in `src/x402-relay/`
  that currently template-literals errors. Also sweep `mcp-server/`
  handlers for the same shape (several places use
  `error instanceof Error ? error.message : String(error)` which is
  also a leakage surface in non-`Error` throw cases).

## Consequences

- Clients lose verbose errors. They gain a stable `code` they can
  branch on, which is arguably more useful.
- Ops has to actually check pino logs to debug user-reported failures.
  This is the cost of shipping redaction.
- Tests need updating: any test asserting on a raw error substring
  must switch to asserting `code`.

## References

- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-offchain-01.
- `docs/adr/ADR-017-x402-http-payment-relay.md`.
- `docs/adr/ADR-090-structured-logging.md` — pino + correlation ID.
- `src/x402-relay/index.ts:144-145`, and every sibling `catch` block.

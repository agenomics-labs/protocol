# ADR-117: x402-relay error redaction policy

## Status
Accepted (2026-05-13) — typed error envelope shipped in this PR
(`feat(x402-relay): typed error envelope per ADR-117`); mcp-server sweep
tracked separately as ADR-117b.

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

## Amendment 2026-05-17 — HTTP status taxonomy (C4-X402-02 / C4-X402-05)

This ADR specified the envelope body but was **silent on HTTP status**.
The original implementation collapsed every verify failure — including
the transport/infra codes `RPC_UNAVAILABLE` and `INTERNAL` — onto HTTP
**402**, varying only the envelope `code`. Cycle-4 finding **C4-X402-02**
showed this inverts retry semantics: retry libraries, proxies, and dumb
intermediaries branch on the **status**, not the envelope `code`. A paid
client hitting the relay during an RPC brown-out received `402` ("payment
rejected — do not retry / re-pay"), inducing an honest double-spend (a
second on-chain payment for one intended access). The status was the
dimension clients branch on *first*, and it lied.

This amendment makes the **code → HTTP status** mapping a normative part
of the ADR-117 contract. The envelope body is unchanged
(`{ code, message, correlationId }`); only the status now reflects
retry-ability:

| `code` | Meaning | HTTP status | Client semantics |
|---|---|---|---|
| `PAYMENT_NOT_FOUND` | tx signature absent on-chain | **402** | terminal — payment does not exist |
| `PAYMENT_UNVERIFIED` | tx found, does not satisfy the claim | **402** | terminal — do not silently re-pay |
| `PAYMENT_NO_TRANSFER` | no qualifying transfer to recipient | **402** | terminal |
| `PAYMENT_NONCE_INVALID` | missing/consumed relay nonce (caller↔payer binding) | **402** | terminal — request a fresh nonce |
| `PAYMENT_REPLAYED` | signature already redeemed | **409** | terminal — already issued |
| `RPC_UNAVAILABLE` | transport failure reaching RPC | **503** | **retryable** — upstream transient, retry the SAME payment |
| `INTERNAL` | classifier catch-all / verifier threw | **500** | retryable with backoff; do NOT re-pay |

Normative rules:

1. The `code → status` map is centralised in one pure function
   (`httpStatusForErrorCode`) and one set (`UPSTREAM_ERROR_CODES`) so the
   route handler and `processPaymentRequest` cannot drift apart. Only
   `RPC_UNAVAILABLE` (→503) and `INTERNAL` (→500) are "upstream"; every
   other code is a definitive statement about the payment and stays
   402/409.
2. `processPaymentRequest` returns a discriminated `kind:"upstream"`
   (carrying the `ErrorCode`) distinct from `kind:"invalid"`. Transport
   /internal failures MUST NOT be reported as a genuine payment
   rejection. On the redis path the dedup lock is released on BOTH the
   `invalid` and `upstream` branches so an RPC outage frees the slot and
   a retry can re-verify the *same* on-chain payment (ADR-126
   §"Decision" step 3).
3. **C4-X402-05 (route-level catch — "every catch" made literal):** the
   ADR's "apply the same pattern to every `catch`" requirement is now
   enforced at the route boundary. `processPaymentRequest` wraps the
   (possibly-injected) verifier `await` in a try/catch *at the site that
   owns the redis release token*: a verifier that throws/rejects is
   classified, the lock is released with the owner token (no
   `SIGNATURE_TTL_MS` slot leak), and the failure is mapped onto
   `kind:"upstream"`. The `/pay` route additionally wraps the whole
   pipeline in a backstop try/catch so no unexpected throw can escape
   the ADR-117 envelope into Express's default 500 body (which would
   re-open the raw-exception leak this ADR closed).

Source: `docs/audits/ARCHITECTURE_REAUDIT_2026-05c-cycle4-security.md`
(C4-X402-02 HIGH, C4-X402-05 secondary);
`docs/audits/_cycle4-drafts/05-x402-relay.md`.

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

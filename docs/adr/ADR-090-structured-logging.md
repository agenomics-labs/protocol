# ADR-090: Structured logging with pino across off-chain services

## Status
Accepted

## Date
2026-04-23

## Context

The off-chain TypeScript services (mcp-server, indexer, x402-relay) used `console.log` / `console.error` / `console.warn` for every operational signal. Architecture-Audit-2026-04-23 finding O-01 counted **39 such call sites** across the three services:

- **mcp-server** — 7 calls (5 in `src/index.ts`, 1 in `actions/vault.ts`, 1 in `handlers/reputation.ts`, 1 in `handlers/registry.ts`).
- **src/indexer** — 23 calls in `index.ts` (every WebSocket lifecycle event, every backfill, every event ingest).
- **src/x402-relay** — 6 calls in `index.ts` (startup banner + the JWT_SECRET fatal exit).

The operational shape that follows from string-formatted log lines:

1. **No structured fields.** Logs cannot be JSON-aggregated; every parser regex on the operator side is a guess against a moving target.
2. **No correlation IDs.** A `vault_transfer` MCP call → settlement CPI → indexer event ingest leaves three log lines in three places, none of which can be cross-referenced. When something fails in production, the operator follows a hash by eye.
3. **No level routing.** `console.error` and `console.log` look identical in `journalctl`; severity is a comment in the message.
4. **No redaction.** Finding O-05: `process.env.SOLANA_KEYPAIR_PATH` and similar `.json` filesystem paths could be (and have been, in stack traces) emitted to logs verbatim. A leaked path narrows the keyspace for an attacker who has separately compromised the host.
5. **Lint-bypassable.** Nothing prevented a future contributor from adding the 40th `console.log`.

## Decision

### 1. pino as the log surface

`pino` 9.x is added as a dep to `mcp-server`, `src/indexer`, `src/x402-relay`. `pino-pretty` 11.x is the dev-mode transport (terminal-friendly, JSON in production).

Rationale for pino:
- ~10× faster than `winston`/`bunyan` (matters because every dispatch logs ≥3 lines).
- First-class `redact` option (the alternative — runtime field-walking — is what we'd have to write ourselves).
- `child()` produces a sub-logger that inherits bindings + redaction policy, so request-scoped loggers don't lose the policy.
- Native ISO timestamps via `pino.stdTimeFunctions.isoTime` — log aggregators (Loki, Splunk, CloudWatch) parse ISO without configuration.

### 2. Per-package logger module

Each off-chain package owns a `logger.ts` (or `util/logger.ts`) module with the same skeleton:

```typescript
const log = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
  base: { component: "<package-name>" },
  redact: { paths: REDACTION_PATHS, censor: "[REDACTED]" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { /* lowercase level, scrubJsonPaths */ },
  transport: !isProd && process.env.LOG_PRETTY !== "0"
    ? { target: "pino-pretty", options: { ... } }
    : undefined,
});
```

Files:
- `mcp-server/src/util/logger.ts` — exports `serverLogger`, `newCorrelationId`, `withRequestContext`.
- `src/indexer/logger.ts` — exports `logger`, `programLogger(label)`, `eventLogger(label, signature)`.
- `src/x402-relay/logger.ts` — exports `logger`, `newJwtId()`, `paymentLogger(txSignature, jti?)`.

The three modules duplicate ~50 LOC of redaction-list + scrub-formatter rather than sharing a helper through a fourth workspace package, because:
- The redaction list is short and stable.
- A shared package would create a new workspace member for ~50 LOC.
- Each service's redaction policy diverges in legitimate ways (x402-relay scrubs `JWT_SECRET` and `authorization`; indexer scrubs `DATABASE_URL`; mcp-server scrubs `AEP_REDIS_URL`).

### 3. Redaction policy

Every per-package logger redacts (replacing values with `[REDACTED]`):

| Field | Reason |
|-------|--------|
| `secretKey`, `*.secretKey`, `*.*.secretKey` | Solana 64-byte private key bytes |
| `keypair`, `*.keypair` | Same — the field name varies by site |
| `keypairPath`, `SOLANA_KEYPAIR_PATH` | Filesystem path narrows attack scope |
| `JWT_SECRET` (x402 only) | HS256 secret; recovery = forge any token |
| `authorization`, `headers.authorization` (x402 only) | Bearer tokens |
| `accessToken`, `token` (x402 only) | Same as above |
| `AEP_REDIS_URL` (mcp + indexer) | Connection string with password |
| `DATABASE_URL` (indexer only) | Same |

**Belt-and-braces (Finding O-05)**: a `log()` formatter walks every emitted record and replaces any string value matching `/\.json$/i` AND containing `/` with `[REDACTED-PATH]` — UNLESS the field name is on a `SAFE_KEYS` allowlist (`signature`, `pubkey`, `cid`, `$schema`, etc). Catches stray keypair-path leaks the static `redact.paths` list cannot pre-declare.

Verified by `mcp-server/test/logger.test.ts` — 14 redaction + correlation cases, all passing.

### 4. Correlation IDs

Three flow patterns:

#### MCP boundary (`mcp-server/src/index.ts`)

Every `CallToolRequestSchema` dispatch mints a fresh UUIDv4 `req_id` and attaches it to the request-scoped child logger via `withRequestContext`. Both `req_id` (this dispatch's id) and `corr_id` (= `req_id` at this edge) appear on every log line emitted during the dispatch.

```typescript
const reqId = newCorrelationId();
const reqLog = withRequestContext(log, reqId);
reqLog.debug({ tool: toolName }, "mcp dispatch begin");
```

#### Indexer ingest (`src/indexer/index.ts`)

The on-chain transaction signature doubles as `corr_id`. Every persisted event's log line carries the signature so an operator can grep for one signature and see every program subscription that observed it, plus every retry / parse / store stage.

```typescript
programLogger(label).info(
  { event_name: event.name, slot: ctx.slot, corr_id: logs.signature },
  "event ingested",
);
```

#### x402-relay (`src/x402-relay/index.ts`)

The on-chain payment signature is `corr_id`. Each issued JWT additionally gets a `jti` (UUIDv4) so a downstream service that decodes the JWT can re-correlate independently of the on-chain signature (which an unauthenticated endpoint should not see).

### 5. ESLint enforcement

Each off-chain package's `.eslintrc.json` adds:

```json
"rules": { "no-console": "error" }
```

Test files are exempted via an `overrides` block (test fixtures may legitimately `console.log` for debugging).

The 40th `console.log` will fail CI.

### 6. CI hookup

`mcp-server`'s `npm test` script gains the new `test/logger.test.ts` test file. Indexer + x402-relay don't have unit tests yet (separate punch-list item) — they get the lint gate as enforcement until a test file lands.

The eslint rule does NOT require a separate CI job — ADR-090 piggybacks on the existing `typescript-check-*` jobs by relying on a future `npm run lint` step. **This ADR does not add an `npm run lint` step**; the eslint config is in place, the next ADR (TBD) wires the lint job. Until then, the rule is enforced at developer time only. Rationale: scope discipline — sub-track B is logging, not linting infrastructure.

## Alternatives Considered

### Alternative A: winston

Battle-tested, more features. Rejected: 2-3× slower, redaction is bring-your-own (or via `logform.format.printf` which loses structured-data benefits), and the API surface is larger. pino's smaller-and-faster wins for a hot path that runs on every dispatch.

### Alternative B: bunyan

Same shape as pino but slower and largely unmaintained (last release 2018). No reason to choose it over pino.

### Alternative C: A shared `@agenomics/logger` workspace package

Tempting because it would centralize the redaction list. Rejected: see §2 — duplication is ~50 LOC each; centralizing creates a 4th workspace member that every off-chain service gains a `file:` dep on, increasing coupling for low payoff. Revisit if the redaction list grows past ~20 entries.

### Alternative D: OpenTelemetry first

Real distributed tracing (spans + context) is the long-term direction. Rejected for now: OTel for Node still requires a collector deployment and code instrumentation per span. ADR-104 (item 27 from the audit) covers this. Structured logging is a strictly-smaller scope and a precondition for OTel adoption (you still want JSON logs alongside spans).

### Alternative E: Keep `console.*`, add a regex log scraper

The "we'll grep for it" approach. Rejected — not scalable, and the redaction case (Finding O-05) requires field-aware scrubbing that a regex on the receiver cannot do without losing safe paths.

## Consequences

### Positive

- **Operator-grade logs.** JSON in production, pretty in dev. Every line carries `level`, `time`, `component`, `req_id`, `corr_id`, `msg`.
- **Correlation across services.** A `vault_transfer` produces matching `corr_id` lines in mcp-server, indexer, and x402-relay (when payment-protected). Operator finds the failing path with one grep.
- **Redaction is mechanical.** The 14 redaction tests prove the policy fires for the common leak shapes; a contributor adding a new field with a sensitive name is forced to either redact-list it or live with the secret in logs (and the lint gate makes that an explicit decision, not an oversight).
- **No future `console.log` regressions.** ESLint rule blocks new `console.*` in source files; tests can still console-log for debugging.
- **Performance budget unchanged.** pino + redaction cost ~3μs per call; even at the indexer's worst case (~100 events/s during backfill) that's 300μs/s — sub-1% of one core.

### Negative

- **Test surface grows.** 14 new test cases in `mcp-server/test/logger.test.ts` add ~10ms to the suite — negligible but real.
- **Two new runtime deps per package.** `pino` (~150 KB on disk) + `pino-pretty` (~80 KB). Already accepted by ADR-089's unified install.
- **Pretty mode requires `pino-pretty` reachable at runtime.** Fine for dev (it's a workspace dep); requires explicit `LOG_PRETTY=0` if a constrained prod environment can't fork the transport process. Default behaviour (production NODE_ENV) skips it.
- **Operators must learn the new fields.** `req_id` vs `corr_id` is a real distinction, and a runbook is owed. Out of scope for this ADR; the field names are documented in `mcp-server/src/util/logger.ts` jsdoc and the dedicated logger files.
- **stderr-write fallback for the JWT_SECRET fatal exit.** x402-relay's pre-logger fatal must use `process.stderr.write` directly because the logger has not been initialized at that program point AND the message itself contains the redacted field name in a way the JSON serializer would obscure. One acceptable exception, called out in the source comment.

### Neutral

- **No protocol behaviour change.** Logs are observability surface; no on-chain or wire effect.
- **Composes with ADR-091 (NodeNext / ESM).** The logger module uses standard ES module syntax that survives the module-system migration unchanged.
- **Composes with ADR-104 future OTel work.** pino has an OTel exporter (`@opentelemetry/instrumentation-pino`) so spans can pull `trace_id` / `span_id` into log records once the OTel SDK is wired in.

## References

- `mcp-server/src/util/logger.ts` — primary implementation
- `mcp-server/test/logger.test.ts` — 14 redaction + correlation tests
- `mcp-server/.eslintrc.json` — `no-console: error` rule + test override
- `src/indexer/logger.ts` + `src/indexer/.eslintrc.json` — indexer surface
- `src/x402-relay/logger.ts` + `src/x402-relay/.eslintrc.json` — relay surface
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` items 14 / O-01 / O-05 — the audit findings this ADR closes
- `docs/adr/ADR-079-operator-key-hygiene.md` — the broader key-hygiene story this redaction policy serves
- `docs/adr/ADR-089-reproducible-installs.md` — the install surface that delivered pino + pino-pretty
- `docs/adr/ADR-091-module-system-nodenext.md` — orthogonal but shipped together (sub-track C)

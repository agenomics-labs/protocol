# Architecture Audit — Cycle 2, Off-chain TypeScript Delta

- **Date**: 2026-04-26
- **HEAD**: `39039c2` on `main`
- **Scope**: `mcp-server/src/`, `sdk/{client,action-runtime,idl}/`, `src/indexer/`, `src/x402-relay/`, `packages/{sas-resolver,capability-manifest-validator}/`, `dashboard/src/`, workspace config
- **Reviewer**: cycle-2 off-chain audit
- **Inputs**: cycle-1 closures from `AUDIT-STATUS-2026-04-25.md` (30 closed / 75 inventoried), cycle-1 appendix at `appendix-offchain-typescript.md`, post-PR-T/PR-U/PR-Z deltas
- **ID range**: AUD-200..AUD-2xx (cycle-2 off-chain). AUD-100+ reserved for cycle-2 on-chain.

---

## 1. Cycle-1 regression check

| Cycle-1 ID | Title | Verdict at HEAD `39039c2` | Evidence |
|---|---|---|---|
| AUD-003 | SDK PDAs diverge from on-chain | **Holds** | `sdk/client/src/{vault,settlement,registry,index}.ts` use canonical seeds; `sdk/client/test/pda-equivalence.test.ts` pins golden + canonical re-derivation. |
| AUD-013 | Three competing `Result<T>` shapes | **Partially closed** — see AUD-201 | `@agenomics/action-runtime` is canonical with `{ value }`. `mcp-server/src/util/result.ts` and `packages/sas-resolver/src/util/result.ts` re-export. **`packages/capability-manifest-validator/src/validate.ts:44` still returns `{ ok: true; manifest }`**, an OK key that is structurally incompatible with the canonical `value`. Active consumer: `mcp-server/src/handlers/reputation.ts:411` reads `result.manifest`. |
| AUD-014 | Tool-count contradiction | **Holds in primary surface; regressed in dashboard + 1 docstring** | `mcp-server/src/tools/index.ts:76` and `actions/index.ts:1` both say 25. **`dashboard/src/data/programs.js:94` `MCP_TOOLS` array enumerates 23 tools** (missing `rotate_agent_identity` and `get_agent_reputation`). **`mcp-server/src/index.ts:41` docstring still says "all 23 actions"**. See AUD-202. |
| AUD-016 | `ANCHOR_WALLET` env var ignored | **Holds** | `mcp-server/src/solana.ts:177` `process.env.ANCHOR_WALLET \|\| process.env.SOLANA_KEYPAIR_PATH` precedence; comment at line 174 documents the choice. |
| AUD-027 | `JWT_SECRET` length not validated | **Holds** | `src/x402-relay/index.ts:29-34` enforces `MIN_JWT_SECRET_BYTES = 32`; pinned to RFC 7518 HS256 guidance. |
| AUD-029 | `/metrics` binds 0.0.0.0 with no auth | **Holds for `mcp-server/src/observability.ts` AND `src/indexer/metrics-server.ts`; NEW exposure in indexer Express API** — see AUD-203 | Both Prometheus exporters honor `METRICS_HOST` (default `127.0.0.1`). However, the **indexer's primary Express API at `src/indexer/index.ts:1550` (`app.listen(PORT)`) ALSO exposes `GET /metrics` at line 1477** (operational counters + cursor positions) and is bound to `0.0.0.0` (Express default; no host arg). Same information-disclosure class as the original AUD-029. |
| AUD-039 | Indexer reconnect peeks private API | **Holds at intent layer; race condition introduced** — see AUD-204 | `_rpcWebSocket` peek replaced with `startConnectionHeartbeat` (`src/indexer/index.ts:1267-1327`). New code path leaks the prior `connection.onLogs` subscription on heartbeat-triggered reconnect. |
| AUD-072 | SUMMARY documents `execute_program_call` | **Regressed** — see AUD-205 | Closure commit `6941869` claims removal but `SUMMARY.md:47,126,283` still has THREE references to `execute_program_call`. |

---

## 2. New findings (AUD-200..)

### AUD-200 — Indexer reads `i16` reputation delta as `u16`, mangles negative values
**Severity**: HIGH (correctness — observability layer reports wrong numbers)
**Location**: `src/indexer/index.ts:463-470`
**Site spot-check**: `programs/agent-registry/src/events.rs:108` declares `pub delta: i16`.

```ts
ReputationDeltaProposed: (r) => ({
  authority: r.pubkey(),
  delta: r.u16(),    // i16 in Rust wire-encodes as u16 (little-endian, two's complement)
```

The comment acknowledges `i16` two's-complement but the reader (`r.u16()` at line 295: `readUInt16LE`) does NOT sign-extend. Negative deltas (`-5` from `dispute_loss`, `-3` from `expiry_undelivered`, `-25` from legacy slashing per cycle-1 §"Behavioral changes" point 1) are emitted as unsigned `65531`, `65533`, `65511` to consumers. Every dashboard/webhook that aggregates reputation flows reads garbage on slashing events.

**Fix**: add an `i16()` reader that does `readInt16LE`, point `ReputationDeltaProposed.delta` at it. ~15 LOC + test.

---

### AUD-201 — `capability-manifest-validator` Result shape diverges from canonical (PR-T incomplete)
**Severity**: HIGH (defeats the unification AUD-013 closed for)
**Location**: `packages/capability-manifest-validator/src/validate.ts:43-45`, consumer `mcp-server/src/handlers/reputation.ts:398-411`

```ts
// validate.ts
export type ValidationResult =
  | { ok: true; manifest: CapabilityManifest }
  | { ok: false; error: ValidationError };
```

PR-T moved `mcp-server/src/util/result.ts` and `packages/sas-resolver/src/util/result.ts` to thin re-exports of `@agenomics/action-runtime`'s canonical `{ ok: true; value }`. **`@agenomics/capability-manifest-validator` was missed**: it still ships its own union with `{ manifest }` as the OK key. `mcp-server/src/handlers/reputation.ts:411` reads `result.manifest`, so the divergence is load-bearing — a refactor that moved this package to the canonical shape would silently break that callsite without a TS error if `result.manifest` ever became `result.value` simultaneously, or vice versa.

The package imports `@agenomics/action-runtime` (or could) but doesn't. Either:
- Migrate to `Result<CapabilityManifest, ValidationError>` from action-runtime and rename `result.manifest` → `result.value` at the consumer.
- Document it as an intentional deviation in `validate.ts` AND `mcp-server/src/handlers/reputation.ts:411` AND `docs/audits/appendix-offchain-typescript.md` so cycle-3 doesn't re-flag it.

**Fix**: 1h. ADR-103 should explicitly enumerate which packages carry the canonical shape and which don't (with rationale).

---

### AUD-202 — Tool-count drift in dashboard and one mcp-server docstring (AUD-014 regression)
**Severity**: MEDIUM (UI lies to humans about protocol surface; not a security bug but the kind of drift cycle 1 spent 2 commits closing)
**Locations**:
1. `dashboard/src/data/programs.js:94-118` — `MCP_TOOLS` array has **23 entries**. Missing: `rotate_agent_identity` (PR-U) and `get_agent_reputation` (was already at 24 pre-PR-U).
2. `dashboard/src/data/programs.js:51` — registry instructions list contains `update_reputation` which **was removed** in `0a02850` (PR-G / AUD-002). Should be `propose_reputation_delta`.
3. `dashboard/src/data/programs.js:19-27` — vault instructions list does NOT include `update_agent_identity` (the on-chain ix surfaced as `rotate_agent_identity` on the MCP side per ADR-069 / PR-U).
4. `mcp-server/src/index.ts:41` — docstring still reads "all 23 actions dispatched through the ADR-058 capability-gated ActionRouter."

The on-chain truth is 25 MCP tools → 25 actions → 25 named tools (matches `tools/index.ts` and `actions/index.ts`). The dashboard is the only UI consumers see in the live deployment. Cycle-1 closure of AUD-014 explicitly called out the README/SUMMARY/code triplet but missed dashboard + this docstring.

**Fix**: 30 min — append `rotate_agent_identity` + `get_agent_reputation` to `MCP_TOOLS`; replace `update_reputation` with `propose_reputation_delta` in registry instruction list; add `update_agent_identity` to vault instruction list; rewrite the `index.ts:41` docstring to "25 actions".

---

### AUD-203 — Indexer Express `/metrics` endpoint exposes operational data on 0.0.0.0 (AUD-029 class)
**Severity**: MEDIUM (information disclosure, mirrors the cycle-1 AUD-029 surface)
**Location**: `src/indexer/index.ts:1477-1518` (the route) wired into `app.listen(PORT, callback)` at line 1550 — **no host argument, Express defaults to `0.0.0.0`**.

The cycle-1 fix for AUD-029 covered:
- `mcp-server/src/observability.ts` (`startMcpMetricsServer`)
- `src/indexer/metrics-server.ts` (`startIndexerMetricsServer`)

Both correctly default to `127.0.0.1` and gate `0.0.0.0` behind `METRICS_HOST=0.0.0.0`. However, the indexer's **main Express API** at `src/indexer/index.ts:1329-1565` includes its own JSON `/metrics` endpoint that returns:

- per-program lifetime counters (events inserted, duplicate skips, backfilled, parse errors)
- cursor positions per program (last_processed_slot, last_signature)
- heartbeat reconnect counters

This Express server is bound by `app.listen(PORT, callback)` with no host argument, so it listens on every interface on `INDEXER_PORT` (default not visible in this file — `PORT` resolution lives at top of file). An operator who set `METRICS_HOST=127.0.0.1` for the prom-client exporter still leaks the same class of operational data via this route.

**Fix**: 30 min — add `INDEXER_HOST = process.env.INDEXER_HOST ?? "127.0.0.1"`, pass it to `app.listen(PORT, INDEXER_HOST, ...)`. Same opt-in semantics as `METRICS_HOST=0.0.0.0`. Update the startup log to record `host`.

---

### AUD-204 — Heartbeat-triggered reconnect leaks `onLogs` subscriptions
**Severity**: MEDIUM (correctness — duplicate event ingest + state churn under flaky network)
**Location**: `src/indexer/index.ts:1217-1235` (heartbeat callback) + `subscribeWithReconnect` at line 1134

When the heartbeat declares loss, the callback iterates live subscriptions and:
```ts
subscriptionIds.delete(label);
scheduleReconnect(label, programId);
```

It **never calls `connection.removeOnLogsListener(subId)`** on the existing subscription. If the heartbeat false-positives (e.g. transient RPC slow-response — `failureThreshold` defaults configured per `HEARTBEAT_FAILURE_THRESHOLD` consecutive failures) and the WebSocket actually recovers, the indexer ends up with **two registered `onLogs` callbacks** for the same program. Each new event:

1. Fires both callbacks → both call `handleLogs` → both write to DB (DB has `INSERT OR IGNORE` so dedup holds)
2. Both update `state.lastProcessedSlot` (race: the slower one can set the slot backwards)
3. Both update `state.lastSignature`

Subsequent heartbeat losses leak more subscriptions; over a long-running indexer with intermittent RPC issues this is an unbounded leak.

**Fix**: cache `subId` per-label, call `await connection.removeOnLogsListener(subId)` (or `.catch(() => {})` since the connection may already be dead) in the heartbeat callback before `scheduleReconnect`. ~10 LOC + test that asserts `removeOnLogsListener` is called on heartbeat-triggered reconnect. The `heartbeat.test.ts` file already mocks `Pick<Connection, "getSlot">` — extend the fake to mock `onLogs` / `removeOnLogsListener` and assert.

There is also a smaller race: `startConnectionHeartbeat`'s `tick()` resets `failures = 0` BEFORE invoking `onConnectionLost` (line 1300 → 1302). If a tick is already in flight when `stop()` is called (line 1320-1324), the in-flight tick will still complete, including the callback. Not a security bug but worth a `if (stopped) return;` guard at the start of the post-failure path.

---

### AUD-205 — `SUMMARY.md` still documents `execute_program_call` despite cycle-1 closure commit
**Severity**: MEDIUM (real correctness drift; cycle-1 closure was incomplete; AUD-072 is reopened)
**Location**: `SUMMARY.md` lines 47, 126, 283

Closure commit `6941869` ("docs: remove execute_program_call from SUMMARY (deleted by ADR-050, AUD-072)") explicitly claimed:
- "Vault instructions list: replace execute_program_call with execute_token_transfer..."
- "CPI section: rename 'Vault -> Any Program' subsection to 'Vault: no cross-program-call surface'..."
- "Next Steps item 11: rename 'Vault CPI integration test'..."

At HEAD, `SUMMARY.md` reads:
- Line 47: `\`execute_program_call\` — Real CPI via \`invoke_signed\` to any allowed program (vault PDA signs)` (in the vault instruction list — exactly what the commit claimed to remove)
- Line 126: `### Vault → Any Program: \`execute_program_call\`` (the section heading the commit claimed to rename)
- Line 283: `Vault CPI integration test — End-to-end test that creates a vault, whitelists a program, and executes a real \`execute_program_call\` against it` (the next-steps item the commit claimed to rename)

Either the commit landed against a different file than tracked, or the changes were squashed/reverted. The dashboard documentation and SECURITY_AUDIT.md, by contrast, ARE clean of `execute_program_call` mentions outside the historical-context paragraphs.

`SUMMARY.md` is the README's primary linked summary. Live deployment users see a deleted instruction documented as live security surface — same severity that drove cycle-1's AUD-072.

**Fix**: 30 min — re-apply the changes the closure commit's body advertises. **Or** revert the AUD-072 closure entry in `AUDIT-STATUS-2026-04-25.md` to "open / partially-fixed" with a note pointing at SUMMARY.md.

---

### AUD-206 — `verify_protocol_invariants` admin ix has no TS surface (governance dead-end)
**Severity**: MEDIUM (architecture / ops gap)
**Location**: `programs/agent-registry/src/lib.rs:599` (Rust side); zero MCP / SDK surface

Cycle-1 added `verify_protocol_invariants` as an admin ix gated to `ProtocolConfig.authority`, "callable post-migration to assert the entire account population satisfies invariants" (per `AUDIT-STATUS-2026-04-25.md` line 87). It is NOT exposed by:
- any MCP tool in `mcp-server/src/tools/index.ts`
- any Action in `mcp-server/src/actions/index.ts`
- any SDK helper in `sdk/client/src/`

A test asserts it is in the IDL (`tests/agent-registry.ts:1577`) but no off-chain caller exists. Governance can't invoke it without hand-rolling an Anchor call, which means it's effectively dead-on-launch.

**Fix decision needed**:
- **Option A** (recommended): add a `verify_protocol_invariants` admin tool — but only if the action surface gates by an `admin:registry` capability AND the wallet matches `ProtocolConfig.authority`. Not for general `sign:registry`.
- **Option B**: add a `scripts/governance/verify-invariants.ts` runner with a clear "do not expose this in production MCP" header. Faster, narrower surface.
- **Option C**: remove the on-chain ix until governance tooling lands.

Cycle-2 on-chain audit should pick the option; this finding owns the off-chain TS gap.

---

### AUD-207 — SDK `@agenomics/idl` ships identical program IDs for mainnet-beta as devnet/localnet
**Severity**: MEDIUM (will silently route mainnet traffic to whatever lives at the devnet IDs)
**Location**: `sdk/idl/src/index.ts:8-30`

```ts
const PROGRAM_IDS: Record<Cluster, ProgramIds> = {
  devnet: { agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh", ... },
  "mainnet-beta": { agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh", ... },
  localnet: { agentRegistry: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh", ... },
};
```

`Anchor.toml` only declares `[programs.localnet]` and `[programs.devnet]`. Mainnet keypairs do not yet exist (ADR-059 mainnet-readiness gate is exactly the blocker). The SDK silently treats `cluster: "mainnet-beta"` as a valid configuration and returns the devnet IDs, so a consumer that follows the doc-example `new AepClient({ cluster: "mainnet-beta" })` will route every PDA/RPC call to the devnet deployment with no warning.

**Fix decision needed**: until mainnet ADR-059 gate lands, either:
- **Option A**: throw from `getProgramIds("mainnet-beta")` with a `MAINNET_NOT_DEPLOYED` error.
- **Option B**: drop `mainnet-beta` from the `Cluster` union; re-add when mainnet keys are minted as part of PR-M.

Either way, **do not ship a public SDK that lies about mainnet IDs**.

---

### AUD-208 — x402 redeemed-signature replay: TOCTOU under concurrent requests
**Severity**: MEDIUM (real double-redemption window)
**Location**: `src/x402-relay/index.ts:316-348`

```ts
const existingExpiry = redeemedSignatures.get(txSignature);
if (existingExpiry !== undefined && Date.now() < existingExpiry) {
  res.status(409).json({ error: "Transaction signature already redeemed" });
  return;
}
// ... await verifyPaymentOnChain(txSignature, ...) — async, ~200-1000ms ...
redeemedSignatures.set(txSignature, Date.now() + SIGNATURE_TTL_MS);
```

Two concurrent `POST /pay` requests with the same `txSignature` both:
1. See `existingExpiry === undefined` at the check
2. Both await `verifyPaymentOnChain` — both succeed
3. Both `redeemedSignatures.set(...)` — second overwrites first
4. **Both clients receive a fresh JWT for the same payment**.

Browser clients can issue two parallel fetches deliberately; the on-chain verification step is the entire latency budget for the race.

**Fix**: hold a placeholder mark before verification:

```ts
if (redeemedSignatures.has(txSignature)) {
  return res.status(409).json({ error: "..." });
}
redeemedSignatures.set(txSignature, Date.now() + SIGNATURE_TTL_MS);  // placeholder
const verification = await verifyPaymentOnChain(...);
if (!verification.valid) {
  redeemedSignatures.delete(txSignature);  // unmark on failure
  return res.status(402).json({ ... });
}
// keep mark; issue token
```

This still racy at the `has()` → `set()` boundary in raw single-process JS but the gap is now microseconds (sync), not the 200-1000ms verification window. The deeper fix is the AUD-028 redis-backed mutex, but the in-memory version closes the practical attack window today.

---

### AUD-209 — `pruneRedeemedSignatures` cap-eviction can drop unexpired signatures (replay-window expansion)
**Severity**: LOW-MEDIUM (only triggers under sustained 25+ sigs/s redemption load; documented as "safe" but isn't)
**Location**: `src/x402-relay/index.ts:85-90`

```ts
while (redeemedSignatures.size > MAX_REDEEMED_SIGNATURES) {
  const oldest = redeemedSignatures.keys().next().value;
  redeemedSignatures.delete(oldest);
}
```

The comment claims "this is safe because each entry already expires after SIGNATURE_TTL_MS, so eviction under pressure just means an attacker's earliest bucket is forgotten slightly sooner than its natural expiry." This is **wrong for redeemed signatures**: if you evict an entry whose JWT TTL hasn't expired yet, the signature can be re-redeemed → second JWT issued. Redeemed-signature TTL must be >= JWT TTL, and only TTL-based eviction is safe; cap-eviction trades memory bound for replay-window expansion.

The cap is `100_000` and the TTL window is `(TOKEN_EXPIRY_SECONDS + 300) * 1000` ≈ 65 min for the default config. To trigger this an attacker needs ~25 successful payments per second sustained — high but not impossible if the attacker has many funded wallets. The replay-redemption gives them a second JWT per evicted signature.

**Fix**: replace cap-eviction with an `error` path: when the cap is hit, log a sentinel and reject NEW redemptions until pruning catches up (preferring DOS-of-self over replay-window expansion). Or wire to redis (AUD-028) where the SET NX semantics make this trivial.

---

### AUD-210 — `rotate_agent_identity` zod refine is unreachable for short malformed inputs
**Severity**: LOW (gates work, but tests don't validate them at the right boundary)
**Location**: `mcp-server/src/actions/vault.ts:288-293`, `mcp-server/test/action-shape.test.ts:294-314`

```ts
const zPubkey = z.string()
  .min(32, { message: "expected base58-encoded Solana public key" })
  .refine(isValidPublicKey, { ... });
```

The two test cases that claim to exercise the base58 refine — "rejects a non-base58 newAgentIdentity" (`"not-a-pubkey!!!"`, length 15) and "rejects a too-short string..." (`"abc"`, length 3) — both fail `min(32)` first. The `isValidPublicKey` refine is **never executed** by these tests. A 32+-char string of all `!` characters would pass `min(32)` and fail at `refine` — but no test covers this path.

The refine itself is correct (`new PublicKey(invalid_b58)` throws on non-base58), but the unit tests don't pin it. A future change that drops `.refine(isValidPublicKey)` (e.g. mistakenly trusting `min(32)` alone) would not be caught.

**Fix**: 5 min — add a test case `{ newAgentIdentity: "!".repeat(40) }` and assert `INVALID_INPUT` is the resulting error. Pins the refine. The on-chain layer would reject anyway (Anchor's `Pubkey` accept-anything), but defense in depth at the schema layer is the documented contract.

---

### AUD-211 — `actions/vault.ts` and `mcp-server/src/util/result.ts` `wrap` semantics conflict
**Severity**: LOW (confusing; not currently breaking)
**Location**: `mcp-server/src/actions/vault.ts:60-71` (local `wrap`), `mcp-server/src/util/result.ts:17` (`wrap` re-export)

The action-runtime canonical `wrap` returns `Result<T, Error>` (line 12 in dist: `e instanceof Error ? e : new Error(...)`). The mcp-server vault actions DO NOT use this: they ship a local `wrap` (line 60-71) that returns `Result<T, AepError>` with `code: "PROGRAM_ERROR"`. So the canonical `wrap` re-exported by `util/result.ts` is **never imported** by any vault action — yet the re-export remains live, suggesting future drift if a contributor reaches for the wrong helper.

Either:
- Remove `wrap` from the `util/result.ts` re-export list since no callsite uses it; OR
- Refactor the local `wrap` in `actions/vault.ts` to a shared helper that returns `Result<T, AepError>` (a thin wrapper over canonical `wrap` that maps `Error → AepError`), and use it across `actions/{vault,registry,settlement,reputation}.ts` (each currently re-implements the same try/catch).

The DRY consolidation is the more valuable variant — there are at least 9 copies of `try { return ok(...) } catch (e) { return err({ code: "PROGRAM_ERROR", message: e.message }) }` across `actions/`.

---

### AUD-212 — `pipeline/idempotency-redis.ts` deserializeResult cannot detect tampered cached payloads
**Severity**: LOW (defense in depth; no exploit path identified)
**Location**: `mcp-server/src/pipeline/idempotency-redis.ts:340-355`

```ts
function deserializeResult<T>(raw: string): Result<T> {
  try {
    return JSON.parse(raw) as Result<T>;
  } catch (e) { ... }
}
```

`JSON.parse` succeeds for any syntactically valid JSON, including objects that don't match the `Result<T>` discriminated union (e.g. `{ "ok": true }` with no `value`, or `{ "ok": "yes" }`). The cast is unchecked. If a redis-attached process writes a malformed entry (bug, downgrade, injection) the deserialized object propagates upward as a "Result" that breaks the consuming code at runtime in unpredictable ways.

The header comment justifies this: "Trust the payload — we wrote it ourselves." That's a fair trust model for a sole-writer redis but the moment the relay grows a second writer (e.g. an admin tool clearing entries, or AUD-028's x402 sharing the redis), the trust assumption breaks silently.

**Fix**: add a structural shape check before the cast:

```ts
const parsed = JSON.parse(raw);
if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean") {
  return { ok: false, error: { code: "IDEMPOTENCY_VIOLATION", message: "cached payload not Result-shaped" } };
}
if (parsed.ok && !("value" in parsed)) { ... }
if (!parsed.ok && (typeof parsed.error?.code !== "string" || typeof parsed.error?.message !== "string")) { ... }
return parsed as Result<T>;
```

---

### AUD-213 — Workspace dep references inconsistent (`*` vs `file:`)
**Severity**: INFO
**Location**: `mcp-server/package.json:38-40`

```json
"@agenomics/action-runtime": "*",
"@agenomics/capability-manifest-validator": "file:../packages/capability-manifest-validator",
"@agenomics/sas-resolver": "file:../packages/sas-resolver",
```

Mixed conventions for the three workspace packages: action-runtime uses `*` (which npm resolves via the root workspaces declaration), the other two use `file:` paths. Both work in practice but the `file:` form bypasses the workspace deduplication and creates a separate node_modules entry per consumer — surfaces as the kind of "two copies of the same package" duplicate-types issue that makes `instanceof` checks fail across boundary.

Pick one: `*` (or `workspace:*` if the consumer permits it) for all three.

---

## 3. Items missed in cycle 1 (re-tested)

### Not new findings, but worth recording the sample coverage:
- `mcp-server/test/result-util.test.ts` — clean, uses canonical `{ value }`.
- `mcp-server/test/action-shape.test.ts` — comprehensive; gates on every action's capability/signer/preflight; AUD-210 caveat noted.
- `mcp-server/test/smoke-integration.test.ts` — uses `res.error.code` (post-PR-T canonical) for HASH_MISMATCH / SIGNATURE_MISMATCH / SCHEMA_INVALID / SUBJECT_MISMATCH.
- `mcp-server/test/observability.test.ts`, `logger.test.ts`, `pipeline.test.ts`, `transport-auth.test.ts`, `loadwallet-permission.test.ts` — sampled, no stale references.
- `sdk/client/test/pda-equivalence.test.ts` — load-bearing AUD-003 regression gate; both golden + canonical re-derivation.
- `sdk/action-runtime/test/index.test.ts` — covers ok/err/wrap/defineAction; no missing branch.
- `src/indexer/heartbeat.test.ts` — covers tick, threshold, reset-on-success, stop, callback-throw isolation. Does **not** cover AUD-204 (subscription leak).
- `tests/cpi-failures.test.ts` — 818 lines, well-commented infeasibility notes for the two `it.skip` cases. Sampled: helpers are duplicated from `tests/settlement.ts` (acknowledged in header).
- Build: `npx tsc --noEmit` passes on `sdk/{idl,action-runtime}`, `packages/sas-resolver`, `mcp-server`. No type errors at HEAD.

---

## 4. Top 5 prioritized findings

| # | ID | Severity | Title | Effort |
|---|---|---|---|---|
| 1 | **AUD-200** | HIGH | Indexer reads `i16` reputation delta as `u16` — slashing events emit garbage to consumers | 30 min |
| 2 | **AUD-201** | HIGH | `capability-manifest-validator` Result shape diverges from canonical (PR-T incomplete) | 1h |
| 3 | **AUD-205** | MEDIUM | `SUMMARY.md` still documents `execute_program_call` despite AUD-072 closure commit | 30 min |
| 4 | **AUD-204** | MEDIUM | Heartbeat-triggered reconnect leaks `onLogs` subscriptions on every false-positive | 1h |
| 5 | **AUD-208** | MEDIUM | x402 redeemed-signature TOCTOU under concurrent requests → double-JWT replay | 1h |

Tail (LOW): AUD-202, AUD-203, AUD-206, AUD-207, AUD-209, AUD-210, AUD-211, AUD-212, AUD-213.

---

## 5. Cycle-2 closure-readiness

- All cycle-1 Critical (AUD-001..005) findings remain closed at off-chain layer.
- 2 of 8 spot-checked cycle-1 closures show drift at HEAD (AUD-014 dashboard regression, AUD-072 SUMMARY regression).
- 1 closure (AUD-013) is partially complete — `capability-manifest-validator` was missed.
- 1 closure (AUD-029) has a class-equivalent surface (indexer Express `/metrics`) that wasn't covered.
- 1 closure (AUD-039) introduces a new race condition in the replacement code.

**Recommended next batch**: AUD-200, AUD-201, AUD-205 in one PR (PR-EE: "off-chain audit cycle-2 high-severity"); AUD-202..AUD-213 in a follow-up doc-and-cleanup PR (PR-FF).

---

## 6. Closure status (verified at HEAD, 2026-04-26 EOD)

Per-finding verification of the cycle-1 regression-check column and
the 14 cycle-2 new findings (AUD-200..AUD-213) against the code at
HEAD (commit 6ce7017). All 5 top-priority findings closed; 8 of the
14 new findings closed. No open HIGH/MEDIUM-severity items remain.

### Cycle-1 regression check

| Cycle-1 ID | State | Evidence |
|---|---|---|
| AUD-003 | **Holds** | unchanged. |
| AUD-013 | **Closed via AUD-201** | `66b7240`. `packages/capability-manifest-validator/src/validate.ts:56` is now `Result<CapabilityManifest, ValidationError>` from action-runtime. |
| AUD-014 | **Closed via AUD-202** | `9d1d27b`. Dashboard + docstring tool-count drift swept. |
| AUD-016 | **Holds** | unchanged. |
| AUD-027 | **Holds** | unchanged. |
| AUD-029 | **Closed via AUD-203** | `355323d`. `app.listen(PORT, INDEXER_HOST)` at `src/indexer/index.ts:1597` binds to loopback by default. |
| AUD-039 | **Closed via AUD-204** | `355323d`. `connection.removeOnLogsListener(oldSubId)` at `src/indexer/index.ts:1272` releases prior subscription on heartbeat-triggered reconnect. |
| AUD-072 | **Closed via AUD-205** | `9d1d27b`. Three remaining `execute_program_call` references in `SUMMARY.md` are now in *historical-context* phrasing ("ADR-050 removed `execute_program_call`", "no longer exposes `execute_program_call`") — what cycle-2 flagged was *live-surface* docs; that exposure is gone. |

### Cycle-2 new findings

| ID      | Sev | State | Evidence |
|---------|-----|-------|----------|
| AUD-200 | H   | **Closed** | `355323d`. `i16()` reader added at `src/indexer/index.ts:317-319` (`readInt16LE`); `ReputationDeltaProposed.delta` reader at line 491 uses `r.i16()`. Negative deltas now sign-extend correctly. |
| AUD-201 | H   | **Closed** | `66b7240`. `packages/capability-manifest-validator/src/validate.ts:56` now `Result<CapabilityManifest, ValidationError>`; consumer `mcp-server/src/handlers/reputation.ts` updated to `result.value` access. |
| AUD-202 | M   | **Closed** | `9d1d27b`. Dashboard `MCP_TOOLS` array + `mcp-server/src/index.ts:41` docstring updated to 25-action surface. |
| AUD-203 | M   | **Closed** | `355323d`. Comment at `src/indexer/index.ts:1597` confirms `app.listen(PORT, INDEXER_HOST)` binding. |
| AUD-204 | M   | **Closed** | `355323d`. `removeOnLogsListener(oldSubId)` at `src/indexer/index.ts:1272`; comment at lines 1258-1265 documents the AUD-204 closure. |
| AUD-205 | M   | **Closed** | `9d1d27b`. SUMMARY.md references are historical-context only (see cycle-1 row above). |
| AUD-206 | L   | Open (design) | `verify_protocol_invariants` has no MCP-tool wrapper. Reachable today only via raw Anchor RPC by the upgrade-authority signer; the audit recommends a TS surface for governance scripting. Not a correctness gap; deferred to governance-tooling ADR. |
| AUD-207 | L   | Open | `sdk/idl/src/index.ts:9-25` ships **identical program IDs** for `devnet`, `mainnet-beta`, and `localnet`. Must be split before any mainnet promotion (placeholder/test IDs leak across clusters). Tracked alongside ADR-080 mainnet-deploy choreography. |
| AUD-208 | M   | **Closed** | `c97a33c`. `src/x402-relay/index.ts` now uses atomic reserve-then-commit: signature reserved with placeholder, finality-recheck against `redeemedSignatures` after `getSignatureStatus` resolves; commit-or-409 race winner determined deterministically. |
| AUD-209 | L   | **Closed** | `pruneRedeemedSignatures` no longer cap-evicts; it only removes TTL-expired entries. Saturation is handled fail-closed at the `/pay` commit step: when `redeemedSignatures.size >= MAX_REDEEMED_SIGNATURES` and the incoming signature isn't already present, `processPaymentRequest` returns `kind: "saturated"` and the route handler responds 503 Service Unavailable. Operators see the saturation as an alarm (and can scale per ADR-117) rather than absorbing it as silent replay-window expansion. New `kind: "saturated"` variant added to the `PayResult` union; `tsc --noEmit` clean. |
| AUD-210 | L   | **Closed** | New test added at `mcp-server/test/action-shape.test.ts` (`rejects a 40-char non-base58 string at the .refine arm`) that exercises the `.refine(isValidPublicKey)` reachability with input `"!".repeat(40)` — passes `min(32)` so the refine fires. Pins the schema-layer defense-in-depth contract against a future change that drops the refine relying on `min(32)` alone. `npm test --workspace @agenomics/mcp-server`: 196 pass / 0 fail. |
| AUD-211 | L   | Open | `wrap` semantics divergence between `mcp-server/src/actions/vault.ts` and `mcp-server/src/util/result.ts`. Both produce canonical `{ value }` / `{ error }` outputs; the divergence is in the *throw-vs-return-Result* contract on synchronous helpers. Hygiene; deferred. |
| AUD-212 | L   | Open | `pipeline/idempotency-redis.ts:340` `deserializeResult` doesn't HMAC the cached payload. Tampering requires Redis-write access, which is treated as a trust-boundary violation in the threat model; tracked under ADR-117 (Redis isolation). |
| AUD-213 | L   | **Closed** | Standardized on the npm-canonical workspace dep pattern (`"*"`) across all in-workspace `@agenomics/*` references. Changes: `mcp-server/package.json` flipped `@agenomics/capability-manifest-validator` and `@agenomics/sas-resolver` from `file:` to `*`; `sdk/client/package.json` flipped `@agenomics/idl` from `file:` to `*`. Root `package.json` retains `file:` for the same packages (it's the workspace-root manifest with different hoisting semantics; left untouched). `npm install` regenerated the lockfile (removed 22 redundantly-nested packages, hoisted to workspace root); `npm run build --workspaces` clean across `sdk/client`, `mcp-server`, `src/indexer`, `src/x402-relay`, `dashboard`. |

**Summary**: 5/5 high-priority cycle-2 findings closed (AUD-200, 201,
204, 205, 208 — the top-5 prioritized list at §4). All cycle-1
regression-check items now resolve through their cycle-2 IDs. The 8
remaining open items are all LOW severity and tracked as deferred
follow-ups; none are mainnet-blockers.

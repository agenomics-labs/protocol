# Cycle 3 — MCP Server / SDK / EVO Bridge Punchlist (2026-04-27)

Findings from the cycle-3 MCP + SDK + EVO bridge audit. The MCP server's
foundations (transport gate, capability-gating, pipeline orchestration,
Result unification) are solid post-cycle-2. ADR-129 EVO bridge ships with
correct kill-switch posture but missing production-grade resilience
primitives. MCP-320 (no rate limit at transport) is a Critical asymmetric
defense gap relative to the x402-relay layer.

## Source

- Audit: cycle-3 MCP + SDK + EVO bridge audit transcript (code-analyzer agent, 2026-04-27)
- Cycle-2 baseline: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md`, `appendix-offchain-typescript.md`

## Critical (production blockers — gated on transport / EVO enablement)

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| MCP-320 | No rate limiting at MCP transport layer. Authenticated caller (or leaked bearer token) can fire unbounded `vault_transfer` calls; only backpressure is wallet SOL balance. ADR-083 silent on rate limiting. x402-relay has rate-limit code; MCP server does not. | `mcp-server/src/index.ts:224-260, 271-332`; `mcp-server/src/transport/auth-gate.ts` | k2jac9 | **Closed — `47e859c`** [^mcp320] |

[^batchB]: Three small boundary fix-ups landed as one commit (Batch B). MCP-303: `createEvoClient` now hard-fails at boot when `AEP_EVO_ENABLED=true` and `AEP_EVO_DB` is unset OR not absolute (new `EvoBridgeMisconfigError` checks `db-path` and `db-path-relative`) — operators get a single diagnostic at boot rather than discovering corruption later. MCP-304: `find_similar_agents` handler wraps `memory.findSimilarAgents` in try/catch matching the registry/settlement symmetry; on bridge failure returns `{ skipped: true, reason: "evo-error" }` so a wedged subprocess never throws past the handler. MCP-306: `parseRetrievalResult` drops entries lacking a numeric score/similarity entirely instead of silently emitting `score: 0` — genuine zero-similarity hits are kept (verified by test). Tests: 8 new tests in `find-similar-agents.test.ts` covering all three closures (mcp-server suite 328/328).

[^batchA]: ADR-129 §"Resilience primitives" cycle-3 close (this commit). Closes MCP-300/301/302/305/307 in one batch. Transport split into `mcp-server/src/adapters/evo-bridge.ts` (public surface — types, factory, singleton, LiveEvoClient) and `mcp-server/src/adapters/evo-subprocess-transport.ts` (lifecycle + queue + restart + breaker + handshake + multi-line startup-error capture). New env knobs: `AEP_EVO_CALL_TIMEOUT_MS` (default 5000), `AEP_EVO_MAX_QUEUE_DEPTH` (64), `AEP_EVO_BREAKER_FAILURE_THRESHOLD` (3), `AEP_EVO_RESTART_COOLDOWN_MS` (1000), `AEP_EVO_RESTART_MAX` (10), `AEP_EVO_PROTOCOL_MAJOR` (1). State machine: `idle → starting → running → restarting → breaker_open` with exponential-backoff restart cooldown capped at 30s. Tests: `test/evo-bridge-resilience.test.ts` covers all five audit IDs (9 tests, full mcp-server suite 320/320).

[^mcp320]: New `mcp-server/src/transport/rate-limit.ts` (373 lines) — sha256-keyed bearer-token buckets with IP fallback, env-overridable window/max (`AEP_MCP_RATE_LIMIT_WINDOW_MS`, `AEP_MCP_RATE_LIMIT_MAX_REQUESTS`), `X-Forwarded-For` only honored when `AEP_MCP_TRUST_PROXY=1`. Pruner on `setInterval(...).unref()`, `MAX_RATE_LIMIT_ENTRIES = 100_000` cap, `Retry-After` header on 429. Wired BEFORE bearer-auth in `startHttpTransport` so token-guessing is also rate-limited. Stdio + unix transports intentionally skipped (parent-process / UID trust boundary). Factory pattern (vs. relay's module-level singleton) makes tests state-isolated. 24 new tests; mcp-server suite 311/311.

## High (block ship of EVO / HTTP transport)

| ID | Title | File:Lines | Owner | Status |
|---|---|---|---|---|
| MCP-300 | No timeout on EVO `transport.send()`. Wedged subprocess hangs awaiting promise forever; `find_similar_agents` does not wrap (`handlers/registry.ts:533`) so a hang there hangs the MCP response. | `mcp-server/src/adapters/evo-bridge.ts:320-343` | k2jac9 | **Closed — Batch A** [^batchA] |
| MCP-301 | No restart / circuit-breaker on EVO subprocess crash. After `process.on("close")` fires, every subsequent `send()` returns "subprocess is not running" — no auto-respawn, no breaker; once EVO crashes every dependent MCP tool errors for the rest of process lifetime. | `mcp-server/src/adapters/evo-bridge.ts:255-261, 320-329` | k2jac9 | **Closed — Batch A** [^batchA] |
| MCP-302 | Single in-flight serialized queue with no backpressure / max depth; concurrent callers all queue against one slot. 50 callers + 200ms retrieval = caller 50 waits 10s. Denial-of-self under modest concurrency. | `mcp-server/src/adapters/evo-bridge.ts:218-220, 320-343` | k2jac9 | **Closed — Batch A** [^batchA] |

## Medium (next-cycle)

| ID | Title | File:Lines | Status |
|---|---|---|---|
| MCP-303 | EVO auth model is "trust the local subprocess" — no credentials, only `--db <path>`. `AEP_EVO_DB` defaults to relative `.aep-evo/agent-memory.db` (cwd-dependent); two MCP server instances in the same cwd silently corrupt each other. | `mcp-server/src/adapters/evo-bridge.ts:178, 240-242` | **Closed — Batch B** [^batchB] |
| MCP-304 | Bridge IS optional and degrades gracefully (kill-switch default OFF). However, when `enabled=true` AND subprocess fails post-boot, `find_similar_agents` does NOT wrap the error per the ADR-129 "best effort" contract. The other handlers (`registry.ts:108-126`, `settlement.ts:71-89`) DO wrap — asymmetric. | `mcp-server/src/handlers/registry.ts:533` | **Closed — Batch B** [^batchB] |
| MCP-305 | No version handshake between MCP and EVO. Adapter sends `cmd: "observe_text" / "retrieve_text" / "learn" / "consolidate"` against whatever EVO binary is on `PATH`. A v2 wire protocol rename returns silent `ok=false` with no version-mismatch hint. | `mcp-server/src/adapters/evo-bridge.ts:407-465` | **Closed — Batch A** [^batchA] |
| MCP-310 | In-memory idempotency TTL armed at start time, not at settle time — long-running handler whose `fn()` exceeds `ttlMs` may evict mid-execution, allowing concurrent caller to spawn a second invocation. Acknowledged in comment but not bounded. | `mcp-server/src/pipeline/idempotency.ts:108-125` | Open |
| MCP-311 | `state-gates.ts` duplicates on-chain enforcement (defense-in-depth, NOT replacement). Byte offsets in `vault-layout.ts:60-82` mirror Rust struct; no automated drift guard. A field reorder on-chain silently makes the gate read garbage and pass spends the chain rejects (DoS-honest, not security). | `mcp-server/src/pipeline/vault-layout.ts:60-82`, `mcp-server/src/pipeline/state-gates.ts:340-433` | Open |
| MCP-312 | `preflight.ts` does NOT simulate the tx — runs five domain gates (cluster_health, account_rent_exempt, daily_cap, token_daily_cap, dispute_window) via direct `getAccountInfo` reads. The actual `simulateTransaction` lives in `compute-budget.ts`, invoked only by `handlers-v2/vault.ts:265-267`. No "preflight pass implies chain accept" contract; no test asserting that invariant. | `mcp-server/src/pipeline/preflight.ts:81-218` | Open |
| MCP-313 | `vault-layout.ts` byte offsets are hand-rolled, NOT derived from `sdk/idl/`. Same drift class as cycle-1 AUD-003 (SDK PDA seeds), different layer. | `mcp-server/src/pipeline/vault-layout.ts:60-82` | Open |
| MCP-321 | No origin / CSRF checks on HTTP transport. `StreamableHTTPServerTransport` wrapped only in bearer-token middleware. If operator exposes dev MCP behind a reverse proxy that adds the header itself, browser callers can hit it from any origin. | `mcp-server/src/index.ts:224-260` | Open |
| MCP-322 | Stdio transport is unauthenticated by design ("trust boundary = parent process") — correct posture, but in containerized deployments parent is `tini`/`dumb-init`, not a single trusted user; any process that can `exec` into the container inherits trust. Document the threat model or flip default to `unix` with UID check. | `mcp-server/src/transport/auth-gate.ts:105-107, 376-377` | Open |

## Low (paper-cut)

| ID | Title | File:Lines | Status |
|---|---|---|---|
| MCP-306 | `parseRetrievalResult` accepts `score: 0` as silent fallback when neither `score` nor `similarity` present — hits with no score sort indistinguishably from genuine zero-similarity hits. | `mcp-server/src/adapters/evo-bridge.ts:487-525` | **Closed — Batch B** [^batchB] |
| MCP-307 | `extractErrorMessage` only captures the FIRST unsolicited line into `startupError`; multi-line startup banners silently overwrite earlier context. | `mcp-server/src/adapters/evo-bridge.ts:271-278, 371-386` | **Closed — Batch A** [^batchA] |
| MCP-314 | 5s vault-state cache TTL shared across all callers; spend completed on-chain between t=0 and t=4s leaves cache showing pre-spend `spent_today_lamports`. No invalidation hook on successful confirm. | `mcp-server/src/pipeline/vault-layout.ts:84, 250-279` | Open |
| MCP-315 | `idempotency-redis.ts` deadline check uses local `this.now()` — clock skew across MCP instances writing to same Redis can time out 2s early on one side. | `mcp-server/src/pipeline/idempotency-redis.ts:300-328` | Open |
| MCP-323 | 5 `(program.account as any)` casts persist in SDK — `vault.ts:177`, `registry.ts:177,193`, `settlement.ts:126,143`. ADR-088 said "remove from sdk/client/*"; cycle-1 AUD-025 still open. | `sdk/client/src/{vault,registry,settlement}.ts` | Open |
| MCP-324 | 5 `as unknown as` casts in `handlers-v2/vault.ts:236-264, 372-376` documented with TODO(typed) comments referencing Kit limitation. Not regressed, not closed. | `mcp-server/src/handlers-v2/vault.ts:236-264, 372-376` | Open |

## Closed

| ID | Title | Evidence |
|---|---|---|
| MCP-325 | Result-shape drift CLOSED. `mcp-server/src/util/result.ts:29-30`, `packages/sas-resolver/src/util/result.ts:23-24`, `mcp-server/src/types/action.ts:97` re-export canonical `{ value }` shape from `@agenomics/action-runtime`. AUD-211 closure documented inline; no three-shape drift remains. | `@agenomics/action-runtime` |

## Handlers v1/v2 status

Migration paused at ~4% (1/27 actions in v2). `handlers-v2/` contains only `vault.ts` (`execute_transfer` Kit-native path) + `keypair-signer.ts`. Routing opt-in via `AEP_USE_V2_VAULT_TRANSFER=1`; v1 default. Same TODOs cycle-1 flagged. **Decision needed**: (a) defer indefinitely + delete dual-path branching at `actions/vault.ts:175-178`, OR (b) commit a wave to migrate `vault_token_transfer` + `create_vault` to v2.

## Ship gates

- **HTTP transport unblock**: MCP-320 ✅ closed `47e859c`; MCP-321 documented or fixed
- **EVO enablement (`AEP_EVO_ENABLED=true` in production)**: MCP-300, MCP-301, MCP-302, MCP-304 closed; MCP-305 version handshake shipped
- **Pipeline drift hardening**: MCP-311 + MCP-313 + ADR-119 promoted from Proposed → Accepted + CI-blocking

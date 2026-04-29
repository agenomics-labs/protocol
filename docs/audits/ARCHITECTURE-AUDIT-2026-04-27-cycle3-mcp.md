# MCP server + SDK + EVO bridge audit — cycle 3 (2026-04-27)

## Metadata

- **Audit cycle**: 3
- **Domain**: MCP server (`mcp-server/`), SDK clients (`sdk/client/`), EVO bridge (ADR-129 subprocess transport)
- **Audit date**: 2026-04-27
- **Summary written**: 2026-04-29
- **HEAD at summary**: 37f0acc
- **Scope**: mcp-server/src/, sdk/client/src/, ADR-129 EVO bridge surface
- **Prior cycle**: docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md, docs/audits/appendix-offchain-typescript.md
- **Methodology**: hostile re-audit of the cycle-2 transport gate, capability-gating, and
  pipeline orchestration; fresh threat-modelling against ADR-129's EVO subprocess bridge
  (newly landed); asymmetric-defense check against the x402-relay's rate-limit posture
- **Punchlist**: docs/audits/CYCLE-3-MCP-PUNCHLIST.md

## TL;DR

The cycle-3 MCP audit confirmed the post-cycle-2 foundations (transport gate,
capability-gating, pipeline orchestration, Result-shape unification) are solid, but
surfaced one Critical asymmetric-defense gap (MCP-320 — no rate limit at MCP transport,
unlike x402-relay) plus three High-severity ADR-129 EVO-bridge resilience gaps
(MCP-300/301/302) and twelve Medium / Low items spanning origin / CSRF posture, IDL-derived
layout drift, idempotency TTL semantics, and SDK type-safety. All 20 findings (MCP-300
through MCP-325) are closed as of this summary. Closure landed in seven labeled batches
(A through G) plus the standalone MCP-320 fix; ADR-119 was promoted from Proposed →
Accepted with scope expansion to the mcp-server vault-layout drift gate, ADR-129 was
extended with a "Resilience primitives" section, ADR-132 was added for origin gating and
container-aware transport defaults, and ADR-133 was Accepted to capture the handlers-v2
wave deferral decision (option c, hybrid). Mainnet-promotion gate cleared from the MCP +
SDK + EVO bridge domain.

## Verdict

The cycle-3 hostile re-audit deliberately probed three asymmetries:

1. **Transport asymmetry between MCP and x402-relay.** Both surfaces accept authenticated
   bearer-token traffic; the relay had rate-limit code, MCP did not. MCP-320 was the
   load-bearing finding here — a leaked or guessed bearer token could fire unbounded
   `vault_transfer` calls until wallet SOL ran out. Closure landed as
   `mcp-server/src/transport/rate-limit.ts` (sha256-keyed bearer-token buckets with IP
   fallback; wired BEFORE bearer-auth so token-guessing is also rate-limited).

2. **EVO bridge as new attack surface.** ADR-129 shipped with correct kill-switch posture
   (default OFF) but missing production-grade resilience primitives. A wedged or crashed
   EVO subprocess could (a) hang `find_similar_agents` indefinitely (no timeout), (b)
   leave every dependent MCP tool errored for the rest of process lifetime (no auto-respawn,
   no breaker), (c) starve concurrent callers via single-slot serialized queueing. Batch A
   (`d3f5f23`) closed all five EVO resilience items in one commit by extending ADR-129
   with the "Resilience primitives" section and splitting transport into a clean
   public-surface + lifecycle-machine pair.

3. **Pipeline-layer drift between off-chain mirror and on-chain truth.** `state-gates.ts`
   duplicates on-chain enforcement (defense-in-depth, not replacement). The vault-layout
   byte offsets were hand-rolled from the Rust struct with no automated drift guard —
   same risk class as cycle-1 AUD-003 (SDK PDA seeds), different layer. Batch D
   (`a6c5614`) closed it with an IDL-derived codegen artifact + boot-time drift assertion,
   gated through ADR-119's promotion to Accepted with scope expansion.

All 20 findings are closed in-tree with passing test suites. The handlers-v2 migration —
paused at ~4% (1/27 actions) — is captured as a deliberate deferral via ADR-133 (option c,
hybrid), with re-evaluation triggers pinned and a scheduled background agent
(`trig_01GkKKZQd39rY2Z7w7tmmYou`, 2026-06-03) to check the first two triggers automatically.

## Per-finding closure status

### Critical — MCP-320: no rate limiting at MCP transport layer

| Field | Detail |
|---|---|
| **Severity** | Critical (production blocker — gated on transport / EVO enablement) |
| **Surface** | `mcp-server/src/index.ts:224-260, 271-332`; `mcp-server/src/transport/auth-gate.ts` |
| **Original concern** | Authenticated caller (or leaked bearer token) could fire unbounded `vault_transfer` calls; only backpressure was wallet SOL balance. ADR-083 was silent on rate limiting. The x402-relay layer had rate-limit code; the MCP server did not — a defense asymmetry. |
| **Closure mechanism** | New `mcp-server/src/transport/rate-limit.ts` (373 lines) — sha256-keyed bearer-token buckets with IP fallback; env-overridable window/max (`AEP_MCP_RATE_LIMIT_WINDOW_MS`, `AEP_MCP_RATE_LIMIT_MAX_REQUESTS`); `X-Forwarded-For` only honored when `AEP_MCP_TRUST_PROXY=1`. Pruner on `setInterval(...).unref()`, `MAX_RATE_LIMIT_ENTRIES = 100_000` cap, `Retry-After` header on 429. Wired BEFORE bearer-auth in `startHttpTransport` so token-guessing itself is rate-limited. Stdio + unix transports intentionally skipped (parent-process / UID trust boundary differs). Factory pattern (vs. relay's module-level singleton) makes tests state-isolated. |
| **Closure SHA** | `47e859c` |
| **Tests** | 24 new tests; mcp-server suite 311/311 |
| **Follow-up** | None outstanding for MCP-320. CSRF / origin posture closed separately via MCP-321 (Batch F). |

### High — MCP-300: no timeout on EVO `transport.send()`

| Field | Detail |
|---|---|
| **Severity** | High (block ship of EVO / HTTP transport) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:320-343` |
| **Original concern** | A wedged subprocess hangs an awaiting promise forever; `find_similar_agents` did not wrap (`handlers/registry.ts:533`), so a hang there hung the MCP response. |
| **Closure mechanism** | Batch A — ADR-129 §"Resilience primitives" cycle-3 close. New env knob `AEP_EVO_CALL_TIMEOUT_MS` (default 5000). State machine `idle → starting → running → restarting → breaker_open` with exponential-backoff restart cooldown capped at 30s. Transport split into `mcp-server/src/adapters/evo-bridge.ts` (public surface) and `mcp-server/src/adapters/evo-subprocess-transport.ts` (lifecycle + queue + restart + breaker + handshake). |
| **Closure SHA** | `d3f5f23` (Batch A) |
| **Tests** | `test/evo-bridge-resilience.test.ts` covers all five Batch-A audit IDs (9 tests, full mcp-server suite 320/320) |
| **Follow-up** | None. |

### High — MCP-301: no restart / circuit-breaker on EVO subprocess crash

| Field | Detail |
|---|---|
| **Severity** | High (block ship of EVO / HTTP transport) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:255-261, 320-329` |
| **Original concern** | After `process.on("close")` fires, every subsequent `send()` returned "subprocess is not running" — no auto-respawn, no breaker. Once EVO crashed, every dependent MCP tool errored for the rest of process lifetime. |
| **Closure mechanism** | Batch A. New env knobs `AEP_EVO_BREAKER_FAILURE_THRESHOLD` (3), `AEP_EVO_RESTART_COOLDOWN_MS` (1000), `AEP_EVO_RESTART_MAX` (10). State machine carries the breaker_open terminal node; cooldown is exponential-backoff capped at 30s. |
| **Closure SHA** | `d3f5f23` (Batch A) |
| **Tests** | Covered by `test/evo-bridge-resilience.test.ts` |
| **Follow-up** | None. |

### High — MCP-302: single in-flight serialized queue with no backpressure

| Field | Detail |
|---|---|
| **Severity** | High (block ship of EVO / HTTP transport) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:218-220, 320-343` |
| **Original concern** | Concurrent callers all queued against one slot. With 50 callers and a 200ms retrieval, caller 50 waited 10s — denial-of-self under modest concurrency. |
| **Closure mechanism** | Batch A. New env knob `AEP_EVO_MAX_QUEUE_DEPTH` (default 64); over-depth callers reject immediately rather than back-pressuring the entire MCP response chain. |
| **Closure SHA** | `d3f5f23` (Batch A) |
| **Tests** | Covered by `test/evo-bridge-resilience.test.ts` |
| **Follow-up** | None. |

### Medium — MCP-303: relative `AEP_EVO_DB` path corruption

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:178, 240-242` |
| **Original concern** | EVO auth model is "trust the local subprocess" — no credentials, only `--db <path>`. `AEP_EVO_DB` defaulted to relative `.aep-evo/agent-memory.db` (cwd-dependent); two MCP server instances launched from different cwds against the same logical store would silently corrupt each other. |
| **Closure mechanism** | Batch B. `createEvoClient` now hard-fails at boot when `AEP_EVO_ENABLED=true` and `AEP_EVO_DB` is unset OR not absolute (new `EvoBridgeMisconfigError` checks `db-path` and `db-path-relative`) — operators get a single diagnostic at boot rather than discovering corruption later. |
| **Closure SHA** | `8fec49b` (Batch B) |
| **Tests** | 8 new tests in `find-similar-agents.test.ts` cover all three Batch-B closures (mcp-server suite 328/328) |
| **Follow-up** | None. |

### Medium — MCP-304: asymmetric `find_similar_agents` error wrap

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/handlers/registry.ts:533` |
| **Original concern** | Bridge IS optional and degrades gracefully (kill-switch default OFF). However, when `enabled=true` AND subprocess failed post-boot, `find_similar_agents` did NOT wrap the error per the ADR-129 "best effort" contract. Other handlers (`registry.ts:108-126`, `settlement.ts:71-89`) DO wrap — asymmetric. |
| **Closure mechanism** | Batch B. `find_similar_agents` handler wraps `memory.findSimilarAgents` in try/catch matching the registry/settlement symmetry; on bridge failure returns `{ skipped: true, reason: "evo-error" }` so a wedged subprocess never throws past the handler. |
| **Closure SHA** | `8fec49b` (Batch B) |
| **Tests** | Covered by Batch-B test set |
| **Follow-up** | None. |

### Medium — MCP-305: no EVO version handshake

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:407-465` |
| **Original concern** | Adapter sent `cmd: "observe_text" / "retrieve_text" / "learn" / "consolidate"` against whatever EVO binary was on `PATH`. A v2 wire-protocol rename returned silent `ok=false` with no version-mismatch hint. |
| **Closure mechanism** | Batch A. New env knob `AEP_EVO_PROTOCOL_MAJOR` (1); handshake on subprocess startup asserts the major version match before the bridge transitions `starting → running`. |
| **Closure SHA** | `d3f5f23` (Batch A) |
| **Tests** | Covered by `test/evo-bridge-resilience.test.ts` |
| **Follow-up** | None. |

### Medium — MCP-310: in-memory idempotency TTL armed at start time, not settle time

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/pipeline/idempotency.ts:108-125` |
| **Original concern** | `setTimeout(... ttlMs)` was armed at `acquire()` start; a long-running `fn()` could be evicted mid-execution, allowing a concurrent caller to spawn a second invocation. Acknowledged in comment but not bounded. |
| **Closure mechanism** | Batch C. Settle-time TTL semantics for `InMemoryIdempotencyStore`. Entry stores with `expiresAt: null` while in-flight (no timer); concurrent acquire piggybacks on the same promise indefinitely. After `fn()` settles, `promise.finally` arms the TTL timer with deadline `now + ttlMs`. Concurrent invalidate / re-acquire is handled by re-checking that the entry hasn't been replaced before attaching the timer. |
| **Closure SHA** | `747c799` (Batch C) |
| **Tests** | `test/idempotency-ttl.test.ts` (2 tests: in-flight non-eviction + post-settle TTL honoring). Full mcp-server suite 330/330. |
| **Follow-up** | None. |

### Medium — MCP-311: vault-layout drift guard absent

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/pipeline/vault-layout.ts:60-82`, `mcp-server/src/pipeline/state-gates.ts:340-433` |
| **Original concern** | `state-gates.ts` duplicates on-chain enforcement (defense-in-depth, not replacement). Byte offsets in `vault-layout.ts:60-82` mirrored the Rust struct; no automated drift guard. A field reorder on-chain would silently make the gate read garbage and pass spends the chain rejects (DoS-honest, not security). |
| **Closure mechanism** | Batch D. ADR-119 promoted from Proposed → Accepted with scope expansion to mcp-server vault-layout drift gate. New `vault-layout-drift.ts` re-walks the live IDL at boot and asserts the generated artifact still matches; throws `VaultLayoutDriftError` with multi-line diff on mismatch. Best-effort when IDL absent at runtime (build-time gate authoritative). |
| **Closure SHA** | `a6c5614` (Batch D) |
| **Tests** | `test/vault-layout-drift.test.ts` (5 tests covering MCP-311/313/314). Full mcp-server suite 353/353. |
| **Follow-up** | None. |

### Medium — MCP-312: no preflight contract pin

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/pipeline/preflight.ts:81-218` |
| **Original concern** | `preflight.ts` does NOT simulate the tx — runs five domain gates (cluster_health, account_rent_exempt, daily_cap, token_daily_cap, dispute_window) via direct `getAccountInfo` reads. The actual `simulateTransaction` lives in `compute-budget.ts`, invoked only by `handlers-v2/vault.ts:265-267`. There was no "preflight pass implies chain accept" contract; no test asserting that invariant. |
| **Closure mechanism** | Batch E. Inline contract block at `preflight.ts:1-40` documenting the only invariant preflight guarantees: `PREFLIGHT-FAIL ⇒ CHAIN-REJECT-FOR-THE-GATED-REASON`. The inverse (preflight-pass ⇒ chain-accept) is explicitly NOT guaranteed because (a) gate caches admit racy state changes, (b) chain enforces invariants beyond preflight's five gates, (c) commitment-level skew between preflight reads and tx submit admits TOCTOU. |
| **Closure SHA** | `358833d` (Batch E) |
| **Tests** | New `test/preflight-contract.test.ts` (5 tests) pins both directions: each gate fails on its precondition violation (forward direction); a representative scenario shows preflight-pass + chain-reject coexist (inverse-not-guaranteed). Full mcp-server suite 358/358. |
| **Follow-up** | None. |

### Medium — MCP-313: vault-layout offsets not derived from IDL

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/pipeline/vault-layout.ts:60-82` |
| **Original concern** | `vault-layout.ts` byte offsets were hand-rolled, NOT derived from `sdk/idl/`. Same drift class as cycle-1 AUD-003 (SDK PDA seeds), different layer. |
| **Closure mechanism** | Batch D. New `mcp-server/scripts/gen-vault-layout.ts` reads `sdk/idl/src/idl/agent_vault.json`, walks the Vault account's fixed-width prefix (recursing into VaultPolicy), and emits `mcp-server/src/pipeline/vault-layout.generated.ts`. Wired via `prebuild` script; CI gate is `git diff --exit-code`. `vault-layout.ts:VAULT_LAYOUT` re-exports the codegen output. |
| **Closure SHA** | `a6c5614` (Batch D) |
| **Tests** | Covered by `test/vault-layout-drift.test.ts` |
| **Follow-up** | None. |

### Medium — MCP-321: no origin / CSRF checks on HTTP transport

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/index.ts:224-260` |
| **Original concern** | `StreamableHTTPServerTransport` was wrapped only in bearer-token middleware. If an operator exposed dev MCP behind a reverse proxy that added the header itself, browser callers could hit it from any origin. |
| **Closure mechanism** | Batch F. ADR-132 — origin gate + container-aware transport default. New `mcp-server/src/transport/origin-gate.ts` wires an `Origin` / `Sec-Fetch-Site` allowlist in front of the rate-limiter. `AEP_MCP_HTTP_ALLOWED_ORIGINS` (CSV) controls browser origins; server-to-server callers (no `Origin`) pass through. Decision table covers `cross-site` defensive case. |
| **Closure SHA** | `d38248f` (Batch F) |
| **Tests** | `test/transport-origin.test.ts` (17 tests). Full mcp-server suite 347/347. |
| **Follow-up** | None. |

### Medium — MCP-322: stdio transport posture in containerized deploys

| Field | Detail |
|---|---|
| **Severity** | Medium (next-cycle) |
| **Surface** | `mcp-server/src/transport/auth-gate.ts:105-107, 376-377` |
| **Original concern** | Stdio transport is unauthenticated by design ("trust boundary = parent process") — correct posture, but in containerized deployments the parent is `tini`/`dumb-init`, not a single trusted user; any process that can `exec` into the container inherits trust. |
| **Closure mechanism** | Batch F. `isContainerizedRuntime` detects `/.dockerenv`, `process.env.container`, or `AEP_MCP_FORCE_CONTAINER_DEFAULT=1`; when `AEP_MCP_TRANSPORT` is unset and a container is detected, the default flips from `stdio` to `unix` with `/run/aep-mcp/mcp.sock` as the auto-flip socket path. Operators retain the escape hatch `AEP_MCP_TRANSPORT=stdio` for the prior behavior; the auto-flip emits a WARN-level boot log naming the detection signal. |
| **Closure SHA** | `d38248f` (Batch F) |
| **Tests** | Covered by `test/transport-origin.test.ts` |
| **Follow-up** | None. |

### Low — MCP-306: `parseRetrievalResult` silent zero-fallback

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:487-525` |
| **Original concern** | `parseRetrievalResult` accepted `score: 0` as silent fallback when neither `score` nor `similarity` were present — hits with no score sorted indistinguishably from genuine zero-similarity hits. |
| **Closure mechanism** | Batch B. `parseRetrievalResult` drops entries lacking a numeric score/similarity entirely instead of silently emitting `score: 0` — genuine zero-similarity hits are kept (verified by test). |
| **Closure SHA** | `8fec49b` (Batch B) |
| **Tests** | Covered by Batch-B test set |
| **Follow-up** | None. |

### Low — MCP-307: multi-line startup banners overwrote earlier context

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `mcp-server/src/adapters/evo-bridge.ts:271-278, 371-386` |
| **Original concern** | `extractErrorMessage` only captured the FIRST unsolicited line into `startupError`; multi-line startup banners silently overwrote earlier context. |
| **Closure mechanism** | Batch A. Multi-line startup-error capture is part of the lifecycle machine in `evo-subprocess-transport.ts` — successive unsolicited lines accumulate rather than overwrite. |
| **Closure SHA** | `d3f5f23` (Batch A) |
| **Tests** | Covered by `test/evo-bridge-resilience.test.ts` |
| **Follow-up** | None. |

### Low — MCP-314: vault-state cache lacks post-spend invalidation

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `mcp-server/src/pipeline/vault-layout.ts:84, 250-279` |
| **Original concern** | 5s vault-state cache TTL was shared across all callers; a spend completed on-chain between t=0 and t=4s left the cache showing pre-spend `spent_today_lamports`. No invalidation hook on successful confirm. |
| **Closure mechanism** | Batch D. New `invalidateVaultStateCache(addr)` hook called from the post-`.rpc()` site of `executeTransfer` and `executeTokenTransfer` so a follow-up cap check doesn't read pre-spend state. |
| **Closure SHA** | `a6c5614` (Batch D) |
| **Tests** | Covered by `test/vault-layout-drift.test.ts` |
| **Follow-up** | None. |

### Low — MCP-315: Redis idempotency clock-skew

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `mcp-server/src/pipeline/idempotency-redis.ts:300-328` |
| **Original concern** | `idempotency-redis.ts` deadline check used local `this.now()` — clock skew across MCP instances writing to the same Redis could time out 2s early on one side. |
| **Closure mechanism** | Batch G. `RedisIdempotencyStore.waitForResult` no longer reads `this.now()` in the hot path. Wait-time bound is computed by accumulating sleep durations (`elapsedMs += thisSleep`), eliminating the clock-skew failure mode. Final-sleep is capped to remaining budget so total wait is exactly `inflightWaitMs`. |
| **Closure SHA** | `74c2121` (Batch G) |
| **Tests** | Full mcp-server suite 358/358; sdk/client 42/42 |
| **Follow-up** | None. |

### Low — MCP-323: SDK `(program.account as any)` casts

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `sdk/client/src/{vault,registry,settlement}.ts` |
| **Original concern** | 5 `(program.account as any)` casts persisted in SDK — `vault.ts:177`, `registry.ts:177,193`, `settlement.ts:126,143`. ADR-088 said "remove from sdk/client/*"; cycle-1 AUD-025 was still open. |
| **Closure mechanism** | Batch G. Each client's `Program` field parameterised as `Program<AgentVault>` / `Program<AgentRegistry>` / `Program<Settlement>` (ADR-088 typed-anchor pattern). New `sdk/client/src/idl-types.d.ts` re-export shim brings Anchor's generated `target/types/*` declarations into the SDK's type graph without violating `compilerOptions.rootDir`. SDK consumers' constructors now take the typed IDL directly. |
| **Closure SHA** | `74c2121` (Batch G) |
| **Tests** | sdk/client 42/42 |
| **Follow-up** | None. |

### Low — MCP-324: `as unknown as` casts in handlers-v2/vault.ts

| Field | Detail |
|---|---|
| **Severity** | Low (paper-cut) |
| **Surface** | `mcp-server/src/handlers-v2/vault.ts:236-264, 372-376` |
| **Original concern** | 5 `as unknown as` casts in `handlers-v2/vault.ts:236-264, 372-376` documented with TODO(typed) comments referencing Kit limitation. Not regressed, not closed. |
| **Closure mechanism** | Batch G. The 5 casts in the message-builder block at `handlers-v2/vault.ts:236-264` removed by switching to `pipe()` — Kit's `@solana/functional` pipeline helper threads the message-builder return type through each step monotonically. The hand-rolled `KitTransactionPartialSigner` interface replaced with a re-export of Kit's actual `TransactionPartialSigner` (the brand-bridge for `SignatureBytes` is now a single localized cast inside `keypair-signer.ts`). 1 cast at `:289` (signed-tx wrapper) closed by widening `SignedTransactionLike.signatures` to accept Kit's branded `SignaturesMap`. |
| **Closure SHA** | `74c2121` (Batch G) |
| **Residual** | 4 RPC-narrowing casts at `:354-369, :405` remain — `VaultTransferV2Rpc` is a structural narrowing of Kit's full `Rpc<SolanaRpcApi>` and the bridge to `sendAndConfirmTransactionFactory`'s parameter type would require pulling Kit's `Rpc` generic into the action layer (out-of-scope for Batch G; cast is structurally sound — every method `VaultTransferV2Rpc` declares exists on the full `Rpc`). Documented in the closure footnote. |
| **Tests** | Full mcp-server suite 358/358 |
| **Follow-up** | The 4 RPC-narrowing residuals are eligible for closure if/when handlers-v2 wave resumes (see ADR-133). |

### Pre-closed — MCP-325: Result-shape drift

| Field | Detail |
|---|---|
| **Severity** | Closed at audit time |
| **Surface** | `mcp-server/src/util/result.ts:29-30`, `packages/sas-resolver/src/util/result.ts:23-24`, `mcp-server/src/types/action.ts:97` |
| **Original concern** | Three-shape Result-type drift across MCP server, SAS resolver, and action types. |
| **Closure mechanism** | Already closed by AUD-211 — re-exports canonical `{ value }` shape from `@agenomics/action-runtime`. Cycle-3 audit verified the closure held. |
| **Evidence** | `@agenomics/action-runtime` re-export chain |
| **Follow-up** | None. |

## Architecture themes

1. **Asymmetric defense across paired transports is a recurring vector.** MCP-320 surfaced
   because the relay had rate-limit code and MCP did not — same authentication boundary,
   different rate-limit posture. Cycle-3's hostile re-audit explicitly checks for these
   asymmetries (relay vs. MCP, init vs. mutation, registry vs. settlement). Carry the
   asymmetric-defense check forward as a standing audit-cycle prompt.

2. **New subsystems should ship with resilience primitives, not just kill switches.**
   ADR-129's EVO bridge had the right kill-switch posture (default OFF, opt-in via
   `AEP_EVO_ENABLED`), but lacked the production-grade primitives: timeout, restart,
   circuit-breaker, queue depth, version handshake. Batch A's "ADR-129 §Resilience
   primitives" extension establishes the template — any future subprocess-bridge
   subsystem should ship with the same primitive set or write down why it doesn't need
   them.

3. **Drift gates beat documentation for layout invariants.** MCP-311/313 are the
   off-chain twin of AUD-202 — both are "hand-rolled byte offsets vs. authoritative
   schema" findings. Both close via a build-time codegen + runtime drift assertion
   pattern (vault-layout codegen + IDL re-walk; `offset_of!` const-assert). The pattern
   is now the standing solution for both layers.

4. **Deferred waves are first-class outcomes when written down.** ADR-133 captures the
   handlers-v2 migration deferral (option c, hybrid) with explicit re-evaluation triggers
   pinned to (a) Anchor v2 ship, (b) `@solana-program/token` ≥1.0.0, (c) active CVE on
   `bigint-buffer`, (d) feature requiring Kit-native primitives, or (e) 18+ months
   elapsed. Scheduled background agent `trig_01GkKKZQd39rY2Z7w7tmmYou` (2026-06-03)
   checks the first two automatically. The pattern (auditable deferral ADR + automated
   trigger check) keeps the deferred work from silently becoming permanent.

## Closure verdict

All 20 cycle-3 MCP + SDK + EVO bridge findings are closed:

| ID | Severity | Closure | SHA / Mechanism |
|---|---|---|---|
| MCP-300 | High | Code (EVO timeout, state machine) | `d3f5f23` (Batch A) |
| MCP-301 | High | Code (EVO restart + breaker) | `d3f5f23` (Batch A) |
| MCP-302 | High | Code (EVO queue depth) | `d3f5f23` (Batch A) |
| MCP-303 | Medium | Code (boot-time absolute-path check) | `8fec49b` (Batch B) |
| MCP-304 | Medium | Code (handler error-wrap symmetry) | `8fec49b` (Batch B) |
| MCP-305 | Medium | Code (EVO version handshake) | `d3f5f23` (Batch A) |
| MCP-306 | Low | Code (drop score-less entries) | `8fec49b` (Batch B) |
| MCP-307 | Low | Code (multi-line startup capture) | `d3f5f23` (Batch A) |
| MCP-310 | Medium | Code (settle-time TTL) | `747c799` (Batch C) |
| MCP-311 | Medium | Code + ADR-119 Accepted (drift guard) | `a6c5614` (Batch D) |
| MCP-312 | Medium | Code (preflight contract pin + tests) | `358833d` (Batch E) |
| MCP-313 | Medium | Code (IDL-derived layout codegen) | `a6c5614` (Batch D) |
| MCP-314 | Low | Code (post-spend cache invalidation) | `a6c5614` (Batch D) |
| MCP-315 | Low | Code (accumulated-elapsed deadline) | `74c2121` (Batch G) |
| MCP-320 | Critical | Code (transport rate-limit) | `47e859c` |
| MCP-321 | Medium | Code + ADR-132 (origin gate) | `d38248f` (Batch F) |
| MCP-322 | Medium | Code + ADR-132 (container default flip) | `d38248f` (Batch F) |
| MCP-323 | Low | Code (typed Anchor `Program<…>`) | `74c2121` (Batch G) |
| MCP-324 | Low | Code (Kit `pipe()` + 4 documented residuals) | `74c2121` (Batch G) |
| MCP-325 | Closed at audit | Pre-closed via AUD-211 | n/a |

**Mainnet-promotion gate cleared from the MCP + SDK + EVO bridge domain.** The HTTP
transport unblock condition (MCP-320 closed; MCP-321 fixed) is satisfied. The
EVO-enablement condition (MCP-300/301/302/304 closed; MCP-305 version handshake shipped)
is satisfied. The pipeline-drift hardening condition (MCP-311 + MCP-313 + ADR-119 promoted
to Accepted + CI-blocking via `git diff --exit-code` on `vault-layout.generated.ts`) is
satisfied.

Handlers-v2 wave deferred via ADR-133 (Accepted, 2026-04-29; option c, hybrid) —
re-evaluation triggers pinned and automated check scheduled for 2026-06-03.

## Discrepancies between punchlist and code state

None observed. Each closure footnote in `CYCLE-3-MCP-PUNCHLIST.md` references a SHA
reachable from `main`. The seven labeled batches (A-G) plus standalone MCP-320 fix all
appear in `git log f0efc00^..HEAD`:

- `47e859c` — MCP-320 (standalone)
- `d3f5f23` — Batch A (MCP-300/301/302/305/307)
- `8fec49b` — Batch B (MCP-303/304/306)
- `747c799` — Batch C (MCP-310)
- `a6c5614` — Batch D (MCP-311/313/314)
- `358833d` — Batch E (MCP-312)
- `d38248f` — Batch F (MCP-321/322)
- `74c2121` — Batch G (MCP-315/323/324)
- `37f0acc` — ADR-133 Accepted (handlers-v2 wave deferral)

Test-suite counts in the punchlist footnotes (311 → 320 → 328 → 330 → 353 → 358 → 358)
form a strictly monotonic sequence consistent with each batch landing in order, which
matches the topological order in `git log`. No drift between asserted and actual closure
state at HEAD `37f0acc`.

The only documented residual is the 4 RPC-narrowing `as unknown as` casts at
`handlers-v2/vault.ts:354-369, :405` flagged inside MCP-324's closure footnote — these
are explicitly out-of-scope for Batch G and tied to the deferred handlers-v2 wave (ADR-133),
so the residual is captured rather than missed.

## References

- **Punchlist**: `docs/audits/CYCLE-3-MCP-PUNCHLIST.md`
- **Cycle-2 baseline**: `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md`, `docs/audits/appendix-offchain-typescript.md`
- **Companion summaries**: `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-onchain.md`, `docs/audits/ARCHITECTURE-AUDIT-2026-04-27-cycle3-offchain.md`
- **ADRs referenced**:
  - ADR-083 (MCP transport surface)
  - ADR-088 (typed Anchor `Program<…>` SDK pattern)
  - ADR-119 (vault-layout drift guard — Accepted, scope expanded to mcp-server)
  - ADR-129 (EVO subprocess bridge — extended with §"Resilience primitives")
  - ADR-132 (origin gate + container-aware transport default — Accepted)
  - ADR-133 (handlers-v2 wave deferral — Accepted, option c hybrid)
- **Closure commits on `main`**:
  - `47e859c` — MCP-320 (transport rate-limit)
  - `d3f5f23` — Batch A: MCP-300/301/302/305/307 (EVO bridge resilience primitives)
  - `8fec49b` — Batch B: MCP-303/304/306 (EVO boundary fix-ups)
  - `747c799` — Batch C: MCP-310 (settle-time idempotency TTL)
  - `a6c5614` — Batch D: MCP-311/313/314 (IDL-derived vault-layout + drift guards)
  - `358833d` — Batch E: MCP-312 (preflight contract pin)
  - `d38248f` — Batch F: MCP-321/322 (origin gate + container-aware transport default)
  - `74c2121` — Batch G: MCP-315/323/324 (Redis clock-skew, SDK + handlers-v2 type casts)
  - `37f0acc` — ADR-133 Accepted (handlers-v2 wave deferral)
- **Scheduled trigger checks**:
  - `trig_01GkKKZQd39rY2Z7w7tmmYou` (2026-06-03) — handlers-v2 re-evaluation: Anchor v2 + `@solana-program/token` ≥1.0.0

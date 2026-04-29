# Cycle 4 — MCP / SDK / EVO Bridge Punchlist (2026-04-29)

Hostile re-audit of the post-cycle-3 MCP corpus
(`mcp-server/src/**`, `sdk/client/src/**`) against HEAD `cd233dc`.
Each Batch A-G closure was re-walked under adversarial assumptions.
The mindset is the same one that produced AUD-200 + MCP-320 in
cycle-3 — assume the attacker has full source access and is hunting
for the asymmetric-defense or symmetric-coverage gap the closure
forgot to close.

## Source

- Audit: cycle-4 hostile re-audit (security-auditor agent, 2026-04-29)
- Cycle-3 baseline: `docs/audits/CYCLE-3-MCP-PUNCHLIST.md`
- Closeouts re-verified: Batches A-G (MCP-300/301/302/305/307,
  MCP-303/304/306, MCP-310, MCP-311/313/314, MCP-312, MCP-315/323/324,
  MCP-321/322), ADR-119 promoted, ADR-132 + ADR-133 accepted

## Severity tally

| Critical | High | Medium | Low |
|---|---|---|---|
| 0 | 1 | 1 | 0 |

## Findings

### CYCLE4-MCP-001 (High) — Unix transport skips both rate-limit AND origin gate

**File:lines:** `mcp-server/src/index.ts:339-400` (`startUnixTransport`)
vs. `mcp-server/src/index.ts:256-328` (`startHttpTransport`).

**Threat (asymmetric defense).** MCP-322 / ADR-132 flips the
container-default transport from `stdio` to `unix` with the auto-flip
socket path `/run/aep-mcp/mcp.sock`. Every containerized deployment
that does not explicitly pin `AEP_MCP_TRANSPORT=stdio` now lands on
the unix transport — and the unix transport's `startUnixTransport`
function does **not** wrap its `downstream` listener in either:

- `originGate.middleware(...)` (MCP-321 — the cycle-3 closure for
  CSRF / browser-origin attacks), nor
- `rateLimiter.middleware(...)` (MCP-320 — the cycle-3 Critical
  closure for the unbounded-call axis after a leaked or weak bearer).

The cycle-3 punchlist explicitly notes "stdio + unix transports
intentionally skipped (parent-process / UID trust boundary)" in the
MCP-320 footnote. That reasoning held when the unix transport was
the operator's _explicit_ opt-in. Post-MCP-322, the unix transport is
the **default** under containerized runtime detection, and the unix
transport's defenses now amount to:

1. socket-mode-0600 (filesystem ACL),
2. an _optional_ peer-uid check (`AEP_MCP_ALLOWED_UID`, unset by
   default),
3. the stale-socket-unlink-then-bind dance.

There is **no rate limiting** on the unix transport, so a same-uid
attacker (or any process inside the container that can `connect(2)` to
the socket — sidecars, debug shells, exec'd jobs) can fire unbounded
`vault_transfer` calls from the moment they reach the socket. This
is the EXACT failure mode MCP-320 closed for the HTTP transport: the
auto-flip in MCP-322 silently re-opens it for the new container
default.

The MCP-322 ADR-132 footnote claim that "the unix transport's optional
UID check is the safer default" is correct **relative to stdio's
parent-process trust** in a containerized runtime — but the
substitution does not preserve the rate-limit defense that landed in
the same release window. This is the cycle-3 asymmetric-coverage
pattern that produced MCP-320 in the first place: a defense exists at
one surface (HTTP) and not at a sibling surface (unix), and the
sibling now sees production traffic by default.

**Severity rationale:** High because:
- Containerized deployment is the realistic mainnet-day-1 posture for
  most operators.
- An unbounded-call axis on a tx-signing surface is the same threat
  model MCP-320 was rated Critical for.
- The threat actor is "any process that can reach the unix socket
  inside the container," which is broader than the stdio's parent-
  process trust boundary the auto-flip replaced.
- It is materially the same defense gap the cycle-3 audit closed at
  the HTTP transport, re-opened at the new default.

Not Critical because: a same-uid attacker who reaches the unix socket
could already do most of what they want at the OS layer (e.g.
co-resident reads of the operator wallet); the rate-limit is a
defense-in-depth control here, not the only line. But it is still the
defense the cycle-3 audit deemed mandatory for the HTTP transport, and
the new default flip should have brought it along.

**Suggested closure path:**

1. **Rate-limit on unix transport.** Wire
   `rateLimiter.middleware(downstream)` in `startUnixTransport` the
   same way it lands in `startHttpTransport`. The rate-limit bucket
   key strategy needs adapting — there is no bearer token nor a
   meaningful `req.ip` for AF_UNIX, but the per-connection peer-uid
   (when available) is a sensible bucket key, with a fallback to a
   single global bucket when peer-uid introspection fails. The fall-
   back-to-global is acceptable because the unix transport's parent
   trust assumption already bounds the caller set to the container,
   and a single-global bucket sized to the operator's expected
   throughput is sufficient to close the unbounded-call axis.

2. **Origin gate on unix transport.** The browser-origin threat is
   moot on AF_UNIX (browsers cannot `connect(2)` to a unix socket
   directly), so this is lower priority — but the reverse-proxy-
   mediated case (a process bridges HTTP-to-unix and forwards the
   `Origin` header verbatim) is real if an operator builds that
   bridge themselves. Recommend: also wire the origin gate, or
   document explicitly in ADR-132 + ADR-083 that the unix transport
   is incompatible with HTTP-bridging proxies.

3. **Document the trust-boundary delta.** Update ADR-132 §"Container
   default" with the explicit threat-model statement: "the unix
   transport's defenses are filesystem ACL + optional peer-uid; rate-
   limit defense-in-depth is mandatory before the auto-flip is the
   right default." Tie the cutover gate (the container auto-flip
   actually ships in production) to closure of this finding.

**Status:** Open.

---

### CYCLE4-MCP-002 (Medium) — `EvoSubprocessTransport.restartCount` is monotonic over process lifetime

**File:lines:** `mcp-server/src/adapters/evo-subprocess-transport.ts:179,
588-596` and `tripBreakerPermanently` callsite at line 624.

**Threat (operational denial-of-self).** MCP-301 introduced a
lifetime restart cap (`maxRestarts`, default 10) that locks the
breaker permanently when exceeded. The intent is "after 10 unrecoverable
crashes, give up rather than thrash." However, `restartCount` is
**never reset**. `consecutiveFailures` resets on a successful response
(line 499) and on cooldown completion (line 616-617), but
`restartCount` is monotonically incremented for the entire MCP server
process lifetime.

For a long-running MCP server (the expected production posture — the
operator restarts only on deploys / config changes / k8s events,
weeks-to-months of uptime), even a low-rate transient failure pattern
will eventually permanently brick the EVO bridge:

- **Scenario A.** EVO subprocess gets killed once a week by a
  long-running cleanup cron, or by the OOMKiller during a known
  memory-pressure spike, or by a transient network-mount issue on
  `AEP_EVO_DB`. After ~10 weeks of otherwise healthy operation, the
  breaker locks open permanently. Operator sees `find_similar_agents`
  silently degrade to the `{ skipped: true, reason: "evo-error" }`
  shape (good — MCP-304 closure), but the bridge will not recover
  even when the underlying issue is gone. Recovery requires an MCP
  server process restart.

- **Scenario B.** A flaky `AEP_EVO_BINARY` build (e.g. an EVO release
  with an intermittent `panic!` on a specific edge case) causes one
  restart per day. After 10 days of MCP uptime, the breaker locks.

The breaker design correctly handles "many failures in a short
window." It does not handle "few failures spread over a long window of
otherwise-healthy operation." The restart-cap-as-tripwire semantic is
inconsistent with `consecutiveFailures`'s reset-on-success semantic —
either both should be lifetime-monotonic or both should reset on a
sustained-healthy-window observation.

**Severity rationale:** Medium because:
- Bounded-failure-mode posture means a wedged EVO is "soft-degraded"
  (`find_similar_agents` returns skipped per MCP-304); no security
  defect.
- Phase 1 EVO is best-effort by ADR-129 contract; consumers don't
  rely on it for correctness.
- Recovery path is "operator restarts MCP server" — known + simple.

Not Low because:
- The MCP-301 footnote claims "circuit breaker after 10 restarts" as
  a backstop, but the actual semantic is "10 restarts ever before
  permanent brick" which is a different and weaker guarantee than
  what an operator reading the comment would assume.
- The threat is durability, not security, but the durability of an
  agent-memory bridge with a lifetime restart cap is genuinely brittle
  for long-running production processes.

**Suggested closure path:**

1. **Reset `restartCount` after a sustained healthy uptime window.**
   Add a `restartCountResetAfterMs` policy field (default e.g. 1h —
   well above any realistic transient-failure cluster). Track
   `lastSuccessAt = scheduler.now()` on every successful response (the
   same line that already does `consecutiveFailures = 0` at
   `evo-subprocess-transport.ts:499`). Whenever `scheduleRestart` is
   called, check `if (scheduler.now() - lastSuccessAt > policy.
   restartCountResetAfterMs) { restartCount = 0; }` BEFORE incrementing
   `restartCount`. This preserves the "10 restarts in a tight window
   = brick" semantic while letting "10 restarts spread over a year"
   recover gracefully.

2. **Alternative — surface restart count in the boot log + add a
   metric.** If the lifetime semantic is intentional, at minimum
   surface it via a Prometheus counter (`evo_bridge_lifetime_restarts`)
   so operators can alert before hitting the cap rather than discovering
   it post-brick. Pair with an explicit ADR-129 §"Resilience primitives"
   amendment documenting the lifetime semantic so the comment matches
   the code.

3. **Add a regression test.** The test seam (`scheduler.now()`)
   already exists. Add a test in `evo-bridge-resilience.test.ts` that
   advances virtual time across the reset threshold between two
   restart clusters to pin the recovery semantic.

**Status:** Open.

## Adjacent surfaces probed (no findings)

- **MCP-300 per-call timeout** — `evo-subprocess-transport.ts:447-462`.
  Timeout fires; late stdout response is dropped (`pending.settled`
  guard at line 479-486). The breaker decision is owned by
  `recordFailure`, not by the timeout itself, so a single late
  response doesn't kill the subprocess. CEI ordering preserved (settle
  caller first, then `recordFailure` which may schedule a restart).

- **MCP-302 bounded queue** — `evo-subprocess-transport.ts:261-268`.
  Inflight slot counts toward depth (`totalDepth = queue.length +
  (inflight ? 1 : 0)`). Handshake exempt (`!isHandshake` gate at line
  264). Rejection is synchronous. No path for a wedged handler to
  let unbounded peers pile up.

- **MCP-305 protocol handshake + version mismatch** —
  `evo-subprocess-transport.ts:304-427`. Tolerant parse for legacy
  `unknown command` rejection (treated as v1 with a warn log); explicit
  `EvoBridgeVersionMismatchError` trips the breaker permanently for a
  major mismatch. The handshake is enqueued via `unshift` so it
  precedes any user command — a user command landing before the
  handshake is impossible.

- **MCP-307 multi-line startup-error capture** —
  `evo-subprocess-transport.ts:182-183, 465-475`. Bounded at 2KiB
  (`MAX_STARTUP_ERROR_BYTES`). Joined with " | " separator on
  rejection reason. Append-not-overwrite verified.

- **MCP-303 absolute-path AEP_EVO_DB** —
  `mcp-server/src/adapters/evo-bridge.ts:447-476`. Two distinct error
  variants (`db-path` for unset, `db-path-relative` for relative).
  Module-load fail-fast.

- **MCP-304 `find_similar_agents` symmetry** —
  `mcp-server/src/handlers/registry.ts` try/catch wrapping mirrors
  the registry/settlement pattern; bridge failure surfaces as
  `{ skipped: true, reason: "evo-error" }`.

- **MCP-306 `parseRetrievalResult` numeric-score gate** —
  `evo-bridge.ts:340-388`. Drops entries lacking numeric `score` /
  `similarity` outright; genuine zero-similarity hits kept. Tested.

- **MCP-310 settle-time TTL** —
  `mcp-server/src/pipeline/idempotency.ts:102-152`. Entry stored with
  `expiresAt: null` while in-flight; concurrent acquire piggybacks on
  the same promise; TTL armed by `promise.finally` only after settle.
  The replace-check (`if (this.store.get(key) !== entry) return;`)
  prevents attaching our timer to someone else's entry after a
  concurrent invalidate.

- **MCP-311 vault-layout drift gate (runtime)** —
  `mcp-server/src/pipeline/vault-layout-drift.ts`. Re-walks the live
  IDL at boot; throws `VaultLayoutDriftError` with multi-line diff on
  mismatch. Best-effort no-op when IDL absent at runtime (build-time
  CI gate is authoritative). The IDL parser correctly handles
  variable-width types (`vec`/`option`/`string`) by stopping the prefix
  walk; the offset assertions are pinned against the generated
  artifact's named constants. **Caveat noted but not flagged:** the
  drift check reads IDL via `process.cwd()` relative path, so it
  depends on cwd at boot — if the operator launches MCP from a
  non-repo dir AND ships the IDL in an unconventional location, the
  best-effort skip-with-debug-log path runs and the build-time gate
  is the only authority. ADR-119 §"CI gate" already specifies the
  build-time gate as authoritative; the runtime check is defense-in-
  depth, so the cwd-dependence is acceptable.

- **MCP-312 preflight contract** —
  `mcp-server/src/pipeline/preflight.ts:1-40`. Inline contract block
  documents the only invariant pinned: PREFLIGHT-FAIL ⇒
  CHAIN-REJECT-FOR-THE-GATED-REASON. The inverse is explicitly NOT
  guaranteed (gate caches admit racy state, chain enforces invariants
  beyond preflight's five gates, commitment-level skew admits TOCTOU).
  Tests cover both directions.

- **MCP-313 IDL-derived layout codegen** —
  `mcp-server/scripts/gen-vault-layout.ts` reads `agent_vault.json`,
  emits `vault-layout.generated.ts`, wired via `prebuild`; CI gate
  is `git diff --exit-code` post-codegen. Hand-rolled offsets gone.
  `vault-layout.ts:VAULT_LAYOUT` re-exports the codegen output.

- **MCP-314 cache invalidation on transfer** —
  `mcp-server/src/handlers/vault.ts`. `invalidateVaultStateCache(addr)`
  called from the post-`.rpc()` site of `executeTransfer` and
  `executeTokenTransfer`. A follow-up cap check after the on-chain ix
  lands does not read pre-spend `spent_today_lamports` for up to 5s.

- **MCP-315 Redis-idempotency clock-skew** —
  `mcp-server/src/pipeline/idempotency-redis.ts`. Wait-time bound is
  computed by accumulating sleep durations rather than re-reading
  `this.now()`; final-sleep capped to remaining budget. Cross-
  instance clock skew between two MCP instances pointed at the same
  Redis no longer affects the per-call timeout.

- **MCP-321 origin gate** —
  `mcp-server/src/transport/origin-gate.ts`. Decision table covers
  the cross-site-without-Origin case (line 107: `fetchSite ===
  "cross-site"` → reject defensively). Server-to-server callers (no
  Origin) pass through to the auth gate. Allowlist is empty by
  default (only Origin-less callers permitted). Probed: a browser
  that strips Origin under privacy mode AND sends `Sec-Fetch-Site:
  same-origin` — that path would pass the gate, but the bearer-token
  layer downstream is unaffected, and the origin gate is anti-CSRF
  for browser callers, not the security boundary itself. Documented
  behavior, not a finding.

- **MCP-322 container auto-flip** —
  `mcp-server/src/transport/auth-gate.ts:93-249`. Detection signals
  match the comment (`AEP_MCP_FORCE_CONTAINER_DEFAULT=1`,
  `process.env.container`, `/.dockerenv`). Auto-flip emits a
  WARN-level boot log naming the detection signal. Operator escape
  hatch `AEP_MCP_TRANSPORT=stdio` documented in the error message.
  Default socket path `/run/aep-mcp/mcp.sock` only applied when the
  flip is auto, not when the operator explicitly picks `unix` (which
  preserves the require-AEP_MCP_UNIX_PATH semantic). **The defense
  symmetry gap is captured as CYCLE4-MCP-001 above.**

- **MCP-323 SDK typed Programs** — `sdk/client/src/{vault,registry,
  settlement}.ts`. `(program.account as any)` casts gone; new
  `idl-types.d.ts` re-export shim brings Anchor's generated types
  into the SDK type graph without violating `compilerOptions.rootDir`.
  Verified by grep — zero `as any` / `@ts-ignore` / `@ts-nocheck`
  in the SDK source.

- **MCP-324 handlers-v2 type-cast residual** —
  `mcp-server/src/handlers-v2/vault.ts:347-376, 405`. Four RPC-
  narrowing casts remain — `VaultTransferV2Rpc` is a structural
  narrowing of Kit's full `Rpc<SolanaRpcApi>`. The cast is sound
  ONLY in production where the runtime object passed via
  `createRpc() as unknown as VaultTransferV2Rpc` (line 405) is in
  fact the full Kit Rpc; tests that pass a mock satisfying only
  `VaultTransferV2Rpc` would not exercise this path because they
  inject their own `sendAndConfirm` and skip the factory
  construction at line 350. **Cast is structurally sound at runtime;
  closeout footnote claim verified.** Not a finding.

## Recommendation

Cycle-3 MCP closures hold under hostile re-audit, with two exceptions:

- **CYCLE4-MCP-001 (High)** — defense-symmetry gap reopened by the
  MCP-322 container auto-flip. Recommend folding rate-limit (and
  optionally origin-gate) into the unix transport before the
  container auto-flip ships in any production deployment. Treat as a
  release-window blocker for containerized mainnet operators.

- **CYCLE4-MCP-002 (Medium)** — operational durability gap on the
  EVO bridge restart cap. Recommend a sustained-healthy-window reset
  on `restartCount`, or at minimum a Prometheus surface so operators
  can alert before the cap. Not a release-window blocker because
  Phase 1 EVO is best-effort by ADR-129 contract.

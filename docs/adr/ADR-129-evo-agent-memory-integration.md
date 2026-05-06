# ADR-129: EVO as the agent-memory backbone behind mcp-server

## Status

Accepted

## Date

2026-04-27

## Context

ADR-128 (`docs/adr/ADR-128-indexer-storage-engine-selection.md`,
commit `7886554`, Status: Proposed) honestly evaluated EVO as a
candidate for the indexer primary and correctly placed it elsewhere.
The placement reasoning (ADR-128 §EVO assessment) reads:

> **EVO as the agent-memory backbone (NOT indexer) — STRONGLY
> ENDORSED, separate problem space.**
>
> The right place for EVO is the *agent-side* of the protocol — the
> mcp-server agent-memory layer, the cycle-3 reasoning-bank pattern
> storage, the "what did this agent learn from the last 100 escrow
> disputes" loop. That is what EVO was designed for, what its API
> contract (`MemoryEngine::observe / retrieve / learn / consolidate`)
> is shaped for, what its Rust + NAPI architecture is positioned to
> serve.

`docs/PRE_MAINNET_ROADMAP.md` §3 B12 records the deferral and notes
that the right slot for EVO is mcp-server, not the indexer. ADR-129's
job is to make that adoption concrete: not "should we use EVO" — that
question is settled — but "which mcp-server actions integrate with
which EVO operations, in which order, with what surface impact, and
what does the cycle-3+ work breakdown look like."

### Today's mcp-server has no agent-memory layer

Survey of `mcp-server/src/` confirms greenfield: `actions/` (26
typed actions across vault/registry/settlement/governance) and
`handlers/` are stateless request/response over Anchor program
calls; `pipeline/idempotency-redis.ts` is within-request dedup
(AUD-211/AUD-212), not cross-session memory; `util/` is logger +
result. mcp-server today is a typed RPC façade over the on-chain
programs plus indexer read-side hydration
(`handlers/registry.ts:269-342` `discoverViaIndexer`). It has no
notion of "what did this agent see last session," "which manifests
are similar to this one," or "what strategy worked the last time
we proposed a reputation delta to an agent in this category."

### What the protocol gains from agent memory

The protocol surfaces real cross-session learning shapes that no
existing layer covers:

1. **Manifest similarity at register time.** An agent calls
   `register_agent` with `capabilities: Vec<String>` (max 10 entries,
   `programs/agent-registry/src/state.rs:75`) and a manifest hash
   (ADR-092 manifest-hash domain separation). Operators and downstream
   agents would benefit from "find the K agents whose capability
   manifest is vector-close to this one" — surfaces collisions, finds
   complementary fits, supports curation. The current
   `discover_agents` action filters by exact-match category + substring
   capability + reputation floor (`handlers/registry.ts:326-336`); it
   has no similarity primitive.

2. **Reputation trajectory recall.** `propose_reputation_delta`
   emits `ReputationDeltaProposed`
   (`programs/agent-registry/src/events.rs:114`); the slash/clear
   flow emits `AgentSlashed` + `SuspensionCleared`
   (`events.rs:53,76`). Given an agent's recent reputation curve,
   recalling agents whose trajectory was vector-similar — and the L2
   strategies that succeeded for those agents — would directly
   improve operator triage during disputes and provide concrete prior
   data for human reviewers.

3. **Task-outcome learning over the settlement loop.** The settlement
   program emits per-milestone outcomes (approve / reject / dispute /
   timeout) tied to a (provider_agent, requester_agent, escrow_id)
   tuple. Observing the (request, agent, outcome) triple over time
   and asking "agents like this one succeed at tasks like this with
   probability P" is exactly what EVO L2's Bayesian-reliability +
   Thompson-sampled strategy retrieval (ADR-077, ADR-096, ADR-100 in
   EVO) is shaped for.

4. **Cross-session operator queries.** "What's this agent done
   historically? Has it been in this kind of dispute before? How does
   its current manifest compare to its previous one?" These are
   semantic-search and graph-walk questions, not transactional queries
   the indexer's PostgreSQL-bound (per ADR-128) event log answers
   well. EVO L1's HNSW + L3's content-addressed Merkle chain answer
   them natively.

### Why EVO is the right backbone (not "build our own")

EVO (`/home/neo/dev/projects/EVO`, dual MIT OR Apache-2.0 — verified
in `crates/evo/Cargo.toml`) is the team's own Rust-native cognitive
memory system, with the four-layer architecture, ONNX
all-MiniLM-L6-v2 embeddings (ADR-007 in EVO), and
economics-budget-bounded retrieval (ADR-077 in EVO) already shipped.
The MCP server interface (ADR-005 in EVO) exposes 8 production tools
plus 1 debug tool: `evo_observe`, `evo_retrieve`, `evo_learn`,
`evo_consolidate`, `evo_stats`, `evo_strategies`, `evo_health`,
`evo_l0_list` (`/home/neo/dev/projects/EVO/src/mcp/tools.ts:73-302`).

The shape match for our use cases is clean:

| Need                                | EVO primitive                             | EVO ADR / file                      |
|-------------------------------------|-------------------------------------------|-------------------------------------|
| Manifest similarity                 | L1 HNSW (cosine, 384-dim ONNX embeddings) | EVO ADR-002, ADR-013, ADR-014       |
| Reputation trajectory recall        | L1 retrieval with `as_of` bi-temporal     | EVO ADR-009                         |
| Task-outcome learning               | `learn(task_id, outcome)` + L2 strategy   | EVO ADR-019, ADR-020, ADR-095       |
| Operator semantic queries           | `retrieve(query)` with token-budget bound | EVO ADR-077                         |
| Don't-store-noise gate              | Surprise gate (windowed running mean)     | EVO ADR-067, ADR-091, ADR-092       |
| Strategy provenance + reliability   | L2 Bayesian reliability + Thompson sample | EVO ADR-019, ADR-096, ADR-100       |

Building this in-house would mean re-implementing surprise gating,
HNSW persistence (ADR-013/ADR-014 in EVO took 4+ ADRs), Bayesian
strategy reliability, economics-budget-bounded retrieval, and the
sleep-phase consolidation loop. EVO already ships all of it under a
permissive license, owned by the same team. The integration question
is the cycle-3 question; the build question is settled.

### EVO's invariants this ADR respects (no changes proposed)

EVO's `CLAUDE.md` flags these as load-bearing — the protocol consumes
EVO as-is and does not propose changes:

- `MemoryEngine` trait signature is frozen (5 methods: `observe`,
  `retrieve`, `learn`, `consolidate`, `stats`).
- Every memory operation has measurable cost + value (economics
  engine).
- Surprise gates all writes — operator must understand that not every
  observe call lands in L1.
- Retrieval is budget-bounded — the protocol passes a token budget on
  every retrieve call.
- L2 strategies are first-class with Bayesian reliability +
  provenance.
- Default embedding dim is 384 (the protocol does not override this).
- Retrieval ranking weight is similarity-primary (default 0.85)
  with economics tiebreak (default 0.15) per EVO ADR-077.

## Decision

Adopt **EVO as the agent-memory backbone behind mcp-server**, wired
via the **out-of-process EVO MCP server** (the same JSONL-bridged
subprocess EVO already ships at `EVO/src/mcp/index.ts`), with a thin
in-process **`AgentMemory` adapter** in mcp-server that translates
domain-shaped calls (`recordRegistration`, `findSimilarManifests`,
`recordOutcome`, etc.) into EVO `evo_observe` / `evo_retrieve` /
`evo_learn` calls. Adoption is staged across three phases; only Phase 1
is proposed for cycle-3 implementation work. Phases 2 and 3 are
post-launch.

### Why out-of-process MCP, not NAPI or HTTP

Three integration options were considered:

- **Option A (chosen): EVO as a child MCP-bridge subprocess** — same
  shape EVO's own recursive protocol uses
  (`EVO/scripts/hooks/evo-recursive.sh`), shipped binary
  (`EVO/target/release/evo`), JSONL stdio bridge
  (`EVO/src/mcp/bridge.ts`). One process per mcp-server instance.
  No new Node↔Rust binding work. The bridge already enforces
  ADR-048/ADR-058/ADR-059 input bounds and ADR-060 NaN-rejection on
  the TypeScript perimeter.
- **Option B: NAPI binding to the `evo` Rust crate** — best-case
  latency (no IPC), but EVO's NAPI bindings are documented as "under
  development" in ADR-128 §EVO-as-indexer-primary; landing them is
  not on the cycle-3 critical path. Defer to a later optimization
  ADR if the bridge IPC overhead becomes load-bearing.
- **Option C: standalone EVO HTTP service** — adds a network
  dependency, a port, a new ops surface, and a serialization round
  trip for no win over Option A's stdio JSONL.

Option A wins on cycle-3 schedule, ops-surface minimization, and
architectural reuse of EVO's existing tested bridge. Option B is the
documented future optimization.

### Phase 1 — Manifest similarity on register (cycle-3 first integration)

**Scope (one PR, ≤2 weeks single-engineer)**:

The smallest valuable integration: when an agent registers
(`mcp-server/src/handlers/registry.ts:45-108` `handleRegisterAgent`),
the post-register success path observes the new agent's
(authority, name, description, category, capabilities) tuple as an
L1 memory in EVO. A new read-only action `find_similar_agents` lets
operators and downstream agents query for K manifest-similar agents
under a token budget.

**New mcp-server surface**:

- `mcp-server/src/adapters/evo-bridge.ts` (new) — thin TypeScript
  client wrapping a long-lived `EvoBridge` (the class EVO already
  ships at `EVO/src/mcp/bridge.ts`). Owns the subprocess lifecycle:
  spawn at mcp-server boot, JSONL framing, 5s startup timeout, restart
  on `EVO_BRIDGE_DIED`. Exposes `observe`, `retrieve`, `learn`,
  `consolidate`, `stats`, `health` — one method per EVO MCP tool
  used in any phase.
- `mcp-server/src/adapters/agent-memory.ts` (new) — domain-shaped
  facade over `evo-bridge`. Phase 1 surface:
  `recordAgentRegistration({ authority, name, description, category,
  capabilities, manifestHash })`,
  `findSimilarAgents({ queryText, topK, tokenBudget, minSimilarity })`.
  Each call translates to one `evo_observe` or `evo_retrieve`
  invocation. Phase-2 / Phase-3 methods are added to the same facade
  in their own PRs.
- `mcp-server/src/handlers/registry.ts:handleRegisterAgent` — adds a
  best-effort post-success call to `agentMemory.recordAgentRegistration`.
  The call is fire-and-forget (logged on failure, never fails the RPC
  result) so EVO downtime never breaks `register_agent`.
- `mcp-server/src/actions/registry.ts` — new `findSimilarAgentsAction`
  exported alongside the existing 5 registry actions. Wires into
  `mcp-server/src/actions/index.ts:allActions` (count 26 → 27).
- `mcp-server/src/handlers/registry.ts:handleFindSimilarAgents` (new)
  — translates the action input into an `agentMemory.findSimilarAgents`
  call, hydrates the on-chain `AgentProfile` for each returned
  authority via `program.account.agentProfile.fetchMultiple` (already
  used by `discoverViaIndexer`), returns the merged shape.
- `mcp-server/src/types/capability.ts` — new capability constant
  `read:agent-memory` and `write:agent-memory`. Phase 1 uses
  `read:agent-memory` for `find_similar_agents` and is silent on
  writes (the post-register observe is a side effect of an already-
  authorized `register_agent`, not a new authorization surface).

**What this lets operators do (cycle-3 success criteria)**:

1. Run `find_similar_agents` against an existing agent's authority and
   get K manifest-similar agents back, ranked by cosine similarity in
   the 384-dim ONNX embedding space, bounded by token budget.
2. After N agents have registered, the cosine-similarity ordering
   should match qualitative expectations on a hand-curated test set
   (10-20 agents with deliberately overlapping vs. orthogonal
   manifests). This is the smoke test the Phase-1 acceptance suite
   pins.
3. The dashboard / mcp-server consumer can JOIN
   `find_similar_agents` results against indexer state (PG per
   ADR-128) for "find similar agents AND their event history" queries,
   without either store needing to know about the other.

**Phase 1 chosen as first integration because**: it is single-handler
in scope, the value (manifest-similarity discovery) is concrete and
operator-visible day-1, and crucially it does **not** need outcome
data to be useful. EVO L2 strategy retrieval (Phase 2) requires
accumulated outcomes; Phase 1's L1-only path is useful from the first
N>1 registrations onward. Cold-start friction is minimal.

### Phase 2 — Reputation trajectory + outcome learning (post-launch)

Wire settlement and reputation events into the EVO observe/learn
loop. After `propose_reputation_delta` lands (or its CPI counterpart
from the settlement program completes), mcp-server observes the
(provider_agent, delta, reason, timestamp) tuple and `learn`s the
strategy outcome. New surface, all in existing files:
`agent-memory.ts` adds `recordReputationDelta` /
`recordSettlementOutcome` / `findSimilarTrajectories`;
`handlers/reputation.ts` and `handlers/settlement.ts` add post-success
observe + learn calls; new `find_similar_trajectories` action.

Deferred to post-launch deliberately: cold-start = no useful
retrieval (L2 needs accumulated outcomes), and the protocol's launch
event volume of ~5-10 events/sec (ADR-128 §R1) means strategy
formation benefits from soak-data before operators rely on it.

### Phase 3 — Operator semantic-query MCP tools (post-launch)

Three new read-only MCP actions wrapping EVO retrieval surfaces:
`agent_memory_query` (wraps `evo_retrieve`),
`agent_memory_strategies` (wraps `evo_strategies`),
`agent_memory_health` (wraps `evo_health` + `evo_stats`). Zero new
write paths; pure read-side projections over Phase 1 + Phase 2 data.
Capability: `read:agent-memory`. Mandatory `token_budget` bound on
every call.

### Out of scope for ADR-129

- **EVO is NOT a replacement for `pipeline/idempotency-redis.ts`.**
  Different concern: idempotency-redis is per-request dedup over
  ~hour-scale Redis TTL (AUD-211, AUD-212); EVO is cross-session
  cognitive memory over month-scale persistent storage with surprise
  gating and budget-bounded retrieval. Both ship.
- **EVO is NOT a replacement for the indexer (PostgreSQL per
  ADR-128).** Indexer is system-of-record for finalized chain events
  with strict idempotency, exact-count queries, and PITR. EVO is
  semantic / cognitive memory over a derived projection. ADR-128
  §EVO-as-indexer-companion explicitly defers a possible
  semantic-search-companion-over-PG ADR; ADR-129 does not subsume it.
- **EVO is NOT used for within-mcp-server-process state.** No caching,
  no session state, no auth state. EVO is invoked from action
  handlers, not from the request middleware.
- **The `MemoryEngine` trait is NOT changed.** ADR-129 consumes EVO's
  shipped surface. If a future protocol need surfaces a missing EVO
  primitive, the change goes through EVO's own ADR process, not this
  one.

## Surface impact

What an implementation PR will need to change for Phase 1 (the
cycle-3+ deliverable). Phases 2 and 3 add to the same files; their
incremental shape is described in §Decision above and not re-listed
here.

### New + modified code (Phase 1 PR)

- `mcp-server/src/adapters/` (new directory peer to `actions/` /
  `handlers/` / `pipeline/`) — adapter modules wrap external systems.
  - `adapters/evo-bridge.ts` — owns the long-lived `EvoBridge`
    subprocess. Singleton, lazy-init, restart-on-die with bounded
    backoff. Emits ADR-103-shaped `Result<T, AepError>` with error
    codes `EVO_BRIDGE_UNAVAILABLE` / `EVO_BRIDGE_TIMEOUT` /
    `EVO_RETRIEVAL_BUDGET_EXHAUSTED`.
  - `adapters/agent-memory.ts` — domain facade. Phase 1 surface:
    `recordAgentRegistration`, `findSimilarAgents`. Returns the
    canonical `Result<T, AepError>` shape (`util/result.ts`,
    `types/action.ts:Result`).
- `mcp-server/src/types/capability.ts` — adds `read:agent-memory`
  and `write:agent-memory`. Phase 1 references read only.
- `mcp-server/src/actions/registry.ts` — adds
  `findSimilarAgentsAction`; registered in `actions/index.ts:allActions`
  (count 26 → 27).
- `mcp-server/src/handlers/registry.ts` — adds
  `handleFindSimilarAgents`; modifies `handleRegisterAgent` to fire
  a post-success best-effort observe.
- `mcp-server/src/index.ts` — at boot, instantiates the `evoBridge`
  singleton iff `AEP_EVO_ENABLED=true`. When false/unset, bridge is
  never spawned and `agent-memory.ts` calls return
  `{ skipped: true }`. This is the kill-switch.

### Contracts EVO must continue to hold

These are ADR-129's expectations of EVO; they are already true today
and we list them only so a future EVO change that violates them
surfaces as an ADR-129 regression rather than a silent integration
break:

1. **JSONL bridge protocol stays stable.** The
   `evo_observe` / `evo_retrieve` / `evo_learn` / `evo_consolidate` /
   `evo_stats` / `evo_health` MCP tool inputs and outputs are the
   surface mcp-server depends on. Schema changes go through EVO's
   ADR-005 / ADR-062 process; mcp-server pins the major version of
   EVO's `package.json`.
2. **Bridge subprocess respects ADR-048 input bounds.** The
   `EVO_MAX_*` env vars (`EVO/src/mcp/tools.ts:38-54`) bound payload
   sizes; mcp-server inherits these bounds and does not re-implement
   them.
3. **`evo_health` returns embedder kind.** ADR-057 in EVO requires
   `evo_health` to surface whether ONNX or BLAKE3-fallback embeddings
   are in use; mcp-server's Phase 3 `agent_memory_health` action
   surfaces this to operators (a BLAKE3-fallback EVO is silently
   semantically meaningless per `EVO/CLAUDE.md` §"Prerequisites").
4. **Retrieval is budget-bounded.** Every `evo_retrieve` call passes
   a `token_budget`; EVO's economics engine respects it (ADR-077 in
   EVO). mcp-server's defaults: `tokenBudget=4096`, `topK=10`,
   `minSimilarity=0.3` — each tunable per call.

### New env vars

Defaults are loopback-safe and disabled-by-default for cycle-3
deployment, mirroring the cautious-default pattern from ADR-127's
cold-spare and ADR-126's Redis adoption:

- `AEP_EVO_ENABLED` (default `false`) — master kill-switch. When
  `false`, mcp-server boots without spawning the EVO bridge and
  Phase 1's `find_similar_agents` returns
  `EVO_BRIDGE_UNAVAILABLE`.
- `AEP_EVO_BINARY` (default `evo`) — path to the EVO release binary.
  Mirrors EVO's own `EVO_BINARY` env var convention.
- `AEP_EVO_DB` (default `.aep-evo/agent-memory.db`) — SQLite (or
  future B^ε-tree per EVO ADR-010) memory DB path. Persistent across
  mcp-server restarts.
- `AEP_EVO_MODEL_DIR` (REQUIRED when `AEP_EVO_ENABLED=true`) — path
  to the ONNX all-MiniLM-L6-v2 model directory. EVO's
  `scripts/download_minilm.sh` produces this. Without it EVO
  silently degrades to BLAKE3 pseudo-embeddings (semantically
  meaningless), so we make it required at boot when EVO is enabled.
- `AEP_EVO_DEFAULT_TOPK` (default `10`).
- `AEP_EVO_DEFAULT_TOKEN_BUDGET` (default `4096`).
- `AEP_EVO_DEFAULT_MIN_SIMILARITY` (default `0.3` — matches EVO's
  ADR-062 default).

### Migration

**Greenfield.** mcp-server has no existing agent-memory layer to
migrate from (verified by survey of `mcp-server/src/`: no cache,
session, history, or memory modules outside `pipeline/idempotency-redis.ts`,
which stays). Phase 1 ships behind `AEP_EVO_ENABLED=false`; turning
it on is a config change, not a data migration. The first agents to
register after enable are the first observations EVO sees; cold-start
is N=1.

A future cycle-4+ backfill could replay historical
`AgentRegistered` events from the indexer through
`agent-memory.recordAgentRegistration` to seed L1 with pre-existing
agents — the script is straightforward against the PG indexer per
ADR-128, and ADR-128's PITR makes the source data trustworthy.
Out of scope for Phase 1.

### Tests

**Phase 1 PR**:

- Unit: `adapters/evo-bridge.test.ts` (lifecycle: spawn, roundtrip,
  kill-and-restart, bounded-backoff, ADR-103 shape);
  `adapters/agent-memory.test.ts` (facade translation + disabled
  returns `{ skipped: true }`); `actions/find-similar-agents.test.ts`
  (schema, capability gate, parallel-fetch hydration);
  `handlers/registry.test.ts` (extended — `handleRegisterAgent`
  returns identical success shape with EVO enabled vs. disabled
  since the observe is fire-and-forget).
- Integration: `test/aud-129-evo-roundtrip.integration.test.ts` —
  spins a real EVO binary in a temp dir against a tmpfs DB, runs
  observe → retrieve, asserts similarity ranking matches a hand-
  curated 10-agent fixture. Requires `EVO_MODEL_DIR` pre-downloaded
  on the runner (ADR-123 cache-hardening pattern).

**Phase 2+ (deferred)**: `aud-13X-evo-learn-strategy-formation.test.ts`
(observe N outcomes → consolidate → assert L2 strategies formed);
`aud-13X-evo-budget-bound.test.ts` (assert `token_budget` honored).

## Resilience primitives (cycle-3 close of MCP-300/301/302/305/307)

The Phase 1 subprocess transport (`mcp-server/src/adapters/evo-bridge.ts`,
EvoSubprocessTransport class) shipped without timeouts, restart logic,
queue bounds, version handshake, or multi-line startup-error capture.
Cycle-3 audit surfaced this as a ship-gate for `AEP_EVO_ENABLED=true` in
production. The transport has been split into
`mcp-server/src/adapters/evo-subprocess-transport.ts` and hardened with
the following primitives.

### State machine

```
idle ─send─▶ starting ─handshake-ok─▶ running
                            │
                            ├─send-success─▶ running
                            ├─send-failure (consecutive < threshold) ─▶ running
                            ├─send-failure (consecutive >= threshold)─▶ restarting
                            └─subprocess close ─▶ restarting | breaker_open

restarting ─cooldown elapsed─▶ idle (next send re-spawns)
restarting ─restartCount > maxRestarts─▶ breaker_open
breaker_open ─send─▶ reject immediately (terminal)
```

### Env knobs

| Env var | Default | Audit | Purpose |
|---|---|---|---|
| `AEP_EVO_CALL_TIMEOUT_MS` | 5000 | MCP-300 | Per-call timeout. Wedged subprocess no longer hangs callers. |
| `AEP_EVO_MAX_QUEUE_DEPTH` | 64 | MCP-302 | Bounded queue. New `send()` rejects with `EvoBridgeBackpressureError` once depth (inflight + queued) hits the cap. |
| `AEP_EVO_BREAKER_FAILURE_THRESHOLD` | 3 | MCP-301 | Consecutive call failures before tripping a restart. |
| `AEP_EVO_RESTART_COOLDOWN_MS` | 1000 | MCP-301 | Floor of the exponential-backoff restart cooldown (capped at 30s). |
| `AEP_EVO_RESTART_MAX` | 10 | MCP-301 | Lifetime restart cap. Exceeding this locks the breaker open permanently for the process lifetime. |
| `AEP_EVO_PROTOCOL_MAJOR` | 1 | MCP-305 | Required EVO protocol major version. Mismatch trips the breaker permanently. |

### Behavioral guarantees

1. **MCP-300** — A timed-out caller rejects with `EvoBridgeTimeoutError`.
   Any late stdout response that arrives after the timeout is silently
   dropped (the inflight is marked `settled`, so `onLine` no-ops).
2. **MCP-301** — Subprocess `close` events trigger restart with
   exponential backoff (`restartCooldownMs * 2^(restartCount-1)`, capped
   at 30s). After `maxRestarts`, `EvoBridgeBreakerOpenError` becomes
   the terminal failure mode and the transport behaves like
   `DisabledEvoClient` for the rest of the process lifetime.
3. **MCP-302** — Queue depth (inflight + queued) is bounded. The
   handshake is exempt (it `unshift`s to the queue head). New user
   `send()` calls past the cap reject synchronously.
4. **MCP-305** — On every (re-)spawn, the transport sends `{ cmd:
   "version" }` ahead of any user command. A `protocol_version`
   response with the wrong major locks the breaker open. Legacy EVO
   binaries that reject the cmd with `{ ok: false, error: "unknown
   command" }` are accepted as v1 (the version string is recorded as
   `"1.legacy"` for observability).
5. **MCP-307** — Unsolicited stdout lines (lines arriving while no
   command is inflight, e.g. EVO startup banners) accumulate into a
   bounded buffer (`MAX_STARTUP_ERROR_BYTES = 2048`). On subprocess
   close, all accumulated lines appear in the rejection reason rather
   than just the first.

The Phase 1 kill-switch posture (default OFF) is unchanged. When EVO is
enabled, the resilience policy is logged at boot under
`evo_call_timeout_ms` / `evo_max_queue_depth` / `evo_breaker_threshold`
/ `evo_max_restarts` / `evo_protocol_major` so operators see the live
policy at a glance.

Tests: `mcp-server/test/evo-bridge-resilience.test.ts` (9 tests across
the five audit IDs) inject a fake subprocess + line source via the
`spawnFn` and `lineSourceFactory` test seams so no real EVO binary is
spawned. The `ManualScheduler` test seam advances virtual time
deterministically.

## Consequences

### Positive

- **Manifest-similarity discovery becomes a one-call operator
  primitive.** Today's `discover_agents` only filters
  (category/capability substring/reputation floor); Phase 1 adds
  semantic similarity ranking under operator control.
- **Foundation for the cycle-3 reasoning-bank vision.** Phase 2's
  observe/learn loop on settlement outcomes is what turns
  the protocol from "agents transact" into "agents transact and the
  network learns from outcomes." Phase 1 lays the substrate.
- **Owned-stack alignment.** EVO is the team's own project, dual
  MIT OR Apache-2.0, actively maintained (10 commits in the last 7
  days as of 2026-04-26). No third-party vendor risk; bug fixes
  happen in-house.
- **Bridge-process isolation.** EVO crashes do not crash mcp-server.
  `AEP_EVO_ENABLED=false` is operator-actionable without a deploy.
- **Token-budget bound is enforced** (EVO ADR-077). Operator queries
  cannot accidentally exhaust embedding cost.
- **Surprise gate filters noise.** Repeated similar registrations
  do not bloat L1; operators get the high-signal slice for free.
- **Forward-compatible with EVO's roadmap.** Future EVO work (NAPI,
  B^ε-tree per EVO ADR-010, distributed CRDT per EVO ADR-006) lands
  behind the `agent-memory.ts` facade with no mcp-server rewrite.

### Negative

- **New runtime dependency the team owns.** EVO binary, ONNX model,
  and SQLite memory DB are new operational surfaces. Mitigation:
  team owns EVO; ops weight is internalized. Kill-switch makes
  downtime a degraded-feature state, not a protocol outage.
- **Embedding model adds cold-start time.** ~90 MB ONNX
  all-MiniLM-L6-v2; first load on cold mcp-server is 1-3 seconds.
  Mitigation: loads once at bridge spawn, not per-request.
  `AEP_EVO_MODEL_DIR` is required at boot so misconfig surfaces
  immediately rather than silently degrading to BLAKE3 fallback.
- **Surprise gating filters writes; operators must understand
  what's stored vs. filtered.** Not every observe lands in L1.
  Phase 3's `agent_memory_health` exposes the accept/reject ratio;
  pre-Phase-3, `evo stats` on the host is the diagnostic.
- **L2 cold-start = no useful retrieval.** Phase 2 delivers nothing
  useful in its first hours. Intrinsic to outcome-based learning.
  Mitigation: Phase 2 ships post-launch deliberately, after enough
  live traffic to seed strategy formation.
- **EVO production-maturity is "submission / production hardening,"
  not "hardened at protocol scale."** EVO's own status lists all
  core functionality shipped and 657 tests green, but the protocol
  is the first production consumer at this scale. Mitigation:
  Phase 1's `find_similar_agents` is read-only and best-effort —
  failure modes bound to "no results returned" rather than
  "register_agent fails." Phase 2 (write path) is deferred to
  post-launch precisely so EVO's behavior under sustained protocol
  load is observed before it gates behavior.
- **One more on-call surface.** Operators learn EVO's
  stats/health/consolidate ceremony alongside Anchor / indexer
  (ADR-128) / Redis (ADR-126). Phase 3 surfaces this through MCP
  tools; Phase 1 operators use the EVO CLI directly.
- **Bridge IPC adds per-call latency vs. NAPI** (~1-5ms typical per
  EVO bridge benchmarks, not measured at protocol scale).
  Mitigation: post-register observe is fire-and-forget;
  `find_similar_agents` is operator-initiated, not on a critical
  path. NAPI is the documented future optimization.

### Neutral

- **`evo` binary becomes a deployment artifact** alongside
  mcp-server. Build cost comparable to one Anchor program build.
- **`AgentRegistered` events are mirrored into two stores** (PG
  indexer per ADR-128 for transactional log; EVO L1 for semantic
  memory). Different access patterns; no consistency contract
  between them. PG is system-of-record; EVO is best-effort semantic
  enrichment.
- **Operator runbook gains an EVO section** post-launch
  (`docs/INCIDENT_RESPONSE.md` per C2 in the roadmap). Read-only
  side degrades cleanly; Phase 2 write side is loss-of-future-
  learning, not loss-of-correctness.

## Alternatives considered

### Alt-1: Roll our own agent-memory layer in mcp-server (REJECTED)

Bespoke `mcp-server/src/memory/` with our own SQLite schema,
embedding pipeline, retrieval ranking. Pros: zero new external
runtime dependency, total API control. Disqualifying con:
re-implementing surprise gating, HNSW persistence, Bayesian
strategy reliability, economics-bounded retrieval, and the sleep-
phase consolidation loop is a multi-quarter build EVO has already
shipped. "Build vs. buy" is the wrong frame when the buy is
in-house and already shipped — the decision is "consume in-house"
vs. "rebuild in-house," and consuming wins.

### Alt-2: Postgres + pgvector as the agent-memory store (REJECTED — RUNNER-UP)

ADR-128 already commits the indexer to PostgreSQL, so piggy-backing
pgvector on the same DB looks like the lower-ops-weight choice
(pgvector is PostgreSQL-License permissive). Disqualifying cons:
(1) **No surprise gate / economics / L2 / Bayesian reliability /
Thompson sampling.** pgvector is a vector index, not a cognitive
memory system; we would re-implement everything Alt-1 listed on top
of raw vector storage. (2) **Indexer + agent-memory sharing one PG
instance** is the load co-location ADR-128 §C5 explicitly avoided —
indexer is OLTP-shaped and idempotency-critical, agent-memory is
read-heavy with vector queries. Different tuning, different failure
isolation. (3) The cycle-3 reasoning-bank value proposition (Phase
2 here) is exactly the L2 strategy layer pgvector does not have.

This is the closest runner-up: ADR-128's PG dependency means the
marginal ops cost of pgvector adoption is small, and if EVO
adoption is later judged operationally untenable, Alt-2 is the
documented degraded fallback for vector-search-only versions of
Phases 1 and 3 (Phase 2 has no pgvector equivalent and would be the
explicit loss).

### Alt-3: Dedicated vector DB — Qdrant / Weaviate / Milvus (REJECTED)

All clear ADR-128's license bar (Apache-2.0 / BSD-3-Clause). Same
disqualifying con as Alt-2: vector stores, not cognitive memory
systems — re-implement gate / budget / strategy / consolidation.
Plus a new external service (more ops weight than Alt-2's
piggy-back).

### Alt-4: Status quo — no agent memory (REJECTED for cycle-3+)

The protocol can launch without agent memory; status quo is
correct for the tag itself (§3 B12 explicitly is not a tag-blocker).
But permanently shelving forfeits the cycle-3 reasoning-bank vision,
manifest-similarity discovery, and cross-session learning. Phase 1
is the smallest concrete step that keeps the option open without
blocking launch.

## References

### ADRs in this repo

- **ADR-128** — Indexer storage engine selection (PostgreSQL,
  Proposed). The placement decision for EVO that this ADR makes
  concrete. ADR-128 §EVO assessment §"EVO as the agent-memory
  backbone (NOT indexer)" is the load-bearing endorsement.
- **ADR-126** — x402-relay horizontal scale (Redis, Proposed).
  Sister ADR; structural template for ops-surface introduction; the
  "new runtime dependency the operator must learn" pattern.
- **ADR-127** — Indexer redundancy + backfill (Superseded by
  ADR-128). Predecessor to ADR-128; informs the
  `AEP_EVO_ENABLED=false` cautious-default-rollout pattern.
- **ADR-058** — `Action<I, O>` shape that Phase 1's
  `findSimilarAgentsAction` conforms to.
- **ADR-103** — Standardized `Result<T, AepError>` shape used by
  the new adapter layer.
- **ADR-088** — Typed Anchor program clients;
  `findSimilarAgents`'s on-chain hydration step uses
  `IdlAccounts<AgentRegistry>["agentProfile"]` exactly as
  `discoverViaIndexer` does.
- **ADR-092** — Manifest hash domain separation; the manifest hash
  observed in Phase 1 is the ADR-092 hash.

### EVO ADRs this design relies on (no changes proposed)

- **EVO ADR-005** — MCP Server (the surface Phase 1 consumes).
- **EVO ADR-007** — Native ONNX embeddings; the
  `AEP_EVO_MODEL_DIR` requirement traces here.
- **EVO ADR-013 / ADR-014 / ADR-015** — Persistent / mmap'd / CSR
  HNSW (L1 retrieval substrate).
- **EVO ADR-019 / ADR-020** — Recursive improvement protocol +
  strategy credit assignment (Phase 2 outcome loop).
- **EVO ADR-048 / ADR-059 / ADR-060** — MCP input bounds; defense-
  in-depth stack inherited by mcp-server.
- **EVO ADR-077** — Rank-score economics; default 0.85/0.15 weights.
- **EVO ADR-091 / ADR-092** — Surprise-gate metric the operators
  must understand.
- **EVO ADR-096 / ADR-097 / ADR-100** — Thompson sampling +
  exploration policy + UCB1; surfaced to operators in Phase 2 / 3.
- **EVO ADR-103** — Thread-safety contract; mcp-server's single
  bridge subprocess serializes access naturally.

### Code substrate (touched by Phase 1 PR)

- `mcp-server/src/handlers/registry.ts:45-108` —
  `handleRegisterAgent`; gains a post-success observe call.
- `mcp-server/src/handlers/registry.ts:269-342` —
  `discoverViaIndexer`; the parallel-fetch hydration pattern Phase 1
  reuses for similar-agents result hydration.
- `mcp-server/src/actions/index.ts:46-77` — `allActions` registry;
  `findSimilarAgentsAction` appended (count 26 → 27).
- `mcp-server/src/actions/registry.ts:139-161` — `stake_reputation`
  action; structural template.
- `mcp-server/src/types/action.ts:115-148` — `Action<I, O>` shape.
- `mcp-server/src/types/capability.ts` — adds `read:agent-memory`
  and `write:agent-memory`.
- `programs/agent-registry/src/state.rs:75` —
  `capabilities: Vec<String>` source field for embedding.
- `programs/agent-registry/src/events.rs:5,114` — `AgentRegistered`
  (Phase 1 input) and `ReputationDeltaProposed` (Phase 2 input).

### EVO source paths consumed

- `/home/neo/dev/projects/EVO/src/mcp/index.ts` — MCP server entry.
- `/home/neo/dev/projects/EVO/src/mcp/bridge.ts` — JSONL subprocess
  bridge wrapped by mcp-server's `evo-bridge.ts` adapter.
- `/home/neo/dev/projects/EVO/src/mcp/tools.ts:73-302` — production
  tool schemas (8 tools).
- `/home/neo/dev/projects/EVO/crates/evo/src/engine.rs:95-131` —
  `MemoryEngine` trait.
- `/home/neo/dev/projects/EVO/target/release/evo` — release binary.
- `/home/neo/dev/projects/EVO/scripts/download_minilm.sh` — ONNX
  model bootstrap.

### Operational documents updated by separate PRs (NOT this ADR)

- `docs/PRE_MAINNET_ROADMAP.md` §3 B12 — orchestrator updates the
  status entry once this ADR lands.
- Post-launch: `docs/AGENT_MEMORY_OPERATIONS.md` — Phase 3 operator
  runbook.
- Post-launch: `docs/INCIDENT_RESPONSE.md` §3.X — degraded-feature
  playbook for `AEP_EVO_ENABLED=false` fallback.

## Revisions

- 2026-05-06 — Status changed `Proposed` → `Accepted` (post-hackathon-prep
  audit; full adapter shipped, actively maintained per issue #71).

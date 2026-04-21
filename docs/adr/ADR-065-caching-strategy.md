# ADR-065: Caching strategy for multi-hop agent resolution — per-layer TTLs, dual in-memory / Redis backends

## Status
Proposed

## Date
2026-04-21

## Context

ADR-061 §4 defines a three-hop resolution flow for any consumer that wants a complete view of an AEP agent:

```
1. Registry account     — Solana RPC getAccountInfo
2. Off-chain manifest    — IPFS or Arweave fetch (ADR-060 §4)
3. SAS attestation(s)    — Solana RPC getAccountInfo + schema/credential PDAs
```

Unadorned, this is three network round-trips for every lookup. At the scale an agent-to-agent protocol implies — UIs, indexers, auto-bidders, dispute clients, capability search — that is untenable. The ADR-061 "Consequences → Negative" bullet for multi-fetch resolution explicitly defers to this ADR for the caching policy: *"Mitigated by caching at every layer (see ADR-065 for the explicit caching strategy)."*

The data fetched at each hop has different mutability:

- **Registry account** — mutates via CPI (reputation writes from Settlement, manifest republish, status transitions, stake changes). Stale reads here are actively dangerous because Registry is the authoritative protocol-state source per ADR-061 §5.
- **Manifest body** — content-addressed by `manifest_hash` (ADR-060 §1). Once the CID is known and the hash verified, the bytes cannot change without the hash changing. Effectively immutable for the lifetime of its CID.
- **SAS attestation** — mutable at the issuer's discretion (revocation, re-issuance). Consumers already tolerate bounded staleness per ADR-061 §6.
- **SAS schema PDA** — effectively immutable; new versions are new PDAs per ADR-061 §6.
- **SAS credential PDA** — signer-set changes are governed by ADR-063 and land on a slow cadence.

A single global TTL is the wrong tool — it's either too short (pays RPC cost for static data) or too long (serves stale protocol state). This ADR specifies per-layer TTLs, invalidation hooks, memory bounds, and cross-process cache sharing, paralleling the in-memory / Redis dual pattern ADR-059 §5 established for the idempotency store (`mcp-server/src/pipeline/idempotency.ts` and `idempotency-redis.ts`).

This is a **DOCS-only** ADR. The implementation lands in a follow-up PR against the `@aep/sas-resolver` package (ADR-064).

## Decision

### 1. Per-layer TTLs

Five logical cache layers, one TTL policy each:

| Layer | Default TTL | Key | Mutability | Rationale |
|---|---|---|---|---|
| `registry` (`AgentProfile` account) | **30s** | `authority` pubkey | Mutable — CPI writes from Settlement update `reputation_score`, `total_tasks_completed`, `status`, `capabilities[]`; agent authority can republish the manifest. | Short TTL bounds staleness of protocol-authoritative state (ADR-061 §5). 30s absorbs burst traffic without materially deferring the next slot's updates. |
| `manifest` (body fetched from IPFS / Arweave) | **24h** (or until `manifest_hash` changes) | `manifest_cid` | Immutable — content-addressed per ADR-060 §1; any byte change invalidates `manifest_hash`. | Can be cached indefinitely in principle; 24h is a pragmatic upper bound that still trims long-lived caches and rotates pin-service dependencies. Hash-drift invalidation (§2) handles the republish case. |
| `attestation` (SAS attestation account) | **5m** | attestation PDA | Mutable — issuer can close / re-issue. | ADR-061 §6 already admits bounded staleness (attestations degrade to "absent" silently). 5m gives meaningful hit rates without over-deferring revocation visibility. |
| `schema` (SAS schema PDA) | **1h** | schema PDA | Effectively immutable — new schema versions are new PDAs (ADR-061 §6). | Safe to cache for long periods. 1h caps worst-case divergence if a schema account is ever updated in-place through some future SAS mechanic. |
| `credential` (SAS credential PDA) | **1h** | credential PDA | Slow-cadence — signer-set changes route through ADR-063 multisig governance. | Governance cadence is weeks-to-months, not minutes; 1h is conservative and still within "cheap to reconcile" territory. |

The five TTLs span four orders of magnitude deliberately. That span is the justification for per-layer TTLs over a single global value — no single number is correct for both 30s-protocol-state and 24h-content-addressed data.

### 2. Invalidation hooks

TTL is the floor for correctness; explicit invalidation is the ceiling when a consumer observes an event that proves cached data is stale. The cache exposes the following triggers:

- **Registry write observed** — when a consumer sees a Registry-touching transaction (agent profile update, `reputation_score` CPI, manifest republish): evict `registry:<authority>`. Consumers with a Solana log subscription SHOULD wire this hook; consumers without one rely on the 30s TTL.
- **Manifest hash drift** — when a fresh `registry` read returns a `manifest_hash` that differs from the `manifest_hash` paired with a cached manifest body: evict `manifest:<old_cid>`. This is the one cross-layer coupling in the design — content-addressed caching is safe only because the hash comparison is cheap and local.
- **SAS revocation** — SAS closes the attestation PDA, so the next fetch already returns "absent" per ADR-061 §6 step 4b. **No proactive invalidation.** Consumers that need tighter freshness use the `maxAge` knob (§5).
- **Explicit consumer API** — `SasResolver.invalidate(subjectAuthority)` drops every cache entry keyed by that authority across all five layers in a single call. This is the hook for consumers that subscribe to on-chain events and want to push invalidation proactively without writing per-layer code.

Explicitly **not** included: proactive SAS attestation invalidation via a subscription feed. Revocation without an invalidation signal is the standard case for SAS and is already tolerated by ADR-061 §6. Adding a subscription surface would bloat the resolver's dep footprint (§4 alternative).

### 3. Backends — in-memory L1 + optional Redis L2

Parallel to ADR-059 §5's `IdempotencyStore` / `InMemoryIdempotencyStore` / `RedisIdempotencyStore`:

```ts
interface Cache {
  get<T>(layer: Layer, key: string): Promise<CacheEntry<T> | null>;
  set<T>(layer: Layer, key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  invalidate(layer: Layer, key: string): Promise<void>;
  invalidateAll(subjectAuthority: string): Promise<void>;
}
type Layer = 'registry' | 'manifest' | 'attestation' | 'schema' | 'credential';
interface CacheEntry<T> { value: T; cachedAt: number; ttlMs: number; }
```

Two concrete backends, env-driven factory:

- **`InMemoryCache`** — `Map<Layer, LruMap<string, Entry>>`, time-based expiry, LRU eviction. Default path. Parallels `InMemoryIdempotencyStore`.
- **`RedisCache`** — `SET <key> <value> PX <ttlMs>`, `GET <key>`, `DEL <key>`. Selected when `AEP_REDIS_URL` is set (same env var as the idempotency store — one Redis dep covers both). Parallels `RedisIdempotencyStore`.

**Layered deployment.** In multi-instance deployments the recommended topology is **L1 in-memory in front of L2 Redis**: the resolver checks the in-memory cache first (per-process locality, sub-millisecond), falls through to Redis on miss, then writes the Redis hit back up to L1. L1 TTLs SHOULD be the same as or shorter than the L2 TTLs so invalidation propagates on L1 expiry without requiring an explicit L1-flush-on-L2-invalidation signal.

**Key format.** `aep:cache:<layer>:<key>`, where `layer` is one of the five enum values and `key` is the layer's primary identifier: Registry authority pubkey, manifest CID, attestation / schema / credential PDA. Prefix is configurable for test isolation and for cohabiting with the `aep:idem:` namespace ADR-059 already claims.

### 4. Batch resolution and cache warming

The resolver's existing `SasResolver.resolveBatch(subjects)` API (ADR-064) parallelizes the per-subject three-hop flow. It also **writes through the cache on hit** — a batch of 100 subjects that all miss will populate 100 × (1 registry + 1 manifest + up to N attestations + shared schema / credential entries) on return. Consumers batching their lookups get cache warming for free.

For frequently-accessed subjects, consumers MAY run a background sweep that calls `resolveBatch(topN)` on a cadence shorter than the Registry TTL (e.g., every 20s for a 30s TTL, keeping the hottest 1k subjects warm). This is **consumer-owned**, not resolver-owned — the resolver does not ship a background prefetch worker. Rationale: prefetch policy is workload-specific (a marketplace UI prefetches differently than a dispute client), and shipping a default worker invites the wrong one.

Explicitly rejected: ML-based prefetch predictors, cold-start analytics, predictive pinning. The size class of the problem does not justify the machinery.

### 5. Staleness surfaces — `cachedAt` and `maxAge`

Every resolver return value carries `cachedAt: number` (Unix ms) alongside the data. Consumers inspect it to decide whether to force-refresh independent of the layer's TTL.

```ts
const r = await resolver.resolve(authority);           // default: respects TTL
const r = await resolver.resolve(authority, { maxAge: 0 });     // force fresh
const r = await resolver.resolve(authority, { maxAge: 5_000 }); // tighter than TTL
```

`maxAge` is a per-call override that demands "no data older than this." If the cached entry's `cachedAt + maxAge < now`, the resolver bypasses the cache and hits the RPC. `maxAge: 0` is the canonical "I am making a protocol-logic decision, give me a fresh read" signal.

Default behavior respects each layer's TTL. Tighter freshness is opt-in. Consumers reading `reputation_score` for an automated decision path MUST pass `maxAge: 0` — the Consequences section restates this obligation.

### 6. Memory bounds

**In-memory.** `InMemoryCache` is LRU-bounded **per layer** with a default ceiling of **10,000 entries per layer**. Memory math, sized for a conservative 2KB average entry (a populated `AgentProfile` is ~600 bytes, a small manifest is ~1–2KB, a SAS attestation data payload is 16 bytes per ADR-061 §2 plus account overhead):

```
10,000 entries × ~2KB × 5 layers ≈ 100MB worst-case process footprint
```

A ceiling of 10k entries covers the hot set of any deployment this ADR anticipates. Operators with larger footprints either raise the ceiling (memory cost linear in entry count) or shift to Redis L2 (process-local L1 sized smaller, shared L2 carrying the long tail).

**Redis.** TTL-driven expiry plus Redis memory-eviction policy. Operators SHOULD configure the Redis instance with `maxmemory-policy allkeys-lru` — this makes Redis a bounded cache rather than an unbounded store, matching the semantics of the in-memory path. The resolver does not enforce this from the client side; it's a deployment-runbook concern documented alongside ADR-064.

### 7. Observability

The cache exposes a metrics surface shaped as a plain counter record:

```ts
interface CacheMetrics {
  hits: Record<Layer, number>;
  misses: Record<Layer, number>;
  evictions: Record<Layer, number>;   // LRU evictions (in-memory) + expiry evictions
}
```

The resolver exposes `getMetrics()` returning a snapshot; consumers adapt to Prometheus, OpenTelemetry, or their metric backend of choice. **No direct Prometheus or OTel dependency in the cache package.** Rationale: ADR-059 §5 already resisted adding monitoring deps to the pipeline, and the same reasoning applies — a cache is a low-level primitive, and its consumers ship in diverse environments. A metrics counter interface is the narrowest seam that still makes the cache observable.

### 8. Scope boundary

This ADR **changes no code.** Specifically:

- `programs/**` — unchanged. The cache lives entirely off-chain per ADR-061's option B.
- `mcp-server/src/pipeline/{idempotency,idempotency-redis}.ts` — unchanged. The idempotency store and the resolver cache are separate concerns sharing the `AEP_REDIS_URL` env var and the dual-backend pattern.
- `@aep/capability-manifest-validator` — unchanged.

The cache implementation ships in a follow-up PR against the `@aep/sas-resolver` package (ADR-064). That PR will add `InMemoryCache` and `RedisCache` modules paralleling the existing idempotency files, wire them into the resolver's three-hop flow, and export `CacheMetrics` / `invalidate()` / `resolve(... { maxAge })`.

## Alternatives Considered

### Alternative A: No cache (always fetch)
Rejected. Three network hops per lookup at agent-to-agent protocol scale is infeasible — the P95 round-trip across Solana RPC + IPFS gateway + Solana RPC easily reaches seconds, and the unique-subject cardinality makes the RPC bill material. ADR-061 explicitly deferred caching to this ADR because it was never an option to skip.

### Alternative B: Single global TTL
Rejected. The five layers span four orders of magnitude of mutability (30s protocol state ↔ 24h content-addressed body). Any single TTL is either wasteful for immutable data or dangerous for mutable data. Per-layer TTLs are the minimum viable resolution.

### Alternative C: Manifest-only cache (skip Registry and SAS)
Rejected. Registry and SAS fetches are the **expensive** ones — they are the Solana RPC hops that dominate the three-hop cost. Manifest fetches go to IPFS gateways or Arweave and are already CDN-assisted. Caching only the cheap hop inverts the benefit.

### Alternative D: Push-based invalidation via Solana WebSocket subscriptions
Rejected for v1. Subscribing to `accountSubscribe` / `logsSubscribe` for every cached subject would give tighter invalidation than TTL, but:
- adds a persistent WebSocket dep to the resolver;
- multiplies RPC surface area (one sub per cached subject);
- creates a reconnect / dropped-event handling surface that has no equivalent on the TTL path;
- the `maxAge: 0` escape hatch already serves the "I need fresh data right now" case that would otherwise motivate pushes.
TTL-based is simpler and correct at this scale. A future ADR can add subscription-based invalidation if a concrete use case emerges.

### Alternative E: LRU plus content-hash dedup
Rejected. For the manifest layer specifically, one could imagine caching by SHA-256 of the body rather than CID, so that two CIDs pointing at identical content share a cache entry. This is a marginal win — the size class is 10k entries, duplication is rare, and the extra bookkeeping (hash-to-CID index, hash-to-body store) is disproportionate.

### Alternative F: Redis-only, no in-memory fast path
Rejected for single-instance deployments — matches ADR-059 §5's rejection of Alternative E for the same reason. Redis would be a mandatory dep. In-memory for single-instance, Redis for multi-instance (with L1 in-memory in front), determined by `AEP_REDIS_URL` — identical config knob to the idempotency store.

## Consequences

### Positive
- **Sub-second lookups for cached subjects.** Registry + SAS cache hits are `Map.get` or Redis `GET`; manifest cache hits skip the IPFS / Arweave round-trip entirely.
- **Linear scaling with unique subjects.** Hot set lives in L1, long tail is either recomputed on miss or lives in L2 Redis.
- **Parallel pattern with ADR-059 idempotency store.** One Redis dep, one config knob (`AEP_REDIS_URL`), two lazy-loaded backends, matching factory ergonomics.
- **Staleness is opt-in strict.** Consumers default to TTL-bounded staleness; protocol-logic consumers pass `maxAge: 0` for authoritative reads.
- **Observable without a monitoring-framework dep.** The counter-record interface is adapter-friendly for Prometheus / OpenTelemetry / custom backends.

### Negative
- **Stale reads are bounded by TTL.** Protocol-logic consumers MUST use `maxAge: 0` for authoritative reads (reputation gates, tier thresholds, dispute eligibility). Otherwise a consumer may act on a stale `reputation_score` up to 30s old. This is the single load-bearing correctness obligation this ADR imposes on consumers.
- **Cache memory footprint.** Worst-case 100MB in the process for a fully populated in-memory cache. Mitigated by per-layer LRU ceilings and the Redis L2 option.
- **Manifest hash-drift invalidation requires a fresh Registry read.** If a consumer only hits the manifest cache without re-reading the Registry, it cannot detect that the underlying `manifest_hash` changed. The resolver serializes the Registry read before the manifest read already (ADR-061 §4), so this is a resolver-internal constraint, not a consumer one — but it constrains any future "manifest-only" caller API.
- **Two caches and an idempotency store share one Redis.** Namespace collisions are prevented by the `aep:cache:` vs. `aep:idem:` prefixes, but operators running both need to size the Redis instance for the union.

### Neutral
- **No change to Registry, Vault, Settlement, or SAS.** The cache lives entirely in the resolver package; it is orthogonal to on-chain programs and to the idempotency pipeline.
- **Follow-up ADR for subscription-based invalidation remains open.** Alternative D is explicitly rejected for v1, not v∞.
- **`@aep/sas-resolver` PR (ADR-064) absorbs the implementation.** This ADR defines the policy; the package PR delivers the code.

## Open items / follow-up ADRs

- **ADR-066**: on-chain governance upgrade path if the protocol outgrows the ADR-063 multisig model.
- **ADR-067**: cross-protocol credential trust — how AEP resolvers handle SAS attestations signed by credential authorities from other protocols, including whitelist expansion governance.

## References

- `docs/adr/ADR-059-tx-submission-pipeline.md` §5 — `IdempotencyStore` interface and in-memory / Redis dual-backend pattern this ADR parallels
- `docs/adr/ADR-060-capability-descriptor-format.md` §1, §4 — manifest storage, `manifest_hash` integrity commitment (basis for §2 hash-drift invalidation)
- `docs/adr/ADR-061-sas-integration.md` §4 — three-hop resolution flow (Registry → IPFS/Arweave → SAS); §6 staleness policy (90-day threshold, absent-on-expiry); Negative-consequence reference to this ADR
- `docs/adr/ADR-063-sas-governance.md` — credential-authority governance cadence (informs `credential` TTL in §1)
- `docs/adr/ADR-064-sas-resolver-package.md` — the resolver package that will host this cache
- `mcp-server/src/pipeline/idempotency.ts` — `InMemoryIdempotencyStore`, factory, module-level singleton
- `mcp-server/src/pipeline/idempotency-redis.ts` — `RedisIdempotencyStore`, wire protocol, lazy `ioredis` loading

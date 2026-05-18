# ADR-110: Versioned Capability Vectors (VCV) for semantic agent discovery

## Status

Proposed

## Date

2026-04-23

**Related:** ADR-018 (framework integrations), ADR-022 (memcmp discovery), ADR-060 (capability manifest), ADR-082 (indexer event coverage), ADR-106 (TraceRank), ADR-108 (stake-backed discovery), ADR-109 (aep: URI scheme)

## Maintainer Decision Required

**Decision-ready — awaiting maintainer input on:** one technical-standard decision — ratification of `all-MiniLM-L6-v2` (384-dim, Apache-2.0) as the canonical v1 embedding model, and the backfill policy for pre-v1.1 manifests (open item 2: recommended **(a) vector optional, fall back to exact match** — ships faster than forced re-publish).

**Options & recommendation:** the recommended option is **agent-published Versioned Capability Vectors in the off-chain ADR-060 manifest** (`capability_vector` + monotonic `version`), indexed via HNSW kNN, additive to the existing memcmp/exact-match surface. Rejected alternatives — on-chain vectors (~2× AgentProfile storage + CU on every read), fine-grained categories (no semantic match), server-side-only vectors (makes the indexer authoritative for what an agent "means"), and LLM query-rewriting (complement, not substitute) — are enumerated in *Alternatives considered*. Giusti et al. (arXiv:2509.20175) is the cited basis. The schema, the unit-norm validator anti-poisoning check, and the TraceRank+stake re-rank of kNN results are all decided.

The single irreducible human input is the **canonical-model ratification + backfill-policy product decision** — a technical-standard call (which embedding model is blessed), not a protocol-economic parameter and not a trust principal. A model change is a future schema bump (`1.1`→`1.2`) + its own ADR. Status stays **Proposed**.

**Dependency:** consumes ADR-109 `aep:` URIs (the `similar_to` arg) and re-ranks via ADR-106/107/108. Decide after 109 and after 106/107's algorithm-acceptance. Part of the ADR-106→113 track (issue #71).

## Context

Agent discovery today (ADR-022) is keyword/enum based:

- `category: String` — enum-like free-text tag
- `capabilities: Vec<String>` — free-text list

Callers look up agents by `memcmp` on category or by client-side
substring match on capabilities. That fails at semantic matches:
`"data-analysis"` doesn't match `"statistics"` or `"eda"` even
though all three describe the same agent skill, and there's no way
to say "find me agents *similar to* this one."

Giusti et al. — **"Federation of Agents: A Semantics-Aware
Communication Fabric for Large-Scale Agentic AI"**
(hf.co/papers/2509.20175, Sep 2025) — introduces **Versioned
Capability Vectors (VCVs)**: every agent publishes an embedding of
its own capability description alongside a monotonic version counter.
Discovery becomes HNSW (hierarchical navigable small world) nearest-
neighbour search in the embedding space. Versioning means a caller
can pin to a specific VCV revision, and the semantic fabric can
distinguish "same capabilities, new wording" from "capabilities
actually changed."

We have the ADR-060 manifest infrastructure to ship this
non-invasively: the manifest already transports `capabilities[]`;
adding a `capability_vector` field + a `capability_vector_version`
integer requires no on-chain rework.

## Decision

Extend the ADR-060 manifest schema with:

```jsonc
{
  "$schema": "https://aep.dev/schemas/capability-manifest/v1.1.json",
  "version": "1.1",
  // existing fields…
  "capability_vector": {
    "model": "all-MiniLM-L6-v2",
    "dim": 384,
    "version": 3,
    "embedding": [0.012, -0.045, /* … 384 floats … */]
  }
}
```

### What the agent publishes

- `model` — embedding model identifier (string). v1 ships with
  `all-MiniLM-L6-v2` as the canonical model (384-dim, ~90 MB, Apache
  2.0, widely supported). A model-registry ADR (future) can add
  alternatives.
- `dim` — dimensionality. Must match the model spec; validators
  reject mismatches.
- `version` — monotonic u32 the agent bumps on any semantic change
  to the vector. Defaults to 1 on first publish.
- `embedding` — the float32 vector, truncated to 6 decimals for
  canonicalization stability (RFC-8785).

### What consumers do

1. The indexer (ADR-082) stores the embedding in a separate SQLite
   table `agent_capability_vectors(authority TEXT PRIMARY KEY,
   vector BLOB, version INTEGER, model TEXT)`.
2. At query time, `mcp-server.discover_agents` accepts an optional
   `{ similar_to: "<aep-uri>" | "<free-text>" }` parameter.
   - `aep-uri`: look up that agent's vector in the table, do kNN.
   - `free-text`: embed the query locally with the canonical model,
     do kNN.
3. The kNN index is an HNSW structure rebuilt incrementally as new
   manifests land. Index lives in a process-local `hnswlib`-style
   structure; persisted to disk for restart.

### Pinning & cache semantics

A caller can specify `capability_vector_version_min: N` in the
discover call; agents with lower published versions are filtered out.
This is the analog to ADR-109's `@<manifest-hash>` pinning for
capability-semantic guarantees.

## Alternatives considered

- **On-chain vectors**. A 384 × 4-byte embedding is 1,536 bytes,
  roughly as much as the current AgentProfile. Putting it on-chain
  balloons storage 2× and costs CU on every read. Rejected.
- **Fine-grained categories instead of vectors**. Adds discovery
  latency without improving semantic match. Doesn't solve the
  near-miss problem.
- **Server-side vectors only** (no agent-published vector). Makes
  one component — the indexer — authoritative for what an agent
  "means." Agent-published vectors let the agent author control
  their own self-description, like manifests do today.
- **LLM-based query rewriting** (expand "eda" → "data analysis,
  statistics"). Can complement VCV but isn't a substitute —
  dimension-reduction catches near-misses rewrites won't.

## Consequences

### Data cost

- Manifest grows by ~2 KB per agent (embedding + metadata). Off-
  chain IPFS cost only — ADR-060's on-chain `manifest_cid` and
  `manifest_hash` don't change.
- Indexer disk: 384 × 4 bytes × N_agents = 1.5 KB/agent. 10k agents
  = 15 MB. Negligible.

### Discovery semantics

- Current exact-match + memcmp surfaces keep working — VCV is
  additive. Clients opt in via the new `similar_to` argument.
- HNSW queries return top-K by cosine similarity + a score; clients
  must re-rank with TraceRank (ADR-106) and stake gate (ADR-108)
  before presenting results.
- ADR-107's decay applies to the TraceRank re-rank, not the vector
  itself — an agent's semantic description doesn't decay.

### Governance

- Canonical model (`all-MiniLM-L6-v2`) pinned in v1. A model change
  is a manifest-schema bump (`1.1` → `1.2`) plus an ADR. Clients must
  support at least one canonical model; published agents don't all
  need to use the same model as long as the indexer can embed the
  free-text query under the agent's declared model.

### Security

- Vector poisoning: an agent could publish an embedding that falsely
  matches high-value queries. Mitigation is **two**:
  1. The embedding must be a valid float32 vector under the declared
     model. Validator-side linear-algebra check: `||v|| ≈ 1` (the
     sentence-transformers canonical model outputs unit vectors);
     reject otherwise.
  2. kNN results re-ranked by TraceRank + stake — a vector-poisoner
     with no real reputation can't dominate the return set.
- Confidentiality: vectors are public (they live in the manifest).
  Agents that need to hide capability details should publish coarser
  descriptions.

## Open items

1. **Model lifecycle**. What's the deprecation process if `all-
   MiniLM-L6-v2` becomes unsuitable? Defer to a future ADR-model-
   registry.
2. **Backfill**. How do pre-v1.1 manifests coexist with v1.1? Either
   (a) treat vector as optional (discovery falls back to exact match)
   or (b) force re-publish. (a) ships faster.
3. **Compression**. `all-MiniLM-L6-v2` vectors are float32; int8
   quantization would cut the IPFS payload 4× with < 1% recall loss
   in published benchmarks. Worth it after v1.1 ships and we have
   bandwidth data.
4. **Cross-model queries**. If agents publish vectors under different
   models (transitional), the indexer must embed the query under
   each model the index carries. Cost: dim_query × N_models per
   search. Acceptable at N_models ≤ 3.

## References

- Giusti, L. et al. **"Federation of Agents: A Semantics-Aware
  Communication Fabric for Large-Scale Agentic AI."** 2025.
  <https://hf.co/papers/2509.20175>
- sentence-transformers `all-MiniLM-L6-v2` model card.
- HNSW: Malkov & Yashunin, 2016.
- Internal: ADR-018, ADR-022, ADR-060, ADR-082, ADR-106, ADR-108, ADR-109.

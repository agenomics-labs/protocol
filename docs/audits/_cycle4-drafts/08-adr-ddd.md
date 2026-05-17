# Cycle-4 Audit — 08: ADR Corpus + DDD Bounded-Context Integrity

**Auditor lens:** architecture-integrity, security-adjacent
**Baseline:** branch `audit-baseline`, origin/main `b8fe80b`
**Scope:** `docs/adr/` (ADR-001…141 + stubs/template) + 7 bounded contexts
(programs, indexer, mcp-server, sdk, x402-relay, dashboard, packages)
**Mode:** READ-ONLY. No code edits, no commits.

---

## Method

- Enumerated all 146 `docs/adr/*.md`; verified numbering 001→141 dense (no
  missing files); classified Status per file.
- For each security-relevant Accepted ADR (083, 105, 115, 122, 129, 138,
  139, 111, 094, 068, 133, 086) traced the claimed decision to concrete
  file evidence in the implementing context.
- Mapped per-context import surfaces (`@agenomics/*`, raw paths, relative
  cross-tree) for the 5 TS contexts to detect boundary leakage and
  shared-state coupling.
- Cross-checked indexer's hand-rolled `AgentProfile` Borsh decode against
  `programs/agent-registry/src/state.rs` (ubiquitous-language / invariant).

---

## Findings

### F-08-01 — DRIFT (security-relevant): ADR-129 EVO adapter skew — Phase 1 read-path is a silent no-op even when enabled

- **Type:** drift (Accepted ADR; implementation present but functionally inert)
- **ADR:** ADR-129 (EVO as agent-memory backbone) — Status **Accepted**
- **Context boundary:** mcp-server → EVO subprocess (adapter)
- **Evidence:**
  - `mcp-server/src/adapters/evo-bridge.ts:350-398` `parseRetrievalResult`
    only recognizes `result.results` / `result.hits` arrays and `entry.id`.
  - Carried memory of the live EVO contract: real EVO emits
    `result.memories` with `node_id` (not `result.results` / `entry.id`).
    `grep -rn "memories\|node_id" mcp-server/src/adapters/` → **zero hits**.
  - Fix (tracked as PR #165 per prior cycle) is **not in this baseline**:
    `git log -- mcp-server/src/adapters/evo-bridge.ts` shows last touch
    `d2a2d0e` (breaker hardening), no skew fix; no commit referencing #165
    or "adapter skew" reachable from `b8fe80b`.
  - `enabled: envFlag(env,"AEP_EVO_ENABLED",false)` (evo-bridge.ts:181) —
    kill-switch default-OFF is correctly implemented and matches ADR-129
    §"kill-switch", so the ADR's *safety* claim holds.
- **Risk:** Medium (correctness, not exploit). ADR-129 is Accepted and the
  boot log advertises `evo_enabled`. An operator who flips
  `AEP_EVO_ENABLED=true` gets a server that *reports* EVO live but whose
  `find_similar_agents` retrieval silently returns empty because every hit
  is dropped at the `results`/`hits` discriminator. False sense of an
  active learning surface; downstream ADR-129 Phase 2/3 plans build on a
  retrieval path that has never returned a row in production.
- **Recommendation:** Land the parser fix (accept `result.memories` +
  `node_id` alongside the legacy keys) before any Phase-2 work; add a
  contract test pinned to a recorded real-EVO `retrieve_text` response so
  the skew cannot silently regress.
- **ADR-needed?** No new ADR — implementation correction to ADR-129. A
  one-line Revisions entry in ADR-129 documenting the contract mismatch
  and the pinned-fixture guard is sufficient.

### F-08-02 — LEAK / COUPLING (security-relevant): indexer ↔ on-chain account layout pinned by comment only

- **Type:** leak (cross-context coupling with no enforcement boundary)
- **Context boundary:** `src/indexer` → `programs/agent-registry` internal
  byte layout
- **Evidence:**
  - `src/indexer/reputation-attestor-wire.ts:8-13,115-150,191-238` —
    indexer hand-decodes `AgentProfile` via a private `BorshSlice` reader,
    skipping the 8-byte Anchor discriminator and walking field offsets
    "tied to the `AgentProfile` Rust struct field order". The pin is a
    **doc comment**; no `@agenomics/idl` schema, no generated decoder, no
    CI assertion links it to `programs/agent-registry/src/state.rs:72-133`.
  - Layout currently *matches* the Rust struct (verified field-by-field:
    `authority, name, description, category, capabilities, …,
    __padding_aud007[17], …, reputation_score, …, registration_nonce,
    cleared_count, cdp_wallet`), so there is no live decode bug today.
  - Note: mcp-server / sdk-client take the *type-only* `target/types/*`
    dependency (ADR-088-sanctioned, compile-time-checked). The indexer is
    the only context that re-implements the binary layout by hand with no
    compile-time tether — the highest-blast-radius coupling of the seven.
- **Risk:** Medium-High (latent). The indexer feeds ADR-139 portable
  reputation attestations (`reputation-attestor.ts` → signed
  `AgentProfileSnapshot`). A future `agent-registry` field reorder *before*
  `cdp_wallet` (e.g. a non-padding-preserving migration) would silently
  shift `reputation_score` / `registration_nonce` offsets; the indexer
  would sign and export **wrong reputation values** with a valid issuer
  signature. Blast radius = every cross-protocol consumer trusting ADR-139
  attestations. The only thing preventing this is reviewer discipline plus
  the AUD-007 padding-preservation convention — neither is mechanically
  enforced across the context boundary.
- **Recommendation:** Add a CI gate that asserts the indexer's expected
  `AgentProfile` prefix offsets against the IDL JSON shipped by
  `@agenomics/idl` (the IDL already encodes field order), failing the
  build on drift. Longer term, replace the hand-rolled `BorshSlice` with a
  generated decoder once ADR-141 (Codama) lands.
- **ADR-needed?** Yes — a short ADR (or an explicit Decision addition to
  ADR-082 indexer-event-coverage-gate / ADR-127) mandating that any
  context decoding on-chain accounts outside the program crate must do so
  through `@agenomics/idl` or a CI-asserted offset contract. This closes
  the same class symmetrically (cf. prior lesson: symmetric init+mutation
  coverage — here it is symmetric program-side + indexer-side layout
  coverage).

### F-08-03 — GAP (status hygiene, non-drift): security-relevant ADRs verified consistent

Documented here to bound the audit (these were checked and are NOT drifts):

- **ADR-083** (MCP transport security) — Accepted; fully implemented.
  `mcp-server/src/transport/auth-gate.ts` + `index.ts:207-295` wire all
  three modes; HTTP path enforces order origin→rate-limit→bearer-auth via
  `crypto.timingSafeEqual` over SHA-256; matches Decision verbatim. The
  only nit: ADR-083 prose / ADR-088 examples write `../../target/types/`
  (2 dirs) while shipped code uses `../../../target/types/` (3 dirs) — a
  cosmetic ADR-text inaccuracy, not an implementation drift.
- **ADR-115** (CI blocking gates) — Accepted; Status string honestly
  enumerates Stage 3a-2 / 3b as pending and CI matches: `ci.yml:59,98`
  clippy/cargo-audit blocking; `ci.yml:163-182` npm-audit /
  no-explicit-any still `continue-on-error: true`. Status accurately
  tracks partial delivery — good hygiene, not drift.
- **ADR-105/122** — Accepted; `runs-on:[self-hosted,linux]` throughout
  `ci.yml`; `mainnet-readiness.yml` exists. Consistent.
- **ADR-138** — Accepted; `programs/agent-vault/src/lib.rs:210,233`
  `tool_id_hash:[u8;32]` is a **required** positional arg (not
  `Option<…>`). No invariant inversion vs ADR-111 delegation.
- **ADR-139/111** — Accepted; `packages/reputation-attestor` (v0.1.0) and
  agent-vault delegation-grant state both present.
- **ADR-086** (AEAP→AEP rename) — fully consistent: zero residual
  `AEAP`/`aeap` in mcp-server/indexer/relay/sdk source; all 36 env vars
  use the `AEP_` prefix. Ubiquitous language clean.
- **ADR-133** (handlers-v2 deferral) — Accepted and accurate:
  `handlers-v2/vault.ts` (~441 LOC) + `keypair-signer.ts` present exactly
  as the Decision states; dual-path preserved per option (c).
- **ADR-137** (AI-ingestible docs) — Status **Proposed** is *correct*: the
  Revisions log explicitly explains why partial ship (`docs/public/llms.txt`
  committed + deployed in `docs/.vitepress/dist/`) does NOT flip the status
  until the load-bearing `CLAUDE.md` / `llms-full.txt` parts land. Model
  ADR hygiene — explicitly NOT a "proposed-but-shipped" gap.
- **ADR-045 / 054 / 055 / 056 / 057** — proper dispositioned stubs
  (Not Written / Superseded with backfill rationale). Numbering hygiene
  is sound; no silent gaps.

### F-08-04 — GAP (minor): ADR-088 superseded-in-spirit by Proposed ADR-141, no cross-link

- **Type:** gap (numbering/status linkage)
- **ADRs:** ADR-088 (Accepted, typed Anchor clients via `target/types/*`)
  vs ADR-141 (Proposed, Codama-generated clients to *replace* hand-written
  wrappers and, transitively, the `target/types` lifecycle ADR-099 §82
  flagged as "unresolved").
- **Evidence:** ADR-099:82 explicitly defers the "`target/types/*.ts`
  lifecycle question"; ADR-141 is the answer but neither ADR-088 nor
  ADR-099 carries a forward-link "Superseded-by / Resolved-by ADR-141",
  and ADR-141 stays Proposed while three contexts (mcp-server, sdk/client,
  + the indexer's hand decoder in F-08-02) depend on the unresolved
  artifact-coupling it would close.
- **Risk:** Low (documentation traceability). The unresolved
  `target/types` lifecycle is the shared root cause of F-08-02's blast
  radius; leaving it untracked across ADR-088/099/141 means the coupling
  has no owning decision.
- **Recommendation:** Add reciprocal "Related/Superseded-by" links among
  ADR-088 ↔ ADR-099 ↔ ADR-141; gate F-08-02's CI assertion on the same
  ADR-141 acceptance so the artifact-coupling closes once, everywhere.
- **ADR-needed?** No new ADR — cross-reference edits + ADR-141 status
  progression.

---

## Boundary-Leakage Summary (DDD)

| Context | Cross-context import surface | Verdict |
|---|---|---|
| mcp-server | `@agenomics/{action-runtime,capability-manifest-validator,sas-resolver}` (declared deps); type-only `target/types/*` (ADR-088) | Clean — sanctioned, compile-checked |
| sdk/client | `@agenomics/{client,idl,reputation-attestor}`; type-only `target/types/*` (ADR-088) | Clean |
| src/indexer | `@agenomics/reputation-attestor` (dynamic import, ESM-bridge); **hand-rolled on-chain layout** | **Leak — F-08-02** |
| src/x402-relay | `@solana/kit` + libs only; **no `@agenomics/*` cross-import** | Clean (best-isolated context) |
| dashboard | `@solana/web3.js`, UI libs only | Clean |

No deep relative cross-tree imports (`../../../..`) escaping any context
src root. No shared mutable singletons observed across context boundaries.
The single material DDD violation is the indexer's uncovenanted reach into
on-chain account internals (F-08-02).

---

## Summary (≤250 words)

The ADR corpus is in strong shape: numbering 001→141 is dense, stub/
superseded dispositions (045/054/055/056/057) are clean, and the
security-relevant Accepted ADRs largely match implementation. ADR-083
(MCP transport auth), 105/115/122 (CI gates), 138/139/111, and 086
(AEAP→AEP, zero residual) are all consistent; ADR-115 and ADR-137 model
*good* hygiene by encoding partial-delivery state honestly in their
Status fields (not drifts).

**Top security-relevant drift:** **F-08-01 — ADR-129 EVO adapter skew.**
ADR-129 is Accepted, but `evo-bridge.ts:350` `parseRetrievalResult` still
only parses `results`/`hits`+`entry.id` while real EVO emits
`memories`+`node_id`. The PR-165 fix is **not in this baseline**. The
kill-switch default-OFF is correctly implemented, so this is a
correctness/false-confidence issue, not an exploit: flipping
`AEP_EVO_ENABLED=true` yields a server that logs `evo_enabled` but whose
retrieval silently returns empty.

**Worst DDD boundary violation:** **F-08-02 — indexer ↔ on-chain layout.**
`src/indexer/reputation-attestor-wire.ts:115-238` hand-decodes
`AgentProfile` with offsets pinned to `programs/agent-registry/src/
state.rs:72-133` by *comment only* — no IDL, no compile-time tether, no
CI assertion. It matches today, but any non-padding-preserving registry
field reorder would make the indexer sign **wrong reputation values** into
ADR-139 portable attestations with a valid issuer signature. This is the
single highest-blast-radius coupling of the seven contexts and warrants a
new CI-asserted offset contract (F-08-02) plus ADR-088/099/141 linkage
(F-08-04). x402-relay is the best-isolated context (no `@agenomics/*`).

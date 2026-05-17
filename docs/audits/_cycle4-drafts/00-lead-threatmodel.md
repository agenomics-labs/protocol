# Cycle-4 LEAD System Threat Model — Cross-Context Trust Boundaries

- **Auditor role:** LEAD / coordinator (cross-context seams)
- **Baseline:** `audit-baseline` = origin/main `b8fe80b`
- **Scope:** trust boundaries BETWEEN bounded contexts (onchain ↔ indexer, mcp-server ↔ onchain tx authority, x402-relay ↔ settlement, SDK-generated-client). Deltas since cycle-3 (ADR-087/111/118/129/138/139/141).
- **Method:** READ-ONLY static review with file:line evidence. Cycle-3 punchlists treated as drained; closed findings not rediscovered.
- **Status:** DRAFT for cycle-4 corpus.

---

## 1. System Threat Model

### 1.1 Bounded contexts and trust direction

| Context | Role | Trusts | Trusted by |
|---|---|---|---|
| `programs/*` (onchain) | Authoritative state (Anchor) | nothing (root of trust) | everyone |
| `src/indexer` | Off-chain event log / REST projection | RPC log stream, program discriminators | dashboards, reputation reads |
| `mcp-server` | Agent tool surface → builds/submits tx | wallet caps, on-chain reads, IPFS, EVO | calling agents |
| `src/x402-relay` | Payment-gated access broker | on-chain tx finality, JWT secret | paying clients |
| `sdk/client` | Generated Anchor clients | supplied IDL + programId | SDK consumers |
| `packages/capability-manifest-validator` | Manifest integrity oracle | on-chain hash/sig commitment | reputation handler |

### 1.2 Trust-boundary map (seams audited)

- **S1 onchain → indexer:** program logs are consumed via `logsNotifications({mentions:[programId]})` + `getTransaction`. The indexer is the authoritative off-chain event log feeding reputation/telemetry.
- **S2 mcp-server → onchain:** capability-gated action wrapper decides whether a tool may build/submit a transaction.
- **S3 mcp-server → IPFS → reputation:** off-chain manifest fetched by CID, integrity bound to on-chain hash/sig.
- **S4 x402-relay → settlement:** payment proven by `getTransaction` balance-delta before access token issuance.
- **S5 SDK client → onchain:** generated client binds IDL to a supplied programId.
- **S6 mcp-server → EVO memory:** ADR-129 agent-memory similarity feed.

---

## 2. Cross-Context Trust-Boundary Findings

### CC-1 — HIGH — Indexer ingests events without program attribution (S1)

- **File:** `src/indexer/index.ts:1377` (`parseLogsForEvents`), caller `handleLogs` at `:2627` / `:2744`; subscription `:2696` (`mentions:[programId]`).
- **Evidence:** `parseLogsForEvents(logs, _programLabel)` — the program label is **unused** (`_`-prefixed). Event classification is by the 8-byte discriminator only (`DISCRIMINATOR_MAP[discriminator]`, `:1397`). `logsNotifications({mentions:[programId]})` returns logs for **every program in any transaction that mentions the subscribed program**, including `Program data:` lines emitted by *other* programs in the same transaction. There is no tracking of `Program <id> invoke [n]` / `Program <id> success` scope brackets to attribute a `Program data:` line to the emitting program.
- **Attack scenario:** An attacker deploys a program that emits a `Program data:` payload whose first 8 bytes equal a trusted discriminator (e.g. `EscrowSettled`, `ReputationDeltaProposed`, `ExecutionAttested`). They submit one transaction that (a) CPIs or references the real settlement/registry program (to satisfy `mentions`) and (b) calls their malicious program which emits the forged event. The indexer decodes and **persists the forged event** into the authoritative SQLite/PG store, corrupting reputation deltas, settlement state projections, and ADR-138 execution-provenance feeds consumed downstream.
- **Recommendation:** Track invoke/success bracket depth while scanning `logMessages`; only accept a `Program data:` line when the innermost active program frame equals the subscribed `PROGRAM_IDS[label]`. Reject (or quarantine to forensics-only) any discriminator hit attributed to a foreign program. Pass `programLabel` through instead of discarding it.

### CC-2 — HIGH — Indexer does not skip failed transactions (S1)

- **File:** `src/indexer/index.ts:2739-2744` — `notification.value.err` is destructured into the iterable type (`:2688`, `:2699`) but never inspected before `handleLogs(label, slot, signature, notification.value.logs)`.
- **Evidence:** Live-stream path calls `handleLogs` with logs from every notification regardless of `value.err`. `verifyPaymentOnChain` in x402-relay correctly rejects `tx.meta?.err` (`src/x402-relay/index.ts:441`); the indexer has no equivalent gate on the live path.
- **Attack scenario:** A transaction emits `Program data:` for a high-value event (e.g. `EscrowSettled`, `ReputationDeltaProposed`) and then intentionally aborts (failed instruction after the emit, or compute-budget exhaustion). Solana still returns the pre-abort log lines in the notification. The indexer persists an event for a transaction that **never committed on-chain**, diverging the off-chain authoritative log from chain state. Combined with CC-1 this is a cheap, deterministic state-forgery primitive.
- **Recommendation:** On both live (`handleLogs`) and backfill paths, drop the transaction entirely when `notification.value.err != null` / `tx.meta.err != null`. (Backfill at `:2524` uses `tx.meta?.logMessages` but never checks `tx.meta.err` either — same gap.)

### CC-3 — MED — Capability-gate `readOnly` skip is an unguarded design footgun (S2)

- **File:** `mcp-server/src/adapters/capability-gated-tool.ts:32-36` (registration guard), `:57` (`if (!action.readOnly)` capability skip). Live workaround documented at `mcp-server/src/actions/registry.ts:181-186, 226-229`.
- **Evidence/triage of seed (2):** This is **not a runtime logic inversion** — `readOnly` is a statically declared per-action constant (e.g. `actions/settlement.ts:59,186`), not attacker-controllable. The capability skip on `readOnly:true` is intentional per ADR-058 §4. **However**, the registration-time guard only rejects the `!readOnly && capabilities.length===0` shape; it does **not** reject `readOnly:true` declared together with a non-empty `capabilities[]`. The codebase authors had to discover this coupling by trial and deliberately declare a sensitive read action as `readOnly:false` (registry.ts comment: *"we just declare readOnly:false to make the gate fire"*) to get `read:agent-memory` enforced. Any future author who marks a sensitive read `readOnly:true` silently disables ALL claim enforcement for that tool with zero guardrail or test failure.
- **Attack scenario:** A new read action exposing private agent/vault data is added with `readOnly:true` (the natural choice for a read). The capability gate (`:57`) skips the claim check; unauthenticated/under-privileged callers read data that `read:agent-memory`-class claims were meant to gate. No registration error, no test trips.
- **Recommendation:** Make the registration guard reject `readOnly:true && capabilities.length>0` with a message pointing to the correct pattern, OR decouple claim enforcement from `readOnly` (introduce an explicit `enforceCapabilities` flag). Add a lint/test asserting every action that touches private data declares non-empty `capabilities[]`.

### CC-4 — MED — Unbounded/untimed IPFS gateway fetch (S3, SSRF + DoS)

- **File:** `mcp-server/src/handlers/reputation.ts:185-211` (`fetchManifestFromIpfs`), called at `:391`.
- **Evidence/triage of seed (3):** The seed described this as an *"unvalidated IPFS manifest fetch"* — that part is **largely false**: content integrity IS bound. `validateManifest` (`packages/capability-manifest-validator/src/validate.ts:125` hash check, `:146` ed25519 verify against `authorityPubkey`) rejects any body that does not match the on-chain `manifest_hash` + `manifest_signature`. Residual real risk: (a) **SSRF** — `AEP_IPFS_GATEWAY` is operator-controlled (lower severity) but the CID is attacker-controlled and path-injected into `${base}/ipfs/${encodeURIComponent(cid)}` against a default public gateway; (b) **DoS** — `await fetch(url)` then `resp.arrayBuffer()` with **no timeout, no `Content-Length`/size cap, no content-type check** (`:192,:198`). A malicious CID resolvable on the public gateway can stream an unbounded body and exhaust memory before validation ever runs.
- **Attack scenario:** Attacker registers an AgentProfile whose `manifest_cid` points at a multi-GB object pinned on a public gateway. A `get_agent_reputation` call streams the whole body into a `Uint8Array` (`:198`) before `validateManifest` runs, OOM-ing the mcp-server.
- **Recommendation:** Add an `AbortController` timeout, a hard byte cap on the response (stream + early abort over limit), and reject non-JSON content types before buffering. Downgrade seed (3) from "unvalidated fetch" to "resource-exhaustion on pre-validation fetch".

### CC-5 — MED — `isValidPublicKey` is syntactic-only; caller-supplied addresses not PDA-bound (S2)

- **File:** `mcp-server/src/solana.ts:392-409` (`isValidPublicKey`/`parsePublicKey`); call sites e.g. `actions/vault.ts:324`, `handlers/vault.ts:154`.
- **Evidence/triage of seed (4):** Confirmed partially. `isValidPublicKey` only asserts `new PublicKey(key)` does not throw — it accepts any 32-byte base58 value, **including off-curve points**, and performs no derivation/ownership check. Caller-supplied "vault address" / "escrow address" arguments are validated for *syntax* only, never re-derived from expected seeds+program to confirm they are the legitimate PDA for the calling authority.
- **Attack scenario:** A tool argument that accepts a vault/escrow address is passed an attacker-chosen but syntactically-valid address. Downstream read/build logic operates against the wrong account; in build paths that do not independently re-derive the PDA this can mis-target a transaction or leak another agent's vault state.
- **Recommendation:** Where an address argument is conceptually a PDA, re-derive it from authority + program seeds and assert equality (the project already has `deriveVaultPDA`, `deriveAgentProfilePDA`). Treat `isValidPublicKey` as a syntax gate only and document that it is not an authorization check.

### CC-6 — INFO — `.claude/helpers/github-safe.js` does not exist at baseline (seed 1)

- **Evidence:** `find . -name github-safe.js -not -path ./node_modules/*` → no result on `audit-baseline`. No workflow/script references it (`grep -rn github-safe` over yml/sh/js/json → none). `.claude/helpers/` contains only `statusline.cjs`.
- **Triage:** Seed (1) HIGH command-injection is **not present in the audited baseline**. Either already removed/never landed on this branch, or it lives in a tooling branch outside scope. **No finding for cycle-4 corpus**; flag to confirm provenance with whoever surfaced it.

### CC-7 — INFO — SDK programId binding is sound; EVO adapter skew resolved

- **Evidence:** `sdk/client/registry.ts:120`, `vault.ts:292`, `settlement.ts:56` all enforce `IDL.programId === suppliedProgramId` and throw on mismatch — S5 trust seam is correctly closed (ADR-141/ADR-119). The prior-known ADR-129 EVO adapter skew (parseRetrievalResult expecting `result.results`/`entry.id` vs real `result.memories`/`node_id`) is **fixed**: `mcp-server/src/adapters/evo-bridge.ts:360-385` now accepts `memories`/`node_id` plus legacy shapes. S6 is read-only, gated by `read:agent-memory`, kill-switched by `AEP_EVO_ENABLED` (default off) — EVO output never influences tx authority. No finding.

### CC-8 — INFO — x402 payment verification robust; one minor seam (S4)

- **Evidence:** `verifyPaymentOnChain` (`src/x402-relay/index.ts:423-495`) uses `finalized` commitment, rejects `tx.meta.err`, validates recipient presence, checks recipient balance-delta ≥ min, and replay is covered by signature dedup (Finding #16/AUD-208, Redis dual-write ADR-126). Minor residual: payment is proven by net recipient balance-delta, not bound to the System/settlement program nor to a specific escrow/order id — accepted given signature single-use dedup. **INFO only**, no new ADR.

---

## 3. Consolidated Cross-Cutting Risk Ranking

| # | Finding | Severity | Context seam | Systemic theme |
|---|---|---|---|---|
| 1 | CC-1 indexer event has no program attribution | **HIGH** | onchain→indexer | Off-chain authoritative log accepts unauthenticated input |
| 2 | CC-2 indexer ingests failed-tx logs | **HIGH** | onchain→indexer | Same; compounding primitive with CC-1 |
| 3 | CC-3 `readOnly` capability-skip footgun | **MED** | agent→mcp→onchain | Default-deny weakened by an undocumented coupling |
| 4 | CC-4 unbounded/untimed IPFS fetch | **MED** | mcp→IPFS | Resource exhaustion on a pre-validation boundary |
| 5 | CC-5 syntactic-only pubkey validation | **MED** | agent→mcp→onchain | Validation ≠ authorization at the system boundary |
| 6 | CC-6 github-safe.js | INFO | tooling | Not in baseline — provenance check |
| 7 | CC-7 / CC-8 | INFO | sdk / x402 | Seams verified sound |

**Top systemic theme:** the onchain→indexer seam (CC-1 + CC-2) is the single highest-leverage weakness — the indexer is treated as authoritative by reputation, settlement projections, and ADR-138 provenance, yet it accepts log input without authenticating the emitting program or confirming the transaction committed. CC-1 and CC-2 chained give a cheap, deterministic event-forgery primitive that poisons every downstream consumer.

---

## 4. Findings Warranting New Remediation ADRs (ADR-142+)

| Proposed ADR | Covers | Why an ADR (not just a fix) |
|---|---|---|
| **ADR-142 — Indexer log provenance & finality gate** | CC-1 + CC-2 | Changes the indexer's core trust model (program-scoped log attribution + failed-tx rejection on live & backfill paths). Cross-cuts ADR-118 concurrency and ADR-127 backfill — needs a decision record + byte-layout / scope-bracket parsing spec and regression pins. |
| **ADR-143 — Capability enforcement decoupled from `readOnly`** | CC-3 | Alters the ADR-058 default-deny contract surface. Must supersede/amend ADR-058 §4 and define the `readOnly` vs `enforceCapabilities` semantics + registration guard. |
| **ADR-144 — Bounded external resource fetch policy** | CC-4 (and any future off-chain fetch) | Establishes a protocol-wide policy (timeout, size cap, content-type allowlist, SSRF posture) for all outbound fetches crossing the mcp-server boundary; reusable beyond reputation. |

CC-5 should be remediated under the **existing** ADR-069/AUD-015 address-validation lineage (extend, no new ADR). CC-6/CC-7/CC-8 need no ADR.

---

*End of LEAD draft. File:line evidence verified against `audit-baseline` (b8fe80b). No code modified.*

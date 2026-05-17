# Architecture Re-Audit 2026-05c — Cycle-4 Security-First

**Date:** 2026-05-17 · **Baseline:** `origin/main` b8fe80b (5/6 pristine cascade merged)
**Method:** 9-agent parallel security swarm (hierarchical, specialized). Per-context drafts: `docs/audits/_cycle4-drafts/00..08`.
**Prior state:** Cycle-3 punchlists drained — verified intact, no regressions. This cycle = delta since cycle-3 + security-first lens.

## Executive verdict

ADR-139 on-chain trust root, capability validators, secret scanning, IDL↔program parity, and all cycle-3 hardening are **sound and intact**. The serious findings cluster in **two payment/bridge fund paths** and the **indexer trust boundary**.

| Severity | Count |
|---|---|
| CRITICAL | 2 |
| HIGH | 10 |
| MEDIUM | ~16 |
| LOW/INFO | ~12 |

## P0 — CRITICAL (fund-loss, fix before any release)

| ID | Location | Issue |
|---|---|---|
| **C4-X402-01** | `src/x402-relay/index.ts:447-481` | `verifyPaymentOnChain` checks only recipient net balance delta; never decodes transfer instr, never binds on-chain payer↔HTTP caller; `txSignature` is unauthenticated. Replay any finalized sig where recipient balance rose ≥ threshold → mint valid JWT. Replay hardening (AUD-208/209/ADR-126) defends a primitive that doesn't verify payment. |
| **C4-OB-01** | `programs/cctp-hook/src/lib.rs:113-304` | `auto_approve_milestone` consumes **no** Circle CCTP message/attestation/nonce; token accounts unconstrained `UncheckedAccount`. Any signer fabricates payload → releases milestone funds with no proof of CCTP round-trip. |

## P1 — HIGH (integrity / state-forgery / conformance)

| ID | Location | Issue | Interlock |
|---|---|---|---|
| **CC-1+CC-2** | `src/indexer/index.ts:1377,2744,2524` | Events classified by 8-byte discriminator only (program attribution dropped) + failed-tx logs not skipped → discriminator-collision state forgery into authoritative store | → ADR-142 |
| **C4-OFF-01** | `src/indexer/index.ts:669-674` | `BorshReader.string()` reads untrusted u32 len, `subarray` clamps silently → offset desync (AUD-004 mode now generic to any String event) + multi-GiB alloc DoS | decoder hardening |
| **C4-OFF-03** | `src/indexer/index.ts:3530,2310-2389` | ADR-118 `gracefulShutdown`/`persistEventsForTx` non-atomic on SIGTERM → replay + cursor/projection divergence; "between batches" guarantee is prose-only | ADR-118 amend |
| **C4-OB-02** | `programs/settlement/src/instructions/escrow.rs:741-743` | `close_escrow` is `Ok(())` no-op; context omits token account → strands residual ATA, bricks deterministic escrow slot |  |
| **C4-OB-03** | `escrow.rs:520-543` | `expire_escrow` permissionless + slashes provider reputation → censorship-grief (inverse of hardened C1) |  |
| **OA-HIGH-1** | `programs/agent-vault/src/instructions.rs:1515,1668` | ADR-111 grant transfers emit only `DelegationGrantExecuted`, never `ExecutionAttested` (ADR-138 mandates it; ActionKinds reserved) → grant-authorised drains invisible to provenance/SAS/reputation | ↔ C4-OB-04, F-08-02 |
| **F-08-02** | `src/indexer/reputation-attestor-wire.ts:115-238` | Hand-decodes `AgentProfile` by comment-pinned byte offsets to `agent-registry/src/state.rs:72-133` — no IDL/CI tether. Registry reorder → indexer signs WRONG reputation into ADR-139 attestations w/ valid signature. Highest blast radius. | ↔ OA-LOW-3 |
| **C4-X402-02** | `src/x402-relay/index.ts:1031-1043` | ADR-117 status inversion: all failures incl. RPC_UNAVAILABLE return HTTP 402 → induces honest double-spend | ADR-117 amend |
| **C4-X402-03** | `src/x402-relay/index.ts:736` | Unbounded `txSignature` (no json limit / base58 check) → ~10GB mem + log amplification |  |
| **SDK-F1** | `sdk/idl/src/index.ts:9-25` | `getProgramIds("mainnet-beta")` silently returns devnet placeholders → prod txns vs non-governance upgrade authority (AUD-207, README-only) |  |

## P2 — MEDIUM (selected; full detail in drafts)

CC-3 `readOnly:true`+sensitive-data capability footgun (→ADR-143) · C4-MCPEVO-001 unbounded IPFS fetch DoS (→ADR-144) · CC-5/C4-MCPEVO-002 syntactic-only pubkey validation, no PDA re-derivation · C4-OFF-04 PG no TLS/least-priv · C4-OB-04 settlement no suspension-gate before reputation CPI (↔OA-HIGH-1) · C4-OB-06 dispute-timeout no Submitted-milestone reconciliation · OA-MED-1 suspension-gate authority binding transitive-only · OA-MED-2 grant-transfer omits program_allowlist intersection · W-01 dashboard zero prod security headers · W-04 unvalidated VITE_* URLs · SDK-F2 codama seed-parity gap · SDK-F3 action-runtime no input validation + error/stack leak.

## New ADR slate

| ADR | Scope | Source |
|---|---|---|
| **ADR-142** | Indexer log provenance + finality gate | CC-1, CC-2 |
| **ADR-143** | Decouple capability enforcement from `readOnly` (amends ADR-058 §4) | CC-3 |
| **ADR-144** | Bounded external-fetch policy (timeout/size/CID) | CC-4 / C4-MCPEVO-001 |
| **ADR-111b / ADR-095 addendum** | Suspension-gate authority binding | OA-MED-1 |

Conformance fixes (no new ADR): OA-HIGH-1, OA-MED-2, C4-X402-01/02/03, C4-OB-01/02/03, F-08-02 (CI layout-parity assertion).

## Verified sound (do not re-litigate)

ADR-139 monotone invariants (`slash_count`/`registration_nonce`/`authority`) · IDL↔program↔fresh-build byte-identical, CI-gated · `capability-manifest-validator` + `sas-resolver` cryptographically sound · TruffleHog full-history secret scan · EVO subprocess clean (no cmd-injection) · cycle-3 closures (C1/C2/C3, AUD-009/024/102/117/201/202/208/209, OFF-201/203/205/206/211, ADR-126 Phase 1) intact at HEAD.

## Corrections to prior records

- Seed "github-safe.js command injection" — **not present in baseline** (no file/refs); INFO/provenance only.
- Seed "capability-gating runtime inversion" — **false positive**; `:24` is an interface field, real gate `:57` is correct default-deny. Real (lesser) issue captured as CC-3.
- Seed "IPFS unvalidated" — integrity **is** cryptographically bound; real risk is unbounded-fetch DoS only (CC-4).
- "5 deferred Dependabot alerts" memory — **stale; actually 3** (31 total, 28 `fixed`; remaining: bigint-buffer dismissed-tolerable, rand×2 low).
- F-08-01 ADR-129 EVO skew — **resolved by PR #165** (in-flight cascade), not net-new debt.

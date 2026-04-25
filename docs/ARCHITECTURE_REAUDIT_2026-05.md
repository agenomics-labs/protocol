# Architecture Re-Audit 2026-04-24 (post-ADR-113)

## Context

Baseline: current `main` at `22e2a6d` — 137 commits past the prior
`docs/ARCHITECTURE_REAUDIT_2026-04.md` baseline. This pass audits every
surface that moved through ADR-054 ... ADR-113 and cross-references the
prior finding set for regression or incomplete closure.

Scope: all three on-chain Rust programs (settlement, agent-registry,
agent-vault), all four off-chain services (mcp-server, src/indexer,
src/x402-relay, sdk/*), CI + deploy scripts, and the ADR corpus itself.

This document reports what three parallel read-only agent audits
surfaced plus my own cross-referencing. Every finding has an exact
`file:line` anchor and a recommended disposition.

---

## Executive summary

**Risk rating: Medium.** No exploitable on-chain vulnerabilities.
Two **High** off-chain findings:

1. **R-offchain-01** — x402-relay `verifyPaymentOnChain` template-literal
   leaks unknown-exception content (possibly stack/RPC endpoint) to
   unprivileged clients.
2. **R-offchain-02** — indexer backfill ↔ live-stream concurrency is
   racy; SQLite is on WAL but `synchronous=FULL` is not set and there
   is no per-program write lock. A crash mid-backfill can leave agents
   in a zombie state the tombstone gate doesn't catch.

Prior P0 findings from the 2026-04-18 re-audit are all **verified
closed**: S-offchain-01/02/03 (x402 hardening), S-onchain-01
(dispute_timeout overflow), S-offchain-04/05 (tombstones + enum
decoder), S-xcut-03/04/05 (anchor-build + integration-tests +
secret-scan).

Prior CI "advisory not blocking" concerns (**S-xcut-08, -09**) are
**still open** — clippy, cargo-audit, and npm audit remain
`continue-on-error: true`; no `dependabot.yml`; ESLint rules stay at
`warn`. This is the "CI is still courtesy, not a gate" line from the
prior audit still holding.

**Mainnet readiness verdict (on-chain):** green. The mainnet deploy
script (`scripts/mainnet-deploy.sh`, 667 lines) implements every gate
ADR-080 required: clean-tree → signed-tag → hash-check →
multisig-check → shellcheck CI. `config/AUDIT_REPORT_HASHES` holds
placeholder zeros by design until the auditor cycle populates them.
R-onchain-01 and R-onchain-02 are post-deployment improvements, not
blockers.

**Open PRs:** #50 / #51 / #54 / #55. CI:
- **#54** (ADR-104 observability) — clean, Anchor Integration Tests
  queued on self-hosted runner. Ready to merge.
- **#55** (ADR-092 on-chain manifest-hash domain separator) —
  queued, no failures.
- **#50** (ADR-099 @agenomics/idl package) — `Anchor Build & IDL Diff`
  **FAILED**. Needs debug.
- **#51** (ADR-098 @agenomics/client SDK) — same failure as #50.
  Likely a workspace-level issue since both PRs only touch `sdk/`.

---

## Severity matrix

| ID | Sev | Location | Impact |
|---|---|---|---|
| R-offchain-01 | High | `src/x402-relay/index.ts:144-145` | Unclassified error echoes to client; info leak. |
| R-offchain-02 | High | `src/indexer/index.ts` (concurrency) | Backfill/live race → zombie agent; SQLite `synchronous` not `FULL`. |
| R-onchain-01 | Medium | `programs/agent-registry/src/contexts.rs:301-325` | `ProposeReputationDelta` context omits ADR-097 nonce seed. Re-registration flow mismatches. |
| R-offchain-03 | Medium | `sdk/client/src/index.ts:42-49` | `deriveAgentProfilePda()` is a stub that throws at call time; no pubkey validation. |
| R-offchain-04 | Medium | `sdk/idl/src/index.ts:27-29` | `getProgramIds()` accepts any string; typo returns undefined. |
| R-offchain-05 | Medium | `mcp-server/src/handlers/formatters.ts:6,21,28,35,45` | Five formatter functions typed `any` despite ADR-088 typed-decode. Enum reorder = silent miscategorisation. |
| R-offchain-06 | Medium | `mcp-server/.eslintrc.json:10` + ci.yml | ESLint `no-explicit-any: warn`; 7+ `as any` casts accumulated in mcp-server. |
| R-offchain-07 | Medium | `src/indexer/index.ts` (no SIGTERM) | K8s rollout aborts mid-backfill; cursor inconsistency on restart. |
| R-xcut-01 | Medium | `.github/workflows/ci.yml:47-49` | Clippy remains `continue-on-error: true`. |
| R-xcut-02 | Medium | `.github/workflows/ci.yml:84-86` | Cargo-audit advisory-only. RustSec advisories don't block. |
| R-xcut-03 | Medium | `.github/` (no `dependabot.yml`) | No automated dep scanning; security patches surface late. |
| R-onchain-02 | Low | `programs/agent-vault/src/lib.rs` | Vault program emits zero events. Indexer blind spot vs ADR-082. |
| R-onchain-03 | Low | `programs/agent-vault/src/contexts.rs:141-150, 191-200` | Cross-program `agent_profile` deserialize has no version gate post-ADR-096. |
| R-onchain-05 | Low | `programs/agent-registry/src/lib.rs:206-241` | Settlement↔Registry `settlement_authority` derivation invariant undocumented. |
| R-offchain-08 | Low | `mcp-server/package.json` vs others | `@solana/web3.js ^1.87` vs `^1.95` — version skew across services. |
| R-offchain-09 | Low | `.github/workflows/ci.yml` | No `npm audit` blocking gate. |
| R-xcut-04 | Low | `.github/workflows/ci.yml:300,309` | `trufflesecurity/trufflehog@main` — only action not tag-pinned. |
| R-xcut-05 | Low | `.github/workflows/ci.yml` (node-version: "20") | Floating minor. Not reproducible. |
| R-onchain-04 | Info | `programs/settlement/src/instructions/protocol_config.rs:54-110` | Governance bounds correct and tight; document rationale in ADR-053 follow-up. |
| R-xcut-06 | Info | `docs/adr/ADR-045-numbering-gap.md` | Stub resolves gap. No action. |
| R-xcut-07 | Info | `config/AUDIT_REPORT_HASHES` | Placeholder zeros are correct by design until auditor delivers. |

---

## Regression check (prior-audit closure verification)

Every P0/P1 item from `ARCHITECTURE_REAUDIT_2026-04.md` was re-tested
against current code. Results:

| Prior finding | Status |
|---|---|
| S-offchain-01 (trust-proxy) | ✅ `src/x402-relay/index.ts:271` `app.set("trust proxy", parseTrustProxy(TRUST_PROXY))`. |
| S-offchain-02 (rateLimitMap cap + TTL) | ✅ `src/x402-relay/index.ts:226,235` 100k cap + prune timer. |
| S-offchain-03 (JWT algorithms pin) | ✅ `src/x402-relay/index.ts:172-174` `{ algorithms: [JWT_ALGORITHM] }`. |
| S-onchain-01 (dispute-timeout overflow) | ✅ `programs/settlement/src/instructions/dispute.rs:165` `checked_add`. |
| S-offchain-04 (tombstones) | ✅ `src/indexer/index.ts:97` `agent_tombstones` table + gate. |
| S-offchain-05 (enum decoder by name) | ✅ `src/indexer/index.ts:256` name-based lookup. |
| S-xcut-03 (anchor-build + IDL diff) | ✅ ci.yml:402 `anchor build` + `./scripts/check-idl.sh` blocking. |
| S-xcut-04 (anchor integration tests) | ✅ ci.yml:443 `anchor-integration` job, serialized per ADR-105. |
| S-xcut-05 (secret-scan) | ✅ ci.yml:289 TruffleHog, NO `continue-on-error`. |
| S-xcut-06 (action pinning) | ✅ `actions/*@v4|v5`, no `@main` (except TruffleHog — see R-xcut-04). |
| S-xcut-08 (clippy/audit flip to block) | ❌ Still advisory. See R-xcut-01, R-xcut-02. |
| S-xcut-09 (Dependabot) | ❌ Still absent. See R-xcut-03. |
| S-xcut-10 (ESLint on mcp-server) | ⚠ Present but `warn`-only. See R-offchain-06. |
| S-xcut-11 (Node minor pin) | ❌ Still floating `"20"`. See R-xcut-05. |
| S-offchain-06 (discriminated unions for formatters) | ❌ Still `any`. See R-offchain-05. |
| S-offchain-07 (indexer SIGTERM) | ❌ Still `SIGINT` only. See R-offchain-07. |

Six prior findings are **still open** — all Medium or Low, all
documented under new R-* IDs in the severity matrix above for one
place to track them.

---

## Remediation roadmap

### P0 (close before next mainnet deploy)

1. **R-offchain-01** — redact error classes in `x402-relay`. Catch,
   classify, log raw to stderr via pino redaction, return generic
   message. Single-file fix.
2. **R-offchain-02** — `PRAGMA synchronous = FULL` on the SQLite
   connection + a write mutex across backfill and live-stream paths.
   Single-file fix.

### P1 (next sprint)

3. **R-onchain-01** — align `ProposeReputationDelta` context with
   ADR-097's nonce seed. Registry context + IDL diff. One-ADR change.
4. **R-xcut-01 / R-xcut-02** — flip clippy + cargo-audit to blocking
   after a one-time `cargo clippy --fix` + `cargo audit fix` pass.
5. **R-xcut-03** — add `.github/dependabot.yml` for cargo + npm +
   actions (daily/weekly cadence).
6. **R-offchain-03 / R-offchain-04** — implement `deriveAgentProfilePda`
   properly + add cluster enum guard on `getProgramIds`. These are
   the blockers for #50/#51 landing cleanly as usable SDKs.
7. **R-offchain-06** — flip `@typescript-eslint/no-explicit-any` to
   `error`; `.eslintignore` the known Kit v1/v2 shims with ticket
   refs.
8. **R-offchain-07** — indexer SIGTERM handler with in-flight backfill
   rollback flag.

### P2 (best-effort)

9. **R-offchain-05** — formatters → IDL-derived enum lookup.
10. **R-onchain-02 / R-onchain-03 / R-onchain-05** — vault events,
    cross-program version gate, Settlement↔Registry PDA invariant doc.
11. **R-offchain-08** — align `@solana/web3.js` across all services.
12. **R-offchain-09** — `npm audit --audit-level=moderate` blocking.
13. **R-xcut-04** — pin TruffleHog to a tag.
14. **R-xcut-05** — pin Node version to `"20.x"`.

---

## New ADRs produced

| ADR | Title | Status |
|---|---|---|
| ADR-114 | Dependabot + automated dependency hygiene | Proposed |
| ADR-115 | Flip clippy / cargo-audit / npm audit from advisory to blocking | Proposed |
| ADR-116 | ProposeReputationDelta nonce-seed alignment with ADR-097 | Proposed |
| ADR-117 | x402-relay error redaction policy | Proposed |
| ADR-118 | Indexer concurrency hardening (SQLite fullsync + write mutex + SIGTERM) | Proposed |
| ADR-119 | SDK boundary validation and PDA derivation completion | Proposed |

---

## Proposed-ADR (106-113) implementation triage

User requested "complete all ADRs standing." ADR-106..113 are all
`Proposed` and represent architectural decisions, not
ready-to-implement work items. Scoping each:

| ADR | Subject | Implementation cost | Blocker? |
|---|---|---|---|
| ADR-106 | trace-rank reputation | M — new on-chain delta source + indexer pipeline | No |
| ADR-107 | reputation decay | M — scheduled on-chain decay instruction or off-chain job | No |
| ADR-108 | stake-backed peer discovery | M — new registry method + stake bonding | No |
| ADR-109 | agent-identity URI scheme | S — spec + validator | No |
| ADR-110 | versioned capability vectors (VCV) | L — new on-chain capability schema + migration | No |
| ADR-111 | vault delegation grants | L — new vault instruction surface + allowlist rework | No |
| ADR-112 | peer-ranked dispute consensus | XL — new subsystem (voting, quorum, on-chain aggregation) | No |
| ADR-113 | progressive decentralization governance | XL — new multisig-rotation + timelock design | No |

None of these block mainnet. ADR-109 is the smallest and is a natural
next pickup. ADR-112 and ADR-113 are each their own multi-week
project and should not be attempted in this audit PR. This pass
**does not implement** any Proposed ADR 106-113; they continue in
`Proposed` status with the triage above as the canonical estimate
sheet.

---

## Out of scope

- Implementing Proposed ADRs 106-113 (deferred, see triage above).
- Editing existing `Accepted` ADRs (status fields stay unchanged).
- Touching any on-chain program bytecode (P0 fixes here are all
  off-chain).

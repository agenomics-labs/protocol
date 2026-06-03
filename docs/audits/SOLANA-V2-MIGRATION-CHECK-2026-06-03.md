# Solana v2 Migration Check — 2026-06-03

**Verdict: wait another 4–6 weeks** — neither Anchor Kit-native client nor `@solana-program/token` 1.0 exists yet; one new Dependabot alert surfaced and was resolved since the baseline (trigger c fired).

> Scheduled check for agent trigger `trig_01GkKKZQd39rY2Z7w7tmmYou` per ADR-133 §"Re-evaluation triggers" / `docs/audits/CYCLE-3-MCP-PUNCHLIST.md` §"Handlers v1/v2 status".  
> Baseline date: 2026-04-28 (commits f0efc00..358833d, MCP-300..322 closed).

---

## 1. @coral-xyz/anchor / @anchor-lang/core

| Field | npm `@coral-xyz/anchor` | npm `@anchor-lang/core` |
|---|---|---|
| Latest version | **0.32.1** | **1.0.2** |
| Published | 2025-10-10 | 2026-05-02 |
| `@solana/web3.js` dep | `^1.69.0` — **present** | `^1.69.0` — **present** |
| `@solana/kit` dep | absent | absent |
| Peer deps | none | none |
| Canonical going forward? | No — abandoned at 0.32.1 | **Yes** — Solana Foundation took ownership |

**Key observations:**

- Anchor v1.0.0 (released 2026-04-02) **renamed** the TypeScript package from `@coral-xyz/anchor` to `@anchor-lang/core`. The old npm name is now a tombstone; it will receive no further updates.
- Despite the `1.0.0` semver bump and repo transfer to `solana-foundation/anchor`, `@anchor-lang/core` v1.0.2 still ships `"@solana/web3.js": "^1.69.0"` as a hard dependency. **No `@solana/kit` support.**
- GitHub releases show v1.0.0 (2026-04-02), v1.0.1 (2026-04-21), v1.0.2 (2026-05-02). No v2.x branch, no Kit-migration PRs in the public changelog.
- ADR-133 trigger **(a)** — "Anchor drops `@solana/web3.js` v1 OR adds `@solana/kit` support" — **NOT fired**.
- Our `mcp-server/package.json` pins `@coral-xyz/anchor: ^0.31.1` (below even the abandoned 0.32.1). No `@anchor-lang/core` entry yet. Phase B migration remains fully blocked.

**Action advisory (not a trigger, informational):** The `@coral-xyz/anchor` npm package should be treated as end-of-life. Any new work that needs to reference the Anchor TypeScript client should use `@anchor-lang/core`. This is a rename-only change for now — it doesn't unblock Phase B since the Kit dependency is still absent — but keeping `mcp-server/package.json` pinned to the abandoned name is technical debt to schedule.

---

## 2. @solana-program/token

| Field | Value |
|---|---|
| Latest version | **0.13.0** |
| Published | 2026-04-01 |
| Status | Pre-1.0, active development |
| Peer dependency | `@solana/kit: "^6.5.0"` |
| @solana/kit current | v6.9.0 (2026-05-06) |
| 1.0.0+ stable reached? | **No** |
| Legacy `@solana/spl-token` 0.4.x deprecated? | No deprecation notice detected |

**Key observations:**

- `@solana-program/token` v0.13.0 is the latest (April 1, 2026). The package is advancing (earlier versions were <0.10.x) but remains firmly pre-1.0.
- `@solana/kit` itself is at v6.9.0 (May 6, 2026) — actively maintained and stable at the 6.x minor line.
- Our codebase already pins `@solana/kit: 6.9.0` in `mcp-server/package.json` (recent Dependabot bump from 6.8 via PR #128). The `@solana-program/system: 0.12.0` and `@solana-program/compute-budget: ^0.15.0` are in use via the v2 vault handler.
- ADR-133 trigger **(b)** — "`@solana-program/token` ≥ 1.0.0" — **NOT fired**.
- Phase C (migrate `@solana/spl-token` consumers to `@solana-program/token`) and Phase D (`@solana/spl-token` removal / `bigint-buffer` CVE closure) remain blocked.

---

## 3. Dependabot Alert Delta

Direct `gh api` query was unavailable in this execution environment. Alert state is fully reconstructed from merged PR evidence and audit docs.

### Baseline — 2026-04-28 (5 alerts)

| # | Package | Eco | Severity | First-patched | Baseline state |
|---|---|---|---|---|---|
| 1 | `bigint-buffer` | npm | HIGH | no-fix | open |
| 2 | `diff` | npm | LOW | 8.0.3 | open |
| 5 | `uuid` | npm | MEDIUM | 14.0.0 | open |
| 6 | `rand` | cargo | LOW | 0.8.6 | open |
| 7 | `rand` (fuzz) | cargo | LOW | 0.8.6 | open |

*(Alert numbering matches GitHub's assigned IDs per `DEPENDABOT-2-CLOSURE-CHECK.md`.)*

### Post-baseline events (2026-04-28 → 2026-06-03)

| Date | Event | Evidence |
|---|---|---|
| 2026-04-30 | Alert #2 (`diff`) closed — override `diff: ">=8.0.3"` applied to root + mcp-server `package.json` | `DEPENDABOT-2-CLOSURE-CHECK.md`; fix commit `6e414b3` |
| 2026-05-06 | Alert #5 (`uuid`) closed — version-targeted override `"uuid@>=11.0.0 <11.1.1": ">=11.1.1"` | `DEPENDABOT-3-UUID-IPADDR-CLOSURE.md`; fix commit `dc195d3`-era |
| 2026-05-06 | **NEW alert** — `ip-address` MODERATE (GHSA-v2v4-37r5-5v8g) via `@modelcontextprotocol/sdk → express-rate-limit → ip-address@10.1.0` — **closed same day** via nested override | `DEPENDABOT-3-UUID-IPADDR-CLOSURE.md` |
| 2026-05-18 | Alert #1 (`bigint-buffer`) **dismissed** — rationale: dev-only path (`@sqds/multisig → @solana/spl-token`); production `npm audit --omit=dev` clean; tied to ADR-115 Stage 3b / ADR-087 Phase D | PR #180 body; `SECURITY_AUDIT.md §9` |

### Current state (inferred, June 3, 2026)

| Alert | Severity | Status | Notes |
|---|---|---|---|
| #1 `bigint-buffer` | HIGH | **Dismissed** (manual, May 18) | Dev-only transitive; bigint-buffer still has no non-vulnerable release; elimination gated on Phase D |
| #2 `diff` | LOW | **Closed** (fixed, Apr 30) | Override in place |
| #5 `uuid` | MEDIUM | **Closed** (fixed, May 6) | Version-targeted override; `uuid@8.3.2` under `jayson` untouched |
| `ip-address` | MEDIUM | **Closed** (fixed, May 6) | Nested `express-rate-limit → ip-address` override; **NEW vs baseline** |
| #6 `rand` | LOW | **Open** (waiver) | Locked by `anchor-lang@0.31.1` / `solana-program@2.3.0`; cargo |
| #7 `rand` (fuzz) | LOW | **Open** (waiver) | Mirror of #6 |

**Net change vs baseline:**
- Cleared with our action: diff (override), uuid (override), bigint-buffer (manual dismiss)
- Cleared without our action: none detected
- New alerts appeared: **ip-address MEDIUM** (surfaced May 6, closed May 6)
- Unchanged: rand ×2 LOW (cargo, accepted waivers)

### Trigger evaluation

| Trigger | Fired? | Rationale |
|---|---|---|
| **(a)** Anchor drops web3.js v1 OR adds @solana/kit | **No** | `@anchor-lang/core` v1.0.2 still on `@solana/web3.js: "^1.69.0"` |
| **(b)** `@solana-program/token` ≥ 1.0.0 | **No** | v0.13.0, pre-1.0 |
| **(c)** New Dependabot alert not in 2026-04-28 baseline | **YES** | `ip-address` GHSA-v2v4-37r5-5v8g surfaced 2026-05-06 (already closed) |
| **(d)** Baseline alert cleared without action on our side | **No** | All closures involved explicit overrides or manual dismissal by maintainers |

---

## 4. Migration Phase Status (per ADR-087 / SOLANA-V2-MIGRATION-PLAN-2026-05-04)

| Phase | Scope | Status |
|---|---|---|
| Phase A — prod runtime RPC migration | x402-relay ✅, indexer ✅, sdk/client ✅ | **Complete** (shipped 2026-05-04, 05-13, 05-14) |
| Phase B — mcp-server v1 handler migration | 4 remaining handlers: registry, reputation, settlement, formatters | **Blocked** — requires npm Anchor Kit-native client (still absent) |
| Phase C — dev/test/script `@solana/spl-token` consumers | 13 files | **Blocked** — post-Phase-A; depends on `@solana-program/token` ≥ 1.0 for test harness |
| Phase D — remove `@solana/spl-token` / close bigint-buffer CVE | workspace root dep removal | **Blocked** — requires Phase C complete |

Migration is paused at **4% handler coverage** (1/27 MCP actions on Kit-native path: `execute_transfer` via `handlers-v2/vault.ts`). Dual-stack (`AEP_USE_V2_VAULT_TRANSFER=1`) is the current runtime shape.

---

## 5. Observations & Risks

1. **@coral-xyz/anchor EOL on npm.** The old package name is abandoned at v0.32.1. Our `mcp-server` pins `^0.31.1` against an end-of-life package name. This is not a CVE today, but it means no security patches will arrive via Dependabot under the old name. The Anchor major-bump Dependabot PRs (#102, #134, #140 in issue #149) need to be revisited once `@anchor-lang/core` is known to work as a drop-in replacement (it is, for the 0.31→0.32→1.x series, just a package rename + borsh re-export name change).

2. **bigint-buffer remains unfixable.** The high-severity CVE is dismissed (dev-only path) but not eliminated. Full elimination via Phase D requires `@solana-program/token` ≥ 1.0 and the 13-file Phase C migration. Until then, `npm audit` will continue to show 4 high via `@sqds/multisig`; `npm audit --omit=dev` is clean.

3. **rand ×2 cargo waivers are structural.** Clearing them requires bumping `anchor-lang` on-chain (Anchor 1.0 cargo), which carries ABI risk. Tracked in issue #149 under "Anchor (cargo) 0.31 → 1.0". Independent of the TypeScript migration.

4. **ip-address alert closed quickly** — the override at `express-rate-limit → ip-address` is minimal-blast-radius. Monitor whether `@modelcontextprotocol/sdk` ships a version that drops vulnerable `express-rate-limit`; when it does, remove the override.

5. **@solana/kit 6.8 → 6.9 absorbed.** PR #128 merged (patch/minor per issue #149). The pinned `6.9.0` in `mcp-server/package.json` is current with kit's latest.

---

## 6. Recommendation (ready to paste)

**Wait; schedule next check in 6–8 weeks (target: ~2026-07-22).**

Neither ADR-133 migration trigger has fired:
- Anchor TypeScript has a new home (`@anchor-lang/core`) but still depends on `@solana/web3.js` v1. Phase B cannot start.
- `@solana-program/token` is at v0.13.0, not 1.0. Phase C/D cannot start safely.

**Before the next check, the maintainer should:**

1. **Rename Anchor dep** in `mcp-server/package.json` (and any other workspace that imports it): `@coral-xyz/anchor → @anchor-lang/core` at `^1.0.2`. The API is identical; this is housekeeping to stay on a maintained package name. Coordinate with the deferred Anchor version-update PRs in issue #149.

2. **Confirm rand ×2 alert state** via `gh api repos/agenomics-labs/protocol/dependabot/alerts --jq '.[] | select(.state=="open") | ...'` (this run could not access the endpoint). Expected: only #6 and #7 (`rand`) open; all others closed or dismissed.

3. **Watch for** `@anchor-lang/core` to publish a version whose `dependencies` no longer lists `@solana/web3.js` (the Kit-migration signal). No roadmap date is published; monitor monthly.

4. **Watch for** `@solana-program/token` v1.0.0 on npm. Current trajectory (0.13 → ?) suggests months, not weeks, but the pace of @solana/kit minor releases (v6.5 → v6.9 in ~10 weeks) indicates active upstream development.

---

*Generated by scheduled agent `trig_01GkKKZQd39rY2Z7w7tmmYou` on 2026-06-03. Sources: npm registry, GitHub Releases (coral-xyz/anchor, anza-xyz/kit), merged PRs #180 / #149 issue, docs/audits/DEPENDABOT-2-CLOSURE-CHECK.md, docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md, docs/audits/SOLANA-V2-MIGRATION-PLAN-2026-05-04.md.*

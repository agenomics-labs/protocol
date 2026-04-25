# Protocol — Status Audit 2026-04-23

- **Date**: 2026-04-23
- **HEAD**: `16799c3` (in sync with `origin/main`, 0 commits ahead)
- **Branch**: `main`
- **Working tree clean**: no — 12 untracked/modified (all under `.claude/`, `CLAUDE.md` attribution-policy edit, and `package.json` agentic-flow add; no protocol source touched)
- **Scope**: end-of-day snapshot covering today's 4 landings (ADR-081 / ADR-082 / ADR-083 + consolidation #37) and the state of mainnet-prep blockers.
- **Template**: see `docs/adr/STATUS-AUDIT-TEMPLATE.md`.

---

## 1. Git state

- **HEAD**: `16799c3`
- **Branch**: `main` · **origin/main**: `16799c3` · **ahead**: 0 · **behind**: 0
- **Today's landings** (2026-04-23, chronological):
  - `a4b7581` fix(mainnet-deploy): close audit blockers 1 & 2 — hardened gates, real hash check, signed-tag enforcement, deploy log, shellcheck CI (#35)
  - `9ffc65c` fix(indexer): close 4-event coverage gap + CI gate (ADR-082, audit items 6/7) (#36)
  - `c8ac486` docs(adr): consolidation 2026-04-23 — promotions, stubs, backfills, status edits (#37)
  - `d3311e6` feat(mcp-server): MCP transport security model (ADR-083) (#38)
  - `16799c3` feat(governance): operationalize ADR-063 §6.1 emergency suspend (ADR-081) (#39)
- **Local uncommitted**: `CLAUDE.md` (attribution policy block), `package.json` (`agentic-flow@^2.0.7` dep), plus `.claude/` helper scaffolding (out of scope for this repo).

## 2. Workspace layout

Unchanged at the macro level since `STATUS-AUDIT-2026-04-22` / `docs/STATUS.md`. Three bounded contexts:

- **On-chain programs** (`programs/`): `agent-vault`, `agent-registry`, `settlement` — Anchor 0.31.1, workspace resolver v2.
- **TypeScript packages** (`packages/`): `@agenomics/capability-manifest-validator` (ADR-060), `@agenomics/sas-resolver` (ADR-061 + ADR-065 caching). Both at `0.1.0` unpublished.
- **Off-chain surfaces**: `mcp-server/` (Solana Kit dual-stack adapter per ADR-087, now with ADR-083 transport auth), `src/indexer/` (ADR-082 event-coverage CI gate just landed), `scripts/` (ADR-080 mainnet-deploy hardening), `dashboard/`, `integrations/`.
- **IDL**: `idl/*.json` parity-enforced by `.git/hooks/pre-commit` via `scripts/sync-idl.sh`.

## 3. ADRs

**Totals** (86 ADR files under `docs/adr/`, plus `STATUS-AUDIT-TEMPLATE.md`):

| Status | Count |
|---|---:|
| Accepted | 71 |
| Proposed | 8 |
| Reserved (placeholder, decision deferred) | 3 |
| Not Written (numbering gap / absorbed elsewhere) | 3 |
| Superseded | 1 |
| **Total** | **86** |

**Newest ADRs (today)**:

| # | Title | Status |
|---|---|---|
| ADR-081 | Emergency suspend credential | Accepted 2026-04-23 |
| ADR-082 | Indexer event coverage CI gate | Accepted 2026-04-23 |
| ADR-083 | MCP transport security model | Accepted 2026-04-23 |

**Format inconsistency surfaced**: three status-header conventions in use (`## Status\n<value>`, `**Status:** <value>`, `- **Status**: <value>`). No stale-status text found once all three patterns are parsed, but this is template drift worth settling on one form in a follow-up sweep.

## 4. Test totals

Ran the fast matrix (package + mcp-server). Anchor integration suite not rerun in this audit window — last green on CI at `16799c3`.

| Target | Pass | Fail | Total | Notes |
|---|---:|---:|---:|---|
| `@agenomics/capability-manifest-validator` | 16 | 0 | 16 | `packages/capability-manifest-validator` — `npm test` |
| `@agenomics/sas-resolver` | 65 | 0 | 65 | `packages/sas-resolver` — `npm test` |
| `mcp-server` unit | 107 | **2** | 109 | `mcp-server` — `npm test` |
| Anchor integration (`tests/*.ts`) | — | — | 99 | 9 test files; last green on CI; not rerun locally (requires `anchor test` validator spin-up) |
| **Grand total (fast matrix)** | **188** | **2** | **190** | Anchor 99 excluded pending local rerun |

**Failure root cause** (both mcp-server failures): `Error: Cannot find module '@solana-program/compute-budget'` in `test/action-shape.test.ts` and `test/handlers-v2-vault.test.ts`. This is a missing-dep in `mcp-server/package.json` or a stale `node_modules` after a dep bump — **not** a logic regression. Unblocking: `cd mcp-server && npm install @solana-program/compute-budget` (or verify it should be a dep vs peer and fix the manifest). Gate this before the audit's "recommended next moves" Tier B.

## 5. Code hygiene

| Check | Result |
|---|---|
| `cargo check --workspace` | ✓ clean (only 2 upstream deprecation notices from anchor 0.31.1's `AccountInfo::realloc`) |
| Programs LOC (Rust, `programs/`) | 5,235 |
| Packages LOC (TS, `packages/`, excl. `node_modules`/`dist`) | 4,636 |
| MCP server + indexer LOC (`mcp-server/`, `src/`) | 13,928 |
| Test LOC (`tests/` integration) | 7,112 |
| `TODO` / `FIXME` / `XXX` / `unimplemented!()` | 5 total across `programs/`, `packages/`, `tests/`, `src/` |
| IDL parity hook | ✓ installed (`.git/hooks/pre-commit` — gates any staged `programs/**/*.rs` or `*.toml` change against `idl/*.json`) |
| Commit-attribution hook | ✓ installed today (`.git/hooks/commit-msg` — strips tool/model co-author trailers; see CLAUDE.md attribution policy) |

Not run in this audit (time-bound): `cargo clippy -p <each program>` warning counts, full `anchor build --workspace --release`. Noted as Tier B.

## 6. On-chain artifacts (replaces "Papers")

Protocol is not a research codebase; this section tracks the equivalent of publication artifacts — deployed programs and published npm packages.

| Artifact | Version / ID | State | Notes |
|---|---|---|---|
| `agent-vault` program (devnet) | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | Live, current with `main` | ADR-060 manifest fields + `update_manifest` IX live |
| `agent-registry` program (devnet) | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | Live, current with `main` | SEC-1/4/7/8/11 reputation trust-boundary hardening live (#32) |
| `settlement` program (devnet) | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | Live, current with `main` | same |
| `@agenomics/capability-manifest-validator` | `0.1.0` | **Unpublished** | npm org claimed, `NPM_TOKEN` + `.github/workflows/publish.yml` in place; holding per §7.A |
| `@agenomics/sas-resolver` | `0.1.0` | **Unpublished** | same |
| Mainnet deployment | — | **Blocked** | see §9 |

## 7. Runtime state — devnet

From `docs/STATUS.md` §3–§7 (validated against HEAD; no state drift detected):

- **Upgrade authority**: single key `BUdXA1Fi…jTXL` on all three programs. Transfer to Squads multisig deferred for devnet iteration cost reasons.
- **Squads v4 multisig (devnet)**: PDA `EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz`, 2-of-3, members per `scripts/.squads-devnet.json`. Currently holds no authority — SAS bootstrap ceremony staged but not yet exercising its role.
- **SAS credential bootstrap** (`AEP_PROTOCOL` credential + `AEP_AGENT_REPUTATION_v1` schema): bootstrapped on devnet in PR #34; resolver proven end-to-end on the real SAS path (closes the §5 "unexercised SAS attestation path" gap).
- **Emergency suspend** (ADR-081, PR #39): operationalized today — §6.1 of ADR-063 is now enforceable rather than aspirational.
- **Indexer event coverage** (ADR-082, PR #36): all 4 previously-missing events now emitted + parsed + gated in CI.

## 8. Benchmark headlines

N/A for this repo — protocol is chain-bound; throughput is dominated by Solana runtime, not local compute. Tracked indirectly as:

- Anchor CPI size budgets per ADR-007 / ADR-024.
- Daily-limit bookkeeping per ADR-015 (per-token records capped at `MAX_TOKEN_SPEND_RECORDS = 10`).
- Event batch sizes per ADR-082 indexer.

No regressions noted. If a bench harness materializes (proposed as Tier D below), this section gets populated.

## 9. Known gaps

Ranked by severity. Every item has a "what unblocks it" line.

1. **Mainnet deployment remains the headline blocker.** Audit blockers 1 & 2 closed today (PR #35 — hardened gates, real hash check, signed-tag enforcement, deploy log, shellcheck CI). Blockers 3–5 still open per ADR-080; mainnet cut requires all five plus external security review sign-off (ADR-036). **Unblocks**: ADR-080 residual items + external audit report.
2. **npm packages still unpublished.** Both `@agenomics/*` at `0.1.0` ready, full publish pipeline wired. Original hold reason (unexercised SAS path) is now resolved by PR #34. **Unblocks**: a decision — publish now, or deliberately continue holding. No code work required.
3. **2 failing mcp-server tests** (§4): missing `@solana-program/compute-budget` dep. Low-severity (infrastructure, not logic) but blocks the audit's "all-green" claim. **Unblocks**: one-line `npm install` in `mcp-server/` after deciding dep vs peer.
4. **ADR status-header format is not standardized** (§3) — three conventions coexist. No stale content, but a future automated audit script will break against whichever form it doesn't know. **Unblocks**: pick one form, bulk-normalize in a single commit.
5. **Upgrade authority still a single key on devnet.** Intentional per ADR-063 §4 for now; must flip to Squads-2-of-3 before mainnet, alongside replacing the two throwaway signer keypairs (members 2 & 3) with real signers per ADR-063 §1.1 (3-of-5 with role slots). **Unblocks**: mainnet-cut ceremony.
6. **Clippy warning counts and full release build** not captured in this audit (§5) — only `cargo check` ran. Known-clean historically; no reason to expect regressions. **Unblocks**: 10 min of agent time to run and record.

### Things the audit found clean

- No `Co-Authored-By: Claude` / Anthropic trailers in any commit of this repo's history (verified across all refs). Today's attribution-policy edits + commit-msg hook hold the line going forward.
- Git identity (`k2jac9 <k2jac9@users.noreply.github.com>`) matches `gh auth status` account exactly.
- IDL parity hook caught zero drifts today — programs changes landed with synced `idl/*.json`.
- No ADR marked `Deprecated` without a successor link; no ADR status text contradicting its filing (all three status-header forms parse to one of the five expected values).
- SEC-1 through SEC-15 security fixes (PRs #28–#32) remain in place — no follow-up regressions.

## 10. Recommended next moves

### Tier A — publication (no code, external action only)

- Decide: publish `@agenomics/capability-manifest-validator@0.1.0` + `@agenomics/sas-resolver@0.1.0` now that SAS path is proven. ~30 min wall time including npm 2FA. (§9 item 2)
- Kick off external security audit per ADR-036 — §9 item 1 blocks on this; vendor selection is a user/stakeholder decision, not agent-executable.

### Tier B — follow-up (small scoped work enabled by today's landings)

- Fix mcp-server test deps (§9 item 3) — ~5 min; restores clean test matrix.
- Normalize ADR status headers to one form across all 86 files (§9 item 4) — ~20 min, mechanical.
- Capture `cargo clippy` warning counts per program + one full `cargo build --workspace --release` invocation; append as addendum to this audit or include in the next one (§9 item 6).
- Rerun the full Anchor integration suite locally and record the 99/99 number in §4 rather than deferring to CI.

### Tier C — remaining code work (each item a standalone scoped task)

- Close ADR-080 mainnet-deploy blockers 3–5 (next in the queue after today's 1 & 2 landing).
- Squads 2-of-3 authority transfer dry-run on devnet: replace throwaway signers 2 & 3 with real keypairs, run a no-op upgrade through the multisig, validate the operator doc at `docs/SQUADS_DEVNET.md` end-to-end.
- Promote the 8 `Proposed` ADRs that have corresponding merged code to `Accepted`, or re-title them as `Rejected` / `Superseded` with explanation. Spot-check suggests several are trailing their implementations.

### Tier D — exploratory

- Decide whether benchmark harness (§8) is worth the cost. Candidate: per-IX compute-unit ceilings regression-tracked across Anchor version bumps, so Anchor 0.32 upgrade doesn't silently balloon CU.
- Consider a `ruflo doctor`-style `aep doctor` for the protocol repo — would catch drift cases like today's mcp-server missing-dep earlier.

---

## One-line verdict

Four ADRs landed in one day closing the two top-ranked audit blockers and the indexer-coverage gap; the only open "not green" in the fast test matrix is a one-line dep fix, and mainnet is now blocked on external audit + ADR-080 blockers 3–5, not on our own hardening.

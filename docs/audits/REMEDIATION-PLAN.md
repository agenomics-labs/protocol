# Remediation Plan — Architecture Audit 2026-04-25

**Phase 3 of the audit.** Sequences fixes from `ARCHITECTURE-AUDIT-2026-04-25.md` and `ADR-DRIFT-MATRIX.md` into PR-shaped batches with explicit dependencies.

- **Status legend**: 🟢 Done · 🟡 In flight · 🔴 Blocked on design · ⚪ Queued
- **Effort**: rough engineer-time, not wall-clock
- Each PR cites the AUD-NNN findings it closes and the ADRs it implements / supersedes

---

## Sequencing graph

```
PR-A (audit docs) ──┐
PR-B (ADR governance) ──┐
PR-C (SDK PDA fix) ──┤
PR-D (env + event drop) ──┤
PR-E (tool count drift) ──┤      Independent — land in any order
PR-F (TS hardening) ──┤
                       │
PR-G (C1+C2 reputation) ── must land as one PR ◄─── needs design + ADR-094 follow-up
PR-H (C5 governance) ── needs op-vs-code decision
PR-I (C4 status laundering) ── needs spec
PR-J (C3 vault profile_nonce → OwnerNonce)
                       │
PR-K (CPI failure tests)
PR-L (wall-clock test → bank-warp)
PR-M (mainnet readiness gate)
PR-N (CI security gates flip to blocking)
PR-O (web3.js v2 migration completion)
```

---

## Landed (this audit cycle)

### PR-A — Audit docs ✅ (commit `3e36266`)
**Adds**: `docs/audits/{ARCHITECTURE-AUDIT-2026-04-25.md, ADR-INVENTORY.md, ADR-DRIFT-MATRIX.md, appendix-*.md}` (7 files, 945 lines).

### PR-C — SDK PDA derivation fix ✅ (commit `e262db9`)
**Closes**: AUD-003, AUD-011, AUD-012.
**Implements**: ADR-119 boundary validation (partial — adds equivalence tests).

### PR-D — ANCHOR_WALLET + event drop ✅ (commit `9213c1a`)
**Closes**: AUD-016, AUD-032.

---

## Landed in this turn (PR-B, PR-E, PR-F)

### PR-B — ADR governance cleanup ✅
**Commits**: `b117ffa`, `72161b5`, `1891f4a`, `24bc847`, `5c477bb`
**Closes**: AUD-047, AUD-048, AUD-049 (partial), AUD-050; drift matrix §1, §3, §4, §5.
**Scope delivered**:
- Deduped 098 + 099 (Superseded with Revisions logs)
- Flipped ADR-073 + ADR-075 status: Proposed → Accepted
- Annotated 7 de-facto supersessions (004→042, 012/033→087, 031→080, 032→085, 038→050, 068→094)
- Marked ADR-007 + ADR-014 Superseded (CPI helper migration)
- Dead-path Revisions on 9 audit-fix ADRs (024, 025, 026, 035, 040, 041, 043, 044, 047)

### PR-E — Tool count + execute_program_call drift ✅
**Commits**: `22dc7a7`, `6941869`
**Closes**: AUD-014, AUD-072.
**Follow-up flagged**: stale "20 tools" mentions in `docs/index.md`, `docs/api-reference.md`, `docs/getting-started.md`, `docs/integration-guide.md`; `docs/SECURITY_AUDIT.md` + `docs/AUDIT_SCOPE.md` still describe `execute_program_call` as live security surface (real correctness drift). Queue as **PR-DD** below.

### PR-F — Small TS hardening ✅ (3 of 4)
**Commits**: `8255d03`, `440ecac`, `3a77002`
**Closes**: AUD-027 (JWT_SECRET ≥32 bytes), AUD-029 (`/metrics` 127.0.0.1 + `METRICS_HOST` override), AUD-031 (redundant `createRpc`).
**AUD-040 NOT applied — Wontfix**: the agent verified that `'sign:cross_program:settlement+registry'` IS used by 4 settlement actions (`submit_milestone`, `approve_milestone`, `dispute_milestone`, `resolve_dispute` at `mcp-server/src/actions/settlement.ts:107,137,261,292`) and asserted in `test/action-shape.test.ts:128`. The audit's premise was wrong. Reclassified.

### PR-DD — Stale doc cleanup (follow-up from PR-E) ⚪
**Closes**: a sub-thread of AUD-072 covering site/external docs missed by PR-E's scope.
**Scope**:
- Update "20 tools" → "24 tools" in `docs/index.md`, `docs/api-reference.md`, `docs/getting-started.md`, `docs/integration-guide.md`
- Remove `execute_program_call` as live surface from `docs/SECURITY_AUDIT.md` (lines 34, 50, 173, 197, 342, 381) and `docs/AUDIT_SCOPE.md` (lines 34, 140); annotate as historical
**Effort**: ~30 min.

---

## Phase 3 — design-locked criticals/highs (all landed)

### PR-H — Governance gate ✅
**Commit**: `5aa2f85`
**Closes**: AUD-005, AUD-068 (partial — single-key authority rotation hardened via upgrade-authority init)
**Decision**: Option C (upgrade-authority `ProgramData` constraint). Cultural enforcement: no future ix references `ProgramData`.

### PR-J — Vault register-first ✅
**Commit**: `a1c40da`
**Closes**: AUD-008
**Decision**: Strict register-first; SDK handles UX flow. Spec correction: `OwnerNonce` has no `authority` field — seeds binding alone enforces cross-account-reuse rejection (committed as `e9569ac`).

### PR-I — Status laundering ✅
**Commit**: `31586e9`
**Closes**: AUD-004
**Decision**: Cumulative `slash_count` + new `cleared_count: u8` field. Escalation ladder: 1 → halve, 2 → zero, 3 → terminal Retired. Self-issued `→ Suspended` rejected in `update_status`.

### PR-G — Reputation policy unification ✅
**Commit**: `0a02850` + activator `dab8ec7`
**Closes**: AUD-001, AUD-002, AUD-065 (two parallel paths eliminated)
**Decision**: Option A — remove legacy `update_reputation` entirely; migration normalizes scores via `migrate_agent_profile` (clamp to `[0, 100]` + Suspended-invariant fix). New `assert_valid_profile()` helper enforces closed-state-machine post-mutation and post-migration. New `verify_protocol_invariants` admin ix for post-deploy sweep. Default reputation deltas re-tuned for the `|delta| <= 10` policy.

---

## Originally queued (no longer applicable — kept for history)

### PR-G — Reputation policy unification 🔴 (Critical) → ✅ above
**Closes**: AUD-001 (C1), AUD-002 (C2), AUD-065 (A1), AUD-069 (A5).
**Implements**: ADR-094 + ADR-116.
**Scope**: must land as one PR.
1. Fix `ProposeReputationDelta` context in `programs/agent-registry/src/contexts.rs:307-313` — add `owner_nonce: Account<'info, OwnerNonce>`; nonce-bytes in seed.
2. Rewire `programs/settlement/src/instructions/cpi.rs:65-80` to invoke `propose_reputation_delta` instead of legacy `update_reputation`.
3. Gate legacy `update_reputation` to `upgrade_authority`-only OR remove it.
4. Add CPI integration tests covering the new path + legacy gate.
5. Flip ADR-094 status: Partial → Implemented; flip ADR-116 status: Proposed → Accepted.

**Blocker**: design decision on legacy gate (remove vs upgrade-auth gate).
**Effort**: ~2 days.

### PR-H — Permissionless governance front-run 🔴 (Critical)
**Closes**: AUD-005, AUD-068.
**Options**:
- **Option A**: Hard-code authority pubkey via `address = <multisig_pda>` constraint on `initialize_protocol_config` payer.
- **Option B**: Execute `initialize_protocol_config` atomically in the deploy script with the multisig as authority (no code change).

**Blocker**: which option, and what is the multisig PDA?

### PR-I — Reputation laundering loop 🔴 (Critical)
**Closes**: AUD-004.
**Scope**:
1. Reject `update_status(Active → Suspended)` self-issued.
2. Re-spec `clear_suspension` cost: floor + cooldown via `cleared_at`.

**Blocker**: cooldown duration + floor value.

### PR-J — Vault `profile_nonce` derived not user-supplied 🔴 (High)
**Closes**: AUD-008.
**Scope**: `initialize_vault` accepts an `OwnerNonce` account from Registry's program ID, not a user-supplied scalar.
**Effort**: ~4 hours.

---

## Queued — engineering work, no design block

| PR | Closes | Effort | Notes |
|---|---|---|---|
| PR-K | AUD-017 | 1d | CPI failure integration tests (settlement→registry) |
| PR-L | AUD-055 | 3h | Replace `setTimeout` waits with `solana-test-validator` slot warp |
| PR-M | AUD-059 | 1d | `v*-mainnet` workflow that parses `MAINNET_CHECKLIST.md` Pending rows + signed-tag check |
| PR-N | AUD-061 | 2d | ADR-115 — flip clippy/cargo-audit/npm-audit `continue-on-error` to false; needs clean baselines first |
| PR-O | AUD-037, AUD-074, AUD-077 | 2w | Migrate remaining 23 mcp-server handlers to v2 |

---

## Smaller queued items

| PR | Closes | Effort | Notes |
|---|---|---|---|
| PR-P | AUD-006 | 1h | Vault rate-limit `saturating_sub.max(0)` |
| PR-Q | AUD-007 | 2h | `total_rated_tasks` denominator separate from `total_tasks_completed` |
| PR-R | AUD-009 | 30m | `accept_task` deadline check |
| PR-S | AUD-010 | 3h | `expire_escrow` success-path CPI for all-Approved case |
| PR-T | AUD-013 | 1d | Result<T> shape unification across mcp-server/sdk/sas-resolver |
| PR-U | AUD-015 | 4h | Add `rotate_agent_identity` MCP tool (ADR-069) |
| PR-V | AUD-018 | 2h | `raise_dispute` grace gate matching ADR-102 |
| PR-W | AUD-021 | 4h | Default-deny allowlist (ADR-073 Part 2 actually ship) |
| PR-X | AUD-023 | 2h | Per-day rotation cap on `update_agent_identity` |
| PR-Y | AUD-024 | 1h | `MAX_ESCROW_DEADLINE_SECS` upper bound |
| PR-Z | AUD-039 | 4h | Replace indexer reconnect private-API peek (ADR-118) |
| PR-AA | AUD-041 | 30m | Move `agentdb.rvf`, `ruvector.db`, `.swarm/` out of root |
| PR-BB | AUD-042 | 1h | Bump indexer `@coral-xyz/anchor` to ^0.31.1 |
| PR-CC | AUD-053 | 2d | Extend `status-audit.sh` into a real ADR-lint with drift detection |

---

## What does NOT get fixed

- **AUD-067** (no `close_vault`) — workaround: bricked vaults stay bricked. Add only on confirmed user complaint.
- **AUD-070** (`settlement_authority` bump unstored) — cosmetic CU saving.
- **AUD-071** (no keeper fee) — needs design discussion on keeper economic primitive vs accept Solana model.
- **AUD-046** (`migrate_agent_profile` zero-pad) — design constraint, ADR-096.
- **AUD-051..AUD-054** — handled in PR-CC.

---

## Tracking convention

After each PR lands:
1. Mark its `AUD-NNN` row in `ARCHITECTURE-AUDIT-2026-04-25.md` Open → `Fixed in PR #XX (commit abc1234)`.
2. Update affected ADR(s) status in `ADR-INVENTORY.md` if verdict shifted (Partial → Implemented).
3. Add a `## Revisions` log entry to any ADR whose policy actually became live.
4. Re-run `scripts/status-audit.sh` (post-PR-CC: `scripts/adr-lint.sh`) to verify no new drift.

The audit cycle closes when:
- All Critical findings are Fixed.
- All High findings are Fixed or have explicit Wontfix.
- Drift matrix Categories 1, 2, 3 are empty.
- A successor architecture-audit can be opened with a clean baseline.

---

## Why this sequencing

- **PR-B before PR-G**: governance ADRs (098/099 dedup, status flips, supersessions) are the lowest-risk credibility wins. Land them so the ADR record matches reality before starting the high-risk reputation rewire.
- **PR-G before PR-H/PR-I**: reputation is the central primitive; everything else is downstream. Fix unbounded delta first.
- **PR-K before PR-G's merge**: write the CPI-failure tests against the *current* legacy path, then keep them passing through the rewire.
- **PR-N is last among the small batch**: needs clean baselines before flipping a noisy gate to blocking.
- **PR-O (web3.js v2)** is large, not on any critical path; ongoing background work.

# Pre-Mainnet Readiness Roadmap

**Date**: 2026-04-26 EOD
**Status**: Active
**Ownership**: agenomics-labs/core

This roadmap is the strategic plan for everything between "cycle-2 audit
corpus closed" (HEAD `9340852`) and "first `v*-mainnet` tag pushed
without the gate failing." It is **distinct from** `MAINNET_CHECKLIST.md`,
which is the per-item operational checklist the `mainnet-readiness.yml`
workflow gates on. This doc focuses on:

1. **Dependencies** — what blocks what.
2. **Parallelizable tracks** — what can run concurrently.
3. **Ownership** — who needs to drive each track.
4. **Cycle-2 → cycle-3 hand-off** — exactly what the audit corpus left
   open and where to start each item.

When this roadmap closes, every line in `MAINNET_CHECKLIST.md` should be
green and the only remaining gate is the GPG-signed tag itself.

---

## 1. Tracks at a glance

| Track | Theme | Blocks tag? | Can start now? | Owner |
|-------|-------|-------------|----------------|-------|
| **A. Hard gates** | What `mainnet-readiness.yml` rejects without | YES | A1 yes; A2 yes; A3 needs A1 | Lead Dev + Security |
| **B. Code/test gaps** | Cycle-3 follow-ups identified in cycle-2 audit | NO (but recommended) | All items yes | Core eng |
| **C. Operational readiness** | What you'll regret skipping in week 1 | NO (procedural) | All items yes | DevOps + Lead Dev |
| **D. Soak** | Devnet evidence the cycle-2 changes hold under load | NO (but checklist row) | Yes — runs continuously | DevOps |

A and D start immediately. B can run in parallel sessions / worktrees.
C is mostly people-coordination and documentation.

---

## 2. Track A — Hard gates (block tag)

### A1. External audit firm engagement → AUDIT_REPORT_HASHES

**Why it blocks**: `config/AUDIT_REPORT_HASHES` ships with all-zero
placeholders per ADR-080 §2. `scripts/mainnet-deploy.sh --self-test`
verifies the file is populated with non-zero SHA-256s before the deploy
script exits 0; the `mainnet-readiness.yml` workflow runs the self-test
on every `v*-mainnet` tag push.

**Concrete steps**:
1. Engage external audit firm (multi-week external blocker — start ASAP).
2. Audit firm produces signed report + artifact hashes for each program
   binary.
3. Populate `config/AUDIT_REPORT_HASHES` with `sha256(program.so)` per
   program, attributed to the auditor's signing key.
4. Run `scripts/mainnet-deploy.sh --self-test` locally and confirm
   exit 0.

**Status as of 2026-04-26**: Not started. Hashes are placeholder zeros.

**Cycle-3 entry**: Open the engagement contract. Track in
`docs/audits/AUDIT-STATUS-*.md` as it lands.

### A2. Squads multisig for the upgrade authority

**Why it matters**: A single-key upgrade authority is mainnet-disqualifying
for any non-trivial program. Per cycle-2 AUD-115, the upgrade authority
operationally equals `ProtocolConfig.authority` post-init, so the
multisig's *first* job is to sign `initialize_protocol_config`.

**Concrete steps**:
1. Decide multisig members and threshold (e.g., 3-of-5 of named
   maintainers).
2. Provision Squads (or Realms) with the chosen membership.
3. Each member generates their own keypair locally — **never share
   keys**.
4. Test the ceremony on devnet first: deploy a throwaway program,
   transfer upgrade authority to the multisig, run a no-op upgrade.
5. Document the ceremony script in `docs/MAINNET_DEPLOY_RUNBOOK.md`
   (see C1).

**Status**: Not started.

### A3. MAINNET_CHECKLIST.md walkthrough

**Why it blocks**: `mainnet-readiness.yml` (now hardened by AUD-309 +
AUD-400) fails any tag push if any row in `docs/MAINNET_CHECKLIST.md`
shows status `Pending|TBD|Partial|In Progress|InProgress|Blocked|WIP`
or any unchecked `- [ ]` task item.

**Concrete steps**:
1. Walk the 21 `| Pending |` rows + 14 unchecked task items with
   operators.
2. For each row: either mark `Done` with the closing artifact's link,
   or move to a separate `MAINNET_DEFERRED.md` with explicit rationale
   (the checklist gate enforces every row, so deferrals must be
   removed from the gated file).
3. Most rows depend on A1, A2, B-track, or C-track items. The
   walk-through is the **integration step** that ties this roadmap
   back to the gated checklist.

**Status**: Not started.

---

## 3. Track B — Code/test gaps (parallelizable)

Each B-item is a discrete PR. They can be worked in parallel sessions
or worktrees. The numbering is roughly priority order, not dependency
order — every B-item is independent.

### B1. ADR-124 implementation — vault `agent_identity` proof-of-control (AUD-116 path-a)

**Why**: Cycle-2 closed AUD-116 via the audit's path-(b) (threat-model
documentation). Path-(a) is an Ed25519 sig-at-init flow that closes the
init-mis-bind seam at the protocol level. Concrete code-level design is
already written in `docs/adr/ADR-124-vault-agent-identity-proof-of-control.md`.

**Scope**: ~half-day focused work.
- New `verify_ed25519_precompile` helper in `agent-vault/src/lib.rs`
  (byte-for-byte mirror of `agent-registry::manifest`).
- New `VAULT_IDENTITY_BIND_DOMAIN` constant + message-construction helper.
- New `instructions_sysvar` field in `InitializeVault` context.
- New `agent_identity_signature: [u8; 64]` parameter on
  `initialize_vault`.
- 2 new error variants.
- ~9 test call-site updates in `tests/agent-vault.ts` + mcp-server
  handler updates + SDK helper.

**Why now**: If any launch agents will hold meaningful balances day-1,
the init-mis-bind window is real. Ship while the audit context is fresh.

### B2. AUD-206 — `verify_protocol_invariants` MCP-tool wrapper

**Why**: Cycle-2 closed it as a deferred governance-tooling gap. Today
the only way to invoke `verify_protocol_invariants` is raw Anchor RPC
by the upgrade-authority signer. Operators will want a typed tool.

**Scope**: New `actions/governance.ts` action handler + tool definition
+ capability gate (`gov:invariant:check` or similar). Bounded by the
AUD-106 16-account batch cap.

### B3. `migrate_agent_profile` end-to-end integration test

**Why**: AUD-101 fixed the seeds bug (Critical) but the integration
test surface is thin. The migration choreography in DESIGN-DECISIONS
§ "Ship sequence" item 4 is load-bearing for legacy-profile cleanup.

**Scope**: One TS test at `tests/agent-registry.ts`. Set up a legacy
profile (skip `init` and write the pre-AUD-007 layout directly), call
`migrate_agent_profile`, verify post-state matches a freshly-registered
profile.

### B4. AUD-117 seeds integration test

**Why**: AUD-117 layered seeds-program defense-in-depth at the
Settlement boundary across 4 contexts. Today only the build verifies
the constraints; no integration test exercises a wrong-account
substitution attack against `provider_profile` or
`provider_owner_nonce`.

**Scope**: Add 2-4 negative tests to `tests/cpi-failures.test.ts`
asserting `ConstraintSeeds` fires at the Settlement boundary (not the
Registry boundary).

### B5. AUD-108 reason-rejection end-to-end test

**Why**: The Rust unit test pins the predicate, but no integration
test sends `reason=200` through the full CPI to confirm the
`InvalidReputationReason` revert lands at the Registry.

**Scope**: One TS test calling `propose_reputation_delta` directly
with reason 200, asserting the typed error.

### B6. AUD-209 saturation regression test

**Why**: x402-relay now returns 503 on saturation; no test pins this.

**Scope**: One node:test case in `src/x402-relay/test/`. Mock 100k
unique signatures, attempt one more, assert 503.

### B7. AUD-105 deadline-boundary TS integration test

**Why**: Rust unit test pins the boundary; existing TS test at
`tests/settlement.ts:2350` polls until `now > deadline` and so still
triggers under the new strict guard, but doesn't exercise the
*equality* boundary specifically.

**Scope**: Add one case that polls until `now == deadline` and asserts
`accept_task` rejects with `DeadlinePassed`.

### B8. Fuzz harness (MAINNET_CHECKLIST.md ADR-021 row)

**Why**: Currently `Pending`. Solana program fuzzing via `trident` or
`honggfuzz`. Cheap insurance against the seam classes cycle-2 surfaced
(reason codes, status transitions, deadline boundary, reputation
deltas).

**Scope**: One-time setup ~1 day; ongoing CI integration ~half-day.
Target: 4-hour fuzz run pre-tag.

### B9. Load tests (MAINNET_CHECKLIST.md ADR-022 row)

**Why**: Currently `Pending`. Discovery + settlement under expected
launch throughput.

**Scope**: Devnet harness that fans out N concurrent register →
escrow → settle flows. Measure CU consumption, RPC error rate,
indexer event-ingest lag.

### B10. SDK-side reputation-score clamp helper (AUD-112 reciprocal)

**Why**: Cycle-2 AUD-112 documented the transitional read window
inline at `propose_reputation_delta`. The reciprocal — an SDK-side
clamp helper — is doc-only today; turn it into a real export from
`sdk/client`.

**Scope**: ~10 LoC. `export function clampReputationScore(raw: bigint): number`.

---

## 4. Track C — Operational readiness

### C1. `MAINNET_DEPLOY_RUNBOOK.md`

Single source-of-truth for the deploy ceremony. Sections:
- Pre-deploy checks (lockfile clean, IDL diff clean, audit hashes
  populated, multisig signers online).
- Per-program deploy order (registry → vault → settlement, given
  CPI dependencies).
- `initialize_protocol_config` ceremony (multisig signs, captures
  ProtocolConfig.authority).
- `verify_protocol_invariants` smoke run (16-account sample, confirm
  multisig flow).
- Rollback procedure.
- Day-1 monitoring checklist.

**Pulls in**: AUD-115 operational note, ADR-080 mainnet-deploy safety
mandates, ADR-122 mainnet-readiness CI gate.

### C2. Incident response playbook

- On-chain incident triage (program upgrade vs `update_protocol_config`
  vs operator runbook step).
- Multisig emergency rotation.
- Indexer DB recovery from cold backup.
- x402-relay saturation response (manual scale-out, ADR-117).

### C3. AUD-207 — split program IDs across clusters

**Scope**: Trivial code change (`sdk/idl/src/index.ts:9-25`); the work
is in **generating real mainnet keypairs** and getting them into Squads
ceremony as part of A2.

**Concrete**:
1. After A2 completes, Squads holds the keypairs.
2. Update IDL with the real mainnet pubkeys.
3. Snapshot per-cluster IDs in the SDK + dashboard.
4. Add a regression test: `assert MAINNET !== DEVNET !== LOCALNET` for
   every program ID.

### C4. Operator runbook for ProtocolConfig.authority entanglement (AUD-115)

The inline doc-comment lives at `verify_protocol_invariants`'s body.
Operators need it surfaced in a checked-by-them runbook before the
first invariant-sweep call. Either fold into C1 or its own doc.

### C5. Indexer redundancy + backfill plan

- Two-instance indexer with leader election OR cold-spare.
- Backup cadence for the indexer DB.
- Drill: kill primary, confirm secondary catches up from slot N.

### C6. x402-relay scale plan (ADR-117)

The current single-instance design tops out at ~30 sigs/sec sustained
(per AUD-209's bound). If launch throughput could exceed that, ship
the Redis-backed dedup BEFORE first paying customer.

---

## 5. Track D — Soak

### D1. Devnet smoke harness running continuously

`scripts/smoke-test-devnet.ts` running on a cron (every N minutes)
through the full lifecycle: register → vault init → escrow create →
submit → approve → propose_reputation_delta → expire/dispute. Pin
metrics:
- Time-to-finality per ix.
- RPC error rate.
- Indexer event-ingest lag.

**Recommended duration**: 2 weeks before first `v*-mainnet` tag.
Anything that drifts in 2 weeks of devnet would also drift in 2 weeks
of mainnet — better to find it now.

### D2. Migration-choreography rehearsal

Run `migrate_agent_profile` against a population of legacy-state
profiles on devnet. Confirm B3's E2E test holds at scale (16 accounts
per `verify_protocol_invariants` batch, multiple batches).

---

## 6. Recommended ordering

If you've got 2-4 weeks before tag:

**Week 1**:
- A1 starts (audit firm engagement) — multi-week external
- A2 starts (multisig provisioning) — multi-week internal
- D1 starts running on devnet
- B1 (ADR-124) PR opened
- C1 doc starts (deploy runbook)

**Week 2**:
- A2 completes; C3 (real mainnet IDs) lands
- B3, B4, B5, B6, B7 ship in parallel sessions/worktrees
- B8 (fuzz) starts
- C5 (indexer redundancy) drilled

**Week 3**:
- A1 completes; A3 walkthrough fills in the checklist
- B9 (load tests) runs
- C2, C4 docs land
- D2 (migration rehearsal)

**Week 4**:
- Final dry-run: signed `v*-rc` tag against the workflow on a fork.
  Confirm `mainnet-readiness.yml` passes end-to-end.
- Squads ceremony walk-through on devnet.
- First `v*-mainnet` tag.

---

## 7. Cycle-2 closure pointers (where each item came from)

This roadmap consumes the cycle-2 audit corpus. Closure-status sections
are authoritative for any "what's already done?" question:

- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-onchain.md` §"Closure status"
  — 24/24 closed (AUD-100..AUD-122 + AUD-044). AUD-116 path-(b) closed;
  path-(a) tracked in ADR-124 (Track B1 above).
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-offchain.md` §6 "Closure
  status" — 13/14 closed. AUD-207 is Track C3 above.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md` §6/§7 — 100%.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-adr.md` — 100%.
- `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md` — closure-status pointer
  to `AUDIT-STATUS-2026-04-25.md` as canonical.

ADRs landed during cycle-2 (referenced by tracks):
- ADR-114 — Dependabot dependency hygiene (covers github-actions
  ecosystem; auto-bumps the SHAs from AUD-406 weekly).
- ADR-115 — CI blocking-security-gates (the blocking surface this
  roadmap delivers against).
- ADR-122 — Mainnet readiness CI gate (the workflow A1/A3 must satisfy).
- ADR-123 — Self-hosted runner action-cache hardening (AUD-406; CI
  flake mitigation).
- ADR-124 — Vault `agent_identity` proof-of-control (AUD-116 path-(a)).

---

## 8. Open questions to resolve before Week 1

These need owners before kicking off:

1. **Audit firm**: who, by when. Negotiate scope to include the cycle-2
   diffs (last ~30 commits to `programs/`).
2. **Multisig membership + threshold**: who, what threshold.
3. **Launch throughput estimate**: drives whether C6 (x402-relay scale)
   is week-1 work or week-3 work.
4. **Initial agents at launch**: drives whether B1 (ADR-124) is week-1
   work or week-3 work — high-balance launch agents make it week-1.
5. **Indexer SLO**: drives C5 (single-instance vs HA pair).

Resolve these in the Week-0 kickoff before spawning parallel sessions.

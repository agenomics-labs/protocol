# ADR Drift Matrix — 2026-04-25

**Phase 2 cross-cut analysis.** Aggregates the per-ADR inventory in `ADR-INVENTORY.md` into actionable categories: which ADRs lie about their own implementation status, which silently supersede each other, which clusters overlap without canonical, which file-path citations are dead.

Every issue here is a candidate for Phase 3 remediation. Items are **ranked by leverage**: fixes high in this doc unlock multiple downstream fixes.

---

## Category 1 — Duplicate-numbered files (must dedupe)

| Number | Files | Resolution |
|---|---|---|
| **098** | `ADR-098-client-sdk.md` (verbose; says "no @agenomics/idl dep") + `ADR-098-sdk-client-package.md` (brief; says "re-exports @agenomics/idl") | Code (`sdk/client/package.json` depends on @agenomics/idl) matches the **brief**. Mark `client-sdk.md` as `Superseded by ADR-098-sdk-client-package`. |
| **099** | `ADR-099-idl-package.md` (verbose; vendored IDL JSON via ES2022 imports) + `ADR-099-sdk-idl-package.md` (brief; cluster-keyed program-ID manifest only) | Code (`sdk/idl/src/idl/` directory + cluster-keyed exports) matches the **verbose superset**. Mark `sdk-idl-package.md` as `Superseded by ADR-099-idl-package`. |

**Action**: 30-minute fix. Update `Status` line in two files; preserve filenames so historical links still resolve.

---

## Category 2 — Stale-Accepted: code drifted, ADR never updated

These ADRs claim Accepted status, but the code disagrees. They are either lies-by-omission (later refactor invalidated them) or successor-ADR-not-written.

| ADR | Drift | Master finding |
|---|---|---|
| **ADR-007** (cpi-pattern) | "Manual discriminator retained, will fail loudly" — code now uses Anchor CPI helper at `cpi.rs:74`, not manual discriminator. The hardcoded byte array `[194, 220, 43, ...]` is dead. | AUD-048 |
| **ADR-014** (cpi-pattern) | "Test asserts `sha256(...)` matches hardcoded array" — `test_cpi_discriminator_matches_anchor_convention` does not exist; only a symbol-presence test survives. | AUD-048 |
| **ADR-024** (vault-allowlist) | "Add pre/post lamport snapshot in `execute_program_call`" — instruction was REMOVED by ADR-050/L1. ADR-024 cites `programs/vault/src/...` (not even the right program). | AUD-072 (related) |
| **ADR-038** (audit-findings) | "Sandbox `execute_program_call`" — instruction REMOVED by ADR-050/L1. The sandbox is moot. | AUD-052 (related) |
| **ADR-088** (sdk-migration) | "Remove `as any` from program clients" — done in mcp-server, NOT done in `sdk/client/*.ts` where `(this.program.account as any)["..."]` is at vault:83, registry:108,124, settlement:118,135. | AUD-025 |
| **ADR-103** (typescript-hygiene) | "Canonical Result type lives in @agenomics/action-runtime" — three different shapes still in tree (mcp-server uses `data`/`AepError`; sas-resolver and action-runtime use `value`/`Error`). | AUD-013 |
| **ADR-098-client-sdk** | Section 1.5 says "no dependency on @agenomics/idl" — code disagrees. | AUD-003 / AUD-073 |

**Action**: Each needs either (a) a successor ADR documenting the new pattern, or (b) a `Superseded by ADR-XXX` annotation. Per template policy, ADRs are immutable once Accepted; you write a new one, not edit the old.

---

## Category 3 — Status field lies: header says Proposed, code Implemented

These ADRs ship in production but their Status header still says Proposed. Auditors reading the corpus get a false negative on what's live.

| ADR | Header says | Code state | Master finding |
|---|---|---|---|
| **ADR-073** | Proposed | `settlement/contexts.rs:249-251` enforces `dispute_resolver.is_some()` AND match; `dispute.rs:121,215` carries matching commentary | (governance) |
| **ADR-075** | Proposed | `protocol_config.rs:84-99` enforces bounds; `lib.rs:170` uses `checked_neg()` | (governance) |

**Action**: Flip status to Accepted with a `Revisions` log line citing the commit that made it live. Same template policy applies: don't change the Decision; add a Revisions entry.

---

## Category 4 — De-facto supersession unannotated

These pairs have a canonical "successor ADR" relationship in the code, but neither end of the pair has a forward/backward link.

| Old ADR | New ADR | Relationship | Master finding |
|---|---|---|---|
| **ADR-031** mainnet-deployment | **ADR-080** mainnet-deploy-safety-mandates | ADR-080 explicitly says it "operationalizes the missing pieces of" ADR-031 and identifies four bugs in ADR-031's deliverable. | AUD-050 |
| **ADR-068** registry-reputation-cpi-trust-boundary | **ADR-094** reputation-trust-hierarchy-inversion | `cpi.rs:43-48` carries `TODO(ADR-094): Replace update_provider_reputation with a call to Registry::propose_reputation_delta` | AUD-002 / AUD-065 |
| **ADR-038** sandbox-execute_program_call | **ADR-050** /L1 (removes the instruction) | ADR-050 deletes what ADR-038 sandboxed. Neither references the other. | (governance) |
| **ADR-004** memcmp-filters | **ADR-042** remove-memcmp-offset | ADR-042 inverts ADR-004's central technique. ADR-004 has no Superseded annotation. | (governance) |
| **ADR-012** web3js-v2-migration | **ADR-033** web3js-v2-migration | Same topic, same day, both Accepted. Neither cross-references the other. ADR-087 (Solana Kit dual-stack) effectively replaces both. | AUD-049 |
| **ADR-032** npm-package-preparation | **ADR-085** agenomics-npm-scope-rename | ADR-085 renames the scope ADR-032 mandated. | (governance) |
| **ADR-053** compile-time-protocol-parameters | **ADR-075** protocol-config-delta-bounds | **GOLD STANDARD**: ADR-053 *does* have a forward link in its Status field. Use as template for the others. | (positive) |

**Action**: For each pair, either add `Superseded by ADR-XXX` to the older ADR or a `## Revisions` log entry. ADR-053 is the model.

---

## Category 5 — Dead file-path citations

ADRs that cite files which do not exist (refactor moved or deleted them). The substantive fix is usually still in place; the citation rots.

| ADR | Cited path | Reality |
|---|---|---|
| ADR-024 | `programs/vault/src/instructions/execute_program_call.rs` | `programs/vault/` doesn't exist; instruction REMOVED |
| ADR-025 | `programs/settlement/src/instructions/expire_escrow.rs` | code lives in `instructions/escrow.rs:376` (post ADR-049 split) |
| ADR-026 | `programs/settlement/src/instructions/resolve_dispute.rs` | code lives in `instructions/dispute.rs:27` |
| ADR-035 | `AEPDashboard.jsx` | actual root is `dashboard/src/App.jsx` + `components/` |
| **ADR-040** | `programs/aep/src/state/agent.rs` | `programs/aep/` doesn't exist; real path `programs/agent-registry/src/state.rs` |
| **ADR-041** | `programs/aep/...` | same — code in `programs/agent-vault/src/contexts.rs:35-239` |
| **ADR-043** | `programs/aep/...` | same — code in `programs/agent-registry/src/{errors.rs:26,lib.rs:55,126}` |
| **ADR-044** | `programs/aep/...` | same — code in `programs/agent-vault/...` |
| **ADR-047** | `programs/aep/...` | same — code in `programs/settlement/src/state.rs:98` |

**Pattern**: ADRs 040–047 (the post-ADR-037 audit-findings batch) all share a single drafting template that cited a hypothetical `programs/aep/` mono-program layout. This template was never re-pointed at the multi-program layout that actually exists.

**Action**: Either fix the citations in-place (if treating as a typo, not a decision change) OR add a `## Revisions` log noting the refactor that broke them. Don't keep citing dead paths in audit-trail-bearing docs.

---

## Category 6 — Mega-ADRs (multiple decisions in one file)

The template says **one decision per file**. These violate.

| ADR | Sub-decisions | Implication |
|---|---:|---|
| **ADR-037** architecture-deep-audit | 14 findings (C1-C2, H1-H4, M1-M5, L1-L4) | Spawned ADR-038→050 chain — actually OK, this one is an *index* of follow-on work. |
| **ADR-050** final-audit-polish | 9 fixes (M1-M5 + L1-L4) | L1 silently supersedes ADR-038. Each sub-fix should be its own ADR or at minimum cross-linked. |
| **ADR-058** action-and-signer-abstraction | 9 numbered sections including §2.1 (cross-ADR canonical) | Implicit coupling: ADR-059 §6 and ADR-060 §2 reference §2.1 as source-of-truth. |
| **ADR-060** capability-descriptor-format | 7 numbered sections | Aspirational — proposes Registry fields not yet present in `state.rs`. |
| **ADR-061** sas-integration | Multiple (61-67 cluster) | Coherent within cluster; bordering on acceptable. |
| **ADR-063** sas-credential-authority-governance | 6 explicit "Pending items before Accept" | Honestly flagged; appropriate to remain Proposed. |
| **ADR-080** mainnet-deploy-safety-mandates | 4 distinct mandates (refuse-to-run, AUDIT_REPORT_HASHES, signed-tag, --self-test) | Cohesive — bordering on acceptable. |

**Action**: Don't refactor en masse. As each sub-decision is revisited, split it into its own ADR with `Supersedes ADR-XXX/<section>` link. This is an opportunistic cleanup over months.

---

## Category 7 — Aspirational ADRs (Proposed, no implementation, no exit criterion)

ADRs in `Proposed` status with no shipped code AND no clearly-stated criterion for moving to Accepted. They accumulate as documentation cosplay.

| Cluster | ADRs | Pattern |
|---|---|---|
| **Research-driven (papers cited)** | 106, 107, 108, 109, 110, 111, 112, 113 | All cite a 2025–2026 arxiv/HF paper. Have decision criteria (params, defaults, formulas). Decision-shaped, not vapor — appropriate to keep Proposed; exit criterion is "implementation tests green". |
| **Audit-response (findings cited)** | 114, 115, 116, 117, 118, 119, 120 | Each addresses a specific re-audit finding. Concrete code-level. Should be Accepted as soon as the corresponding PR lands. **ADR-116 is C1 (AUD-001); ADR-119 is C3 (AUD-003)** — landing those PRs flips two ADRs. |
| **Mainnet-readiness chain** | 077, 078, 079 | Tightly coupled, all blocked on prior ADRs (063 ceremony, 081 scripts). Architecture-Audit-2026-04-23 calls this the mainnet blocker family. |
| **Procedure-only (no code expected)** | 062, 066, 067, 077, 078, 079 | Reserved/Proposed placeholders. Acceptable as long as exit criteria are stated. |

**Action**: For 114–120, fold each into the PR that implements it; flip status atomically with the merge. For 106–113, keep Proposed; add a one-line "Exit criterion" subsection if missing. For 077–079, treat as the mainnet-ready punch-list.

---

## Category 8 — Overlap clusters (decisions about the same thing)

These ADRs cover the same problem space. None of the clusters has a single canonical entry.

| Cluster | ADRs | Canonical? | Master finding |
|---|---|---|---|
| **web3.js v2 migration** | 012, 033, 048, 087 | **No.** 087 (Solana Kit dual-stack) is the most recent and most specific; should be marked canonical with the others Superseded. | AUD-049 / AUD-077 |
| **mainnet deploy** | 031, 036, 077, 078, 079, 080, 084 | **No.** 080 is the most recent operational decision; 031 is the original; the rest are sub-aspects. Need a `MAINNET_CHECKLIST.md` ADR (currently a doc) to be the index. | AUD-050 / AUD-059 |
| **SAS integration** | 061, 062, 063, 064, 065, 066, 067, 076, 077, 081, 092 | Coherent within itself — 061 is the depth decision, 064 ships the resolver, 065 caches it, 076 hardens binding. | (positive) |
| **CPI trust** | 001, 002, 007, 014, 024, 068, 074, 094 | Layered evolution; 094 is the latest, 068 is the previous, and 007/014 are stale-Accepted. | AUD-002 / AUD-048 |
| **Vault allowlists** | 003, 006, 015, 044, 071, 072, 073, 093 | 071 partly drifted; 073 status-lies; otherwise coherent. | AUD-021 / AUD-082 |
| **SDK packaging** | 098 (×2), 099 (×2), 100, 119 | Two duplicate-numbered pairs to dedupe; 119 is Proposed and addresses C3. | AUD-003 / AUD-047 |
| **Audit-findings cluster** | 037, 038, 039, 040, 041, 042, 043, 044, 046, 047, 050 | 037 is the index; subsequent are sub-fixes from the audit findings. Path-drift epidemic in 040/041/043/044/047. | (governance) |
| **Naming** | 085, 086 | Both backfills; clean. | (positive) |

---

## Category 9 — Status / Date format inconsistencies

| Issue | Examples |
|---|---|
| Blank line between `## Status` and value (template says "immediately after") | ADR-015, 020, 021, 022, 023, 024, 025, 026, 027 |
| Blank line between `## Date` and value | Same group as above |
| Status with paragraph addendum | ADR-053 (good — explicit forward-link), ADR-054 (well-formed superseded note) |
| `### Positive` / `### Negative` subsections under Consequences (template asks for bullets) | ADR-001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 012, 013, 016, 017, 018, 019, 020, 028, 029, 030 — **template's bullet form is the minority style** |
| Pseudo-section headers inside Decision | ADR-007 has `### Why not a full Anchor CPI crate?` |
| Date format `YYYY-MM-DD` vs `YYYY-MM-DD HH:MM UTC` | ADR-037, 038, 039 use UTC form; rest use date-only |
| Missing `## Files Changed` (template doesn't require, but corpus-inconsistent) | ADR-019 omits; ADR-001 uses capital F/C |
| 30 ADRs sharing `2026-04-15` | ADR-001..ADR-030 all dated identically — backfill smell. The Date field cannot be the original decision date for 30 distinct decisions. |

**Action**: After ADR-098/099 dedup, write an ADR-style-guide ADR documenting the canonical patterns. Then `scripts/status-audit.sh` (per ADR-058 hygiene) should grep-fail on deviations.

---

## Category 10 — `status-audit.sh` is too narrow

The script is a stats-printer, not a governance gate. It does not detect:

- Duplicate ADR numbers (would have caught Category 1 immediately)
- Dead file-path citations (Category 5)
- Broken supersession-chain links (Category 4)
- Status-vs-code drift (Category 2 / 3)
- Mega-ADRs (Category 6)

**Action**: Extend `scripts/status-audit.sh` (or write `scripts/adr-lint.sh`) to enforce these. Wire to the `event-coverage.yml` style CI gate.

---

## Phase 3 prioritization (from this matrix)

Highest-leverage cleanups, in order:

1. **Dedupe 098/099** (15 minutes) — Category 1.
2. **Mark stale-Accepted ADRs Superseded or write successors** (1–2 hours) — Category 2; specifically 007, 014, 024, 038, 088, 098-client-sdk, 103.
3. **Flip 073 / 075 to Accepted with Revisions log** (15 minutes) — Category 3.
4. **Annotate de-facto supersessions** (1 hour) — Category 4; specifically 031→080, 068→094, 004→042, 032→085.
5. **Fix dead file-path citations** in 024/025/026/035/040/041/043/044/047 (30 minutes; mass `sed`) — Category 5.
6. **Land ADR-116 + ADR-119** as code (resolves AUD-001 + AUD-003) — flips two Aspirational to Accepted.
7. **Extend status-audit.sh** to detect everything in this matrix (1–2 days) — Category 10. Prevents recurrence.
8. **Consolidate web3.js v2 cluster**: mark 012, 033, 048 Superseded; ADR-087 is canonical — Category 8.
9. **Promote `MAINNET_CHECKLIST.md` to an ADR** with explicit gate criteria — Category 8 / AUD-059.
10. **Triage 106–113** with explicit exit criteria — Category 7.

These ten items are where the ADR system stops being a documentation graveyard and starts being load-bearing governance.

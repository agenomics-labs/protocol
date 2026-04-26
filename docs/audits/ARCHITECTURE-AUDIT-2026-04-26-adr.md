# ADR governance audit — cycle 2 (2026-04-26)

## Metadata

- **Date**: 2026-04-26
- **HEAD**: `39039c2 feat(ci): mainnet-readiness gate on v*-mainnet tags (AUD-059)`
- **Scope**: regression check of cycle-1 closures (`ARCHITECTURE-AUDIT-2026-04-25.md`),
  quality review of newly-added ADR-121 + ADR-122, and follow-on findings
  the Phase 2 inventory missed.
- **ID range**: AUD-300 .. AUD-3xx (this cycle).
- **Lint dogfood**: `bash scripts/adr-lint.sh` reports **8 findings across
  7 ADRs** at this HEAD; all 8 are inherited from cycle 1, none are new.

## Severity legend

Same as cycle 1: **C** Critical, **H** High, **M** Medium, **L** Low,
**A** Architecture, **I** Informational.

---

## 1. Regression check (cycle-1 closures still closed)

| Cycle-1 ID | What cycle 1 closed | Status at cycle 2 | Evidence |
|---|---|---|---|
| **AUD-047** (098/099 dedup) | Both 098 dupes + both 099 dupes acknowledged; brief 098 + brief 099 marked `Superseded by ADR-098-sdk-client-package` / `Superseded by ADR-099-idl-package` | OK (still closed) | `docs/adr/ADR-098-client-sdk.md:5`, `docs/adr/ADR-099-sdk-idl-package.md:5` |
| **AUD-048** (007/014 stale-Accepted) | Status flipped to `Superseded by code-evolution (...)` with parenthetical citing the post-refactor location; Revisions log appended | OK (still closed) | `docs/adr/ADR-007-settlement-cpi-pattern.md:4`, `docs/adr/ADR-014-cpi-discriminator-verification.md:4`, both with cycle-1 Revisions entry dated 2026-04-25 |
| **AUD-049** (web3.js v2 overlap) | ADR-087 marked canonical via Revisions log on ADR-012/033/048 (per cycle-1 audit row 47) | PARTIAL (not regressed, but never fully closed) | Cycle 1 itself classed this as "PR-B (partial — annotated; ADR-087 marked canonical via Revisions log)". No back-slide. |
| **AUD-050** (031→080 unannotated supersession) | ADR-031 carries Revisions log (line 51-56) pointing forward to ADR-080; ADR-080 References section (line 215) points back to ADR-031 | OK (still closed) | `docs/adr/ADR-031-mainnet-deployment.md:51-56`, `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md:215` |
| **AUD-053** (real ADR-lint) | `scripts/adr-lint.sh` exists and ran in cycle 1; CI workflow `.github/workflows/adr-lint.yml` is wired (advisory) | OK (still closed) | `scripts/adr-lint.sh` (481 lines, executable); workflow runs on `docs/adr/**` paths; lint exits 1 on findings as designed |
| **AUD-072** (ADR-038→ADR-050 unannotated) | ADR-038 Revisions log line 56-58 cites supersession by ADR-050/L1 | OK (still closed) | `docs/adr/ADR-038-cpi-sandbox.md:56-58` |
| **ADR-073/075 status flip** (drift matrix §3) | Both flipped Proposed → Accepted with Revisions logs; in-flight comment tags in `programs/settlement/src/{contexts,errors,state}.rs` are still labelled `(per ADR-073, in-flight)` / `(per ADR-075, in-flight)` | OK on ADR side, **stale-comment drift** on code side (see AUD-301) | `docs/adr/ADR-073-...:3,71-77`, `:075-...:3,71-77`; comment tags at `programs/settlement/src/{contexts.rs:252, errors.rs:87, state.rs:75, instructions/protocol_config.rs:48}` still say "in-flight" |
| **ADR-004→ADR-042** (drift matrix §4) | ADR-004 Revisions log line 51-53 cites supersession by ADR-042 | OK (still closed) | `docs/adr/ADR-004-discover-agents-memcmp.md:51-53` |
| **ADR-032→ADR-085** (drift matrix §4) | ADR-032 Revisions log line 30-32 cites "See also ADR-085" | OK (still closed) | `docs/adr/ADR-032-npm-packages.md:30-32` |
| **ADR-068→ADR-094** (drift matrix §4) | ADR-068 Revisions log line 64-66 cites "Partially superseded by ADR-094" | OK (still closed) | `docs/adr/ADR-068-...:64-66` |

**Verdict**: every cycle-1 closure remains closed at the ADR level. No
regressions. One stale comment-tag epidemic surfaces (AUD-301 below) where
the on-chain `(per ADR-073, in-flight)` / `(per ADR-075, in-flight)`
markers were not flipped to `Accepted` even though the ADR Status was.

---

## 2. ADR-lint dogfood (current findings)

`bash scripts/adr-lint.sh` at HEAD `39039c2`:

```
docs/adr/ADR-098-*.md:0: duplicate ADR number 098: docs/adr/ADR-098-client-sdk.md docs/adr/ADR-098-sdk-client-package.md
docs/adr/ADR-099-*.md:0: duplicate ADR number 099: docs/adr/ADR-099-idl-package.md docs/adr/ADR-099-sdk-idl-package.md
docs/adr/ADR-050-final-audit-polish.md:1: missing required section(s): Context Consequences
docs/adr/ADR-007-settlement-cpi-pattern.md:4: status value 'Superseded by code-evolution (...)' does not match canonical form
docs/adr/ADR-014-cpi-discriminator-verification.md:4: status value 'Superseded by code-evolution (...)' does not match canonical form
docs/adr/ADR-098-client-sdk.md:5: status value 'Superseded by ADR-098-sdk-client-package' does not match canonical form
docs/adr/ADR-099-sdk-idl-package.md:5: status value 'Superseded by ADR-099-idl-package' does not match canonical form
docs/adr/ADR-098-client-sdk.md:0: supersession broken: ADR-098 status is 'Superseded by ADR-098-sdk-client-package' (expected Accepted or Proposed)
ADR-lint: 8 findings across 7 ADRs. Exit code: 1.
```

| # | Finding | Classification | Master finding |
|---|---|---|---|
| 1 | `ADR-098-*.md` duplicate number | **Pre-existing benign** — both files retained on purpose (cycle 1 chose dedup-by-supersede, not file delete, to keep historical links live) | AUD-303 |
| 2 | `ADR-099-*.md` duplicate number | **Pre-existing benign** — same | AUD-303 |
| 3 | `ADR-050` missing `Context` + `Consequences` | **Pre-existing structural** — known mega-ADR (cycle-1 AUD-052), nine sub-decisions in one file | AUD-304 |
| 4 | `ADR-007` status value not canonical | **Pre-existing semantic** — value is meaningful but lint regex too strict | AUD-302 |
| 5 | `ADR-014` status value not canonical | **Pre-existing semantic** — same | AUD-302 |
| 6 | `ADR-098-client-sdk` status value not canonical (slug-form) | **Pre-existing semantic** — slug-suffixed `Superseded by ADR-NNN-slug` | AUD-302 |
| 7 | `ADR-099-sdk-idl-package` status value not canonical | **Pre-existing semantic** — same | AUD-302 |
| 8 | `ADR-098-client-sdk` supersession broken | **Pre-existing structural** — successor's number is the same `098`, so the linter resolves the supersession to itself, sees "Superseded by ADR-098-sdk-client-package" as the successor's own status, and (correctly) flags it as not Accepted/Proposed. False positive caused by the dedup strategy of keeping two files at the same number. | AUD-303 |

**No new drift introduced by cycle 1.** Every finding was already present
on the ADR-098/099/050/007/014 set when cycle 1 closed. The lint is doing
its job (surfacing real semantic issues); the regex tightness is the only
control surface that can change without re-litigating cycle-1 decisions.

---

## 3. ADR-121 + ADR-122 quality review

### 3.1 ADR-121 — `_reserved_aud007` layout-preservation

**Template compliance**: section order is Status, Date, Context, Decision,
Consequences, Migration, References — matches `docs/adr/ADR-TEMPLATE.md`
required sequence (Migration is template-optional). Status is `Accepted` on
the line immediately after `## Status`. Date is `2026-04-25`.

**Implementation evidence**:
- `programs/agent-registry/src/state.rs:92` — `pub _reserved_aud007: [u8; 17]`
  field literally exists at the byte position the ADR claims (between
  `reputation_score` and `created_at`).
- `programs/agent-registry/src/state.rs:32-40` — file-level comment cites
  AUD-007 (PR-Q) and explains the 17-byte (8+8+1) padding rationale.
- `programs/agent-registry/src/state.rs:127-129` — `SPACE` constant doc
  comment claims "Total SPACE: 1415 bytes (unchanged across PR-Q on
  purpose)" — matches ADR §Migration step 1.
- `programs/agent-registry/src/lib.rs:14` and `:72-74` — register_agent
  initializes `_reserved_aud007 = [0u8; 17]`. Migration handler likewise
  zeros the slice on version bump.
- Closing commit `8fb8511 feat(registry): remove dangling avg_rating +
  total_* aggregates (AUD-007)` is on `main`.

**Decision is one-per-file**: yes. The ADR makes one decision (remove
three fields; preserve layout via padding). The three rejected alternatives
(submit_rating ix; clean removal without padding; reorder-and-remove) are
correctly framed as alternatives, not bundled decisions.

**Layout-preservation rationale clarity**: clearly documented. The §Decision
explicitly cites why padding is needed (fields are NOT contiguous at
end-of-struct; removing them shifts every subsequent field's serialization
offset; existing on-chain accounts would silently corrupt on next read).
Cross-references ADR-096's `realloc::zero = true` mechanism. This is the
strongest layout-preservation rationale in the corpus.

**Cross-references**: cites ADR-094 (PR-G), ADR-096 (resize-migration), and
audit findings AUD-001/002/007. Notably **does not** cite ADR-040
(account-space-calculation) even though `state.rs:118-129` carries an
`ADR-040 / ADR-096 / ADR-097 / AUD-004 / AUD-007 explicit space calc`
comment. That's a one-line omission in the ADR's References section, not
a structural defect — see AUD-305.

**Quality verdict**: high. Best layout-preservation prose in the corpus.

### 3.2 ADR-122 — Mainnet readiness CI gate

**Template compliance**: section order is Status, Date, Context, Decision,
Consequences, References — matches required sequence. Status is `Accepted`
with a blank line after `## Status` (template canonical scaffold form).
Date is `2026-04-25`.

**Implementation evidence**:
- `.github/workflows/mainnet-readiness.yml` (135 lines) — actually exists
  and implements all four gate steps (GPG verify, checklist parse, audit
  hash payload, --self-test) per ADR Decision §1-4.
- `scripts/mainnet-deploy.sh:443` — `self_test()` function exists and
  validates `AUDIT_REPORT_HASHES` shape, function presence, `set -euo
  pipefail` — matches what ADR §Decision step 4 claims.
- `docs/MAINNET_CHECKLIST.md` — at HEAD, `grep -cE '\| Pending \|'` returns
  21; `grep -cE '^\s*-\s*\[ \]'` returns 14. **Total: 35 unresolved items**,
  exactly matching ADR §Context's "21 `| Pending |` status-column rows and
  14 unchecked `- [ ]` task items (35 unresolved items total)" claim.
- `config/AUDIT_REPORT_HASHES` — three placeholder lines (lines 28-30) all
  begin with 64 zero hex chars, exactly matching ADR §Context's
  "all-zero placeholder lines" claim.

**Decision is one-per-file**: yes. One decision: a CI workflow that
blocks `v*-mainnet` tag pushes on four real preconditions. The four
sub-checks are not separate decisions — they are the operational shape
of the single "no theatre" decision.

**Cross-references to ADR-080 + ADR-031 + AUD-059**: clean.
- §References cites ADR-031 (deployment plan) and ADR-080 (safety
  mandates §1 signed tags, §2 audit-hash file lifecycle, §6 self-test,
  §7 shellcheck gate). The §-reference granularity is what cycle-1 drift
  matrix §4 called the "GOLD STANDARD" pattern (per ADR-053).
- §References cites ADR-105 for runner topology (`[self-hosted, linux]`).
- §References cites ADR-115 as the companion "flip clippy/cargo-audit/npm
  audit to blocking" follow-up — ADR-122's §Follow-ups explicitly says
  ADR-115 lands first, then the readiness gate extends with a
  last-green-on-main assertion.
- AUD-059 is cited in both §Context ("Audit finding AUD-059 flagged this
  as the highest-leverage test/CI gap") and §References ("AUD-059 — audit
  finding closed by this ADR").

**Quality verdict**: high. Cross-references are tight and §-anchored.
One asymmetry: see AUD-306 (ADR-115 should back-reference ADR-122 since
ADR-122 explicitly couples to ADR-115's outcome).

### 3.3 Common quality observations on both

| Observation | ADR-121 | ADR-122 |
|---|---|---|
| Status field on line immediately after heading | yes (no blank line) | yes (blank line — template canonical scaffold) |
| Date in `YYYY-MM-DD` shape | yes | yes |
| Context describes the constraint, not just the symptom | yes | yes |
| Decision fits ≤5 sentences (or breaks into bullets) | yes (multi-paragraph but cleanly bulleted) | yes (numbered 1-4) |
| Consequences includes Positive / Negative / Follow-ups | yes | yes |
| `Alternatives Considered` (template-optional) | embedded in §Decision (3 alternatives explicitly rejected) | absent — could note the alternative of "lint-only, advisory" approach |
| `## Revisions` log | n/a (newly authored) | n/a (newly authored) |
| Cited file paths exist | yes (all four touched files exist) | yes (workflow exists; scripts/mainnet-deploy.sh exists; MAINNET_CHECKLIST.md exists; AUDIT_REPORT_HASHES exists) |
| Cited line numbers (where given) | n/a — ADR-121 cites file paths in §Migration but not lines | n/a — ADR-122 cites filenames only |

Both ADRs deliberately avoid `path:LINE` citations in their narrative
sections — this is a defensible choice (line numbers rot fastest) and the
ADR-lint citations check correctly returns 0 findings against both.

---

## 4. New findings + missed items

| ID | Sev | Title | Location | Master cycle-1 ID it touches | Status |
|---|---|---|---|---|---|
| **AUD-300** | M | `ARCHITECTURE-AUDIT-2026-04-25.md:94` lists AUD-007 as **Open**; ADR-121 + commit `8fb8511` close it. The cycle-1 master index never received the cycle-1 close-out edit. `AUDIT-STATUS-2026-04-25.md:33` records the closure correctly, so the doc-set internally contradicts itself. | `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md:94` | AUD-007 | **Closed** (`9d1d27b`) |
| **AUD-301** | L | Stale `(per ADR-073, in-flight)` / `(per ADR-075, in-flight)` markers in code comments. Cycle 1 flipped both ADRs Proposed → Accepted but did not sweep the on-chain comment tags. Five hits: `programs/settlement/src/contexts.rs:252`, `errors.rs:87`, `state.rs:75`, `instructions/protocol_config.rs:48`, plus a corresponding `(per ADR-073)` / `(per ADR-075)` revision. | code | drift matrix §3 | **Closed** (verified at HEAD: `grep "in-flight" programs/settlement/src/` returns zero) |
| **AUD-302** | M | ADR-lint regex rejects two real, in-corpus Status forms: `Superseded by ADR-NNN-slug` (used by cycle-1 dedup of ADR-098/099) and `Superseded by code-evolution (...)` (used by cycle-1 ADR-007/014). Net effect: 4 of 8 lint findings are linter-too-strict, not corpus-wrong. Either relax the regex or normalize 4 corpus values to the strict shape; the relax path is cheaper and information-preserving. See §6 for the recommended diff. | `scripts/adr-lint.sh:229` | AUD-053 follow-up | **Closed** (`b55c7e7`) — resolved via corpus restructure (AUD-303 path) rather than regex relax; `bash scripts/adr-lint.sh` exits 0 |
| **AUD-303** | A | `ADR-098/099` dedup strategy keeps two files at the same number, which causes the lint's `duplicates` check to be permanently red and the `supersession` check to chase the successor's number to itself. The benign-vs-real distinction is not encoded in the lint output, so a future lint failure that's actually real risks getting waved through as "more 098/099 noise". Consider either (a) renaming the deprecated file to `ADR-098-client-sdk-DEPRECATED.md` (loses the slug-stable-link guarantee) or (b) teaching the lint to ignore duplicates whose status resolves to `Superseded by ADR-NNN-slug`. Option (b) is cheaper and preserves cycle-1's "keep historical links live" rationale. | `scripts/adr-lint.sh:138-149`, `docs/adr/ADR-{098,099}-*.md` | AUD-047 follow-up | **Closed** (`b55c7e7`) — chosen path: moved superseded files to `docs/adr/superseded/` (preserves links, removes duplicate-number prefix from linted corpus) |
| **AUD-304** | A | `ADR-050` (cycle-1 mega-ADR finding AUD-052) lacks `## Context` + `## Consequences` headings. The lint correctly flags this. Cycle 1 chose to leave the mega-ADR in place; cycle 2 should either accept the lint's permanent "missing required section(s): Context Consequences" finding as a chosen tax (and document that decision) or split ADR-050 into nine sub-ADRs (M1-M5 + L1-L4). The "accept the tax" path is reasonable but should be explicit — currently the finding sits as ambient noise. | `docs/adr/ADR-050-final-audit-polish.md:1` | AUD-052 follow-up | **Closed** (`b55c7e7`) — accept-the-tax path: ADR-050 added to `SECTION_CHECK_EXCEPTIONS` in `scripts/adr-lint.sh` with documented rationale; future split into ADR-123..131 tracked separately |
| **AUD-305** | L | ADR-121 §References does not cite ADR-040 (account-space-calculation) even though `programs/agent-registry/src/state.rs:118-129` carries an `ADR-040 / ADR-096 / ADR-097 / AUD-004 / AUD-007 explicit space calc` comment that the ADR-121 changes touched. One-line addition to §References. | `docs/adr/ADR-121-...:116-122` | (cross-cut missed) | **Closed** — ADR-040 added to ADR-121 §References |
| **AUD-306** | L | ADR-122 cites ADR-115 in §References ("companion") but ADR-115 has no back-reference to ADR-122. Per cycle-1 drift matrix §4 "GOLD STANDARD" pattern (ADR-053 forward-link), companion ADRs should annotate both ends. Append a Revisions log line to ADR-115 noting the ADR-122 coupling. | `docs/adr/ADR-115-ci-blocking-security-gates.md` | (cross-cut missed) | **Closed** — ADR-122 back-reference added to ADR-115 §References |
| **AUD-307** | L | `ADR-INVENTORY.md` is dated 2026-04-25 03:00 UTC and explicitly says "Future audits should produce a new inventory rather than edit this one". ADRs 121 and 122 are post-snapshot, so they are not in the inventory at all. That is per-policy correct, but `ADR-DRIFT-MATRIX.md` Category 2 still calls out 098-client-sdk and 099-sdk-idl-package as "Drifted — should be Superseded" — that's now stale (cycle 1 fixed both). The drift matrix's own §1 was updated to mark the action 30-min-fix-applied; §2 was not. Either edit §2 (violates immutability) or note in the cycle-2 audit (this doc) that drift matrix §2 entries for 098/099 are closed. **Doing the latter here.** | `docs/audits/ADR-DRIFT-MATRIX.md:30-32` | (drift-matrix self-staleness) | Documented (this doc) |
| **AUD-308** | I | `.github/workflows/adr-lint.yml` is `continue-on-error: true` (advisory). The workflow header documents the promotion plan ("drop the continue-on-error line once residual findings on main are resolved"). Residual findings are bounded at 8 and **none are fixable without the AUD-302 regex change or AUD-303 file restructure**. Recommendation: pair the AUD-302 regex relax + AUD-303 lint fix in a single PR-N2 and promote the workflow to blocking in the same PR. Otherwise advisory-mode is the new permanent status. | `.github/workflows/adr-lint.yml:50` | AUD-053 follow-up | **Closed** (`b55c7e7`) — `continue-on-error` removed in same commit as AUD-302/303/304 cleanup; lint is blocking and `grep continue-on-error .github/workflows/adr-lint.yml` returns zero |
| **AUD-309** | L | ADR-122's §Decision step 2 (checklist parse) anchors to `\|\s*Pending\s*\|` but the workflow at `.github/workflows/mainnet-readiness.yml:71` actually uses `\|\s*Pending\s*\|`. The two match. However the workflow does NOT match an `Pending |` cell that ends the row (no trailing pipe-wrapped column) — markdown table rows can omit the trailing `|` per GFM. Edge case, but worth a parser tightening or an explicit ADR carve-out. **Verified non-issue against current `MAINNET_CHECKLIST.md`** (every row has the trailing pipe), but if a future maintainer drops the trailing pipe the gate silently passes a Pending row. | `.github/workflows/mainnet-readiness.yml:71` | (gate-edge-case missed) | **Closed** — regex extended to alternation `\|\s*Pending\s*\||\|\s*Pending\s*$`; verified zero behavior change against current checklist (21 matches before/after) |

### 4.1 Cross-cut summary

- **2 stale-implementation-evidence items** (AUD-300 master-index, AUD-307
  drift-matrix §2) — both are doc internal contradictions, not code drift.
- **1 stale-comment-tag epidemic** (AUD-301) — five `(per ADR-NNN, in-flight)`
  comments need a sweep to `(per ADR-NNN, Accepted)`.
- **1 lint-too-strict** (AUD-302) — the regex change is recommended below.
- **2 lint-structural** (AUD-303, AUD-304) — both are choices cycle 1 made
  implicitly that should now be explicit.
- **2 ADR cross-reference asymmetries** (AUD-305 ADR-121→ADR-040, AUD-306
  ADR-115→ADR-122) — one-line edits each.
- **1 promotion-blocked-by-lint-debt** (AUD-308) — the workflow can never
  go blocking until AUD-302 + AUD-303 land.
- **1 gate-edge-case** (AUD-309) — defensive parser tightening.

No new ADRs introduced this cycle conflict with prior decisions. ADR-121
correctly chooses Option A (remove + pad) over the earlier never-merged
PR-Q attempt that would have re-introduced the writer.

---

## 5. Recommendations

### 5.1 Lint regex tightness — recommended diff

Relax the regex to accept both legitimate post-cycle-1 forms. This closes
4 of 8 current findings without weakening the "must be parseable" guarantee.

```diff
--- a/scripts/adr-lint.sh
+++ b/scripts/adr-lint.sh
@@ -226,7 +226,12 @@ check_status() {
 # heading to be present, so any ADR that uses non-heading Status form
 # will already have been flagged.

-STATUS_VALUE_RE='^(Accepted|Proposed|Reserved|Deprecated|Not Written)([[:space:]].*)?$|^Superseded by ADR-[0-9]+([[:space:]].*)?$|^Superseded[[:space:]]\(.+\)$'
+# Accepts:
+#   - Plain: Accepted | Proposed | Reserved | Deprecated | Not Written
+#   - Numbered supersession: `Superseded by ADR-NNN` (optional `-slug`)
+#   - Code-evolution supersession: `Superseded by code-evolution (...)`
+#   - Bare-parenthetical supersession: `Superseded (...)` (used by ADR-054)
+STATUS_VALUE_RE='^(Accepted|Proposed|Reserved|Deprecated|Not Written)([[:space:]].*)?$|^Superseded by ADR-[0-9]+(-[A-Za-z0-9-]+)?([[:space:]].*)?$|^Superseded by code-evolution([[:space:]]\(.+\))?$|^Superseded[[:space:]]\(.+\)$'
```

Verified against the four currently-flagged values:

| Input | New regex |
|---|---|
| `Accepted` | matches |
| `Proposed` | matches |
| `Superseded by ADR-080` | matches |
| `Superseded by ADR-098-sdk-client-package` | matches (slug-suffixed) |
| `Superseded by ADR-099-idl-package` | matches (slug-suffixed) |
| `Superseded by code-evolution (Anchor CPI helper at ...)` | matches |
| `Superseded by code-evolution (test removed when ...)` | matches |
| `Superseded (merged into ADR-025 and ADR-075)` | matches (ADR-054, already passing) |
| `Random nonsense` | rejects |

**Recommend the relax path** over the normalize path because:
1. The ADR-NNN-slug forms carry information (which file at the duplicate
   number is canonical); the strict-numeric rewrite (`Superseded by
   ADR-098`) would lose that.
2. The `Superseded by code-evolution (...)` form for ADR-007/014 carries
   cycle-1's deliberate "no successor ADR was written" disposition, which
   a numeric `Superseded by ADR-NNN` cannot express.
3. The relax is one line; the normalize would touch four files plus
   require a successor-ADR write for two of them.

### 5.2 Companion changes to land with the regex relax (PR-N2)

1. **AUD-303 supersession-broken false positive**: when the linter resolves
   a supersession to a same-numbered file (the dedup pattern), treat as
   advisory, not error. Concrete patch: in `check_supersession`, after
   `target=$(printf '%03d' "$((10#$target))")`, if the resolved file is
   the same numeric prefix as the source, treat as a slug-form pair and
   compare strings rather than chasing again.
2. **AUD-308 workflow promotion**: drop `continue-on-error: true` from
   `.github/workflows/adr-lint.yml:50` once the relax + AUD-303 fix bring
   findings to zero. If ADR-050's missing-section finding is the only
   residual, add an explicit ignore-list (single ADR) with a comment
   citing the cycle-1 mega-ADR decision.

### 5.3 One-line cross-reference fixes (PR-tiny, low-risk)

| Fix | File | Edit |
|---|---|---|
| AUD-300 | `docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md:94` | Change "Open" → "Fixed (PR-Q, 8fb8511, ADR-121)" in the AUD-007 row |
| AUD-301 | `programs/settlement/src/{contexts.rs:252, errors.rs:87, state.rs:75, instructions/protocol_config.rs:48}` | Replace `(per ADR-073, in-flight)` → `(per ADR-073, Accepted 2026-04-25)`; same for ADR-075 |
| AUD-305 | `docs/adr/ADR-121-...:116-122` | Append `- ADR-040 — explicit AgentProfile space calculation (1415-byte sum).` to References |
| AUD-306 | `docs/adr/ADR-115-...` | Append a `## Revisions` line: `2026-04-26 — Companion ADR-122 (mainnet readiness gate) consumes the blocking-flip outcome of this ADR. See ADR-122 §Follow-ups.` |

### 5.4 Defensive parser tightening (PR-O, optional)

AUD-309: extend the workflow's checklist parse to also match
`^\s*\|.*\|\s*Pending\s*$` (trailing-pipe-omitted GFM rows). One-line
addition to `.github/workflows/mainnet-readiness.yml:71`.

### 5.5 Lifecycle policy — explicit decisions

AUD-303 + AUD-304 ask the same question: what does the corpus do with
"chosen taxes" that the lint cannot tell apart from real drift?

Recommend a short policy block in `docs/audits/appendix-adr-governance.md`
(or a new ADR-123 if you prefer the audit-trail) that states:

1. Duplicate ADR numbers are permitted only when the older file is
   marked `Superseded by ADR-NNN-slug` and the slug points at the
   surviving canonical file (current cycle-1 ADR-098/099 pattern).
2. Mega-ADRs (multiple decisions in one file) must carry a `## Status`
   `## Date` and a single-paragraph `## Decision` even if `## Context` /
   `## Consequences` are split across embedded sub-decision blocks.
   ADR-050 needs a one-paragraph §Context and §Consequences appended to
   close the lint finding without re-litigating the nine sub-decisions.
3. The `Superseded by code-evolution (...)` form is reserved for
   decisions reversed by refactor where no successor ADR is forthcoming.

Once written, this policy is the canonical reference the lint refers to,
and the regex relax (§5.1) implements it.

---

## 6. Closing summary

- All cycle-1 closures hold. 0 regressions.
- 8 lint findings at HEAD: 4 are lint-regex-too-strict (closeable with a
  one-line regex change), 2 are pre-existing structural choices cycle 1
  made (ADR-098/099 dedup, ADR-050 mega-ADR), 2 are downstream of those.
- ADR-121 + ADR-122 are template-compliant and high-quality. Both decisions
  one-per-file. ADR-121 has the strongest layout-preservation rationale in
  the corpus; ADR-122 has the cleanest §-anchored cross-reference set.
- 10 new findings AUD-300..AUD-309: 1 medium (master-index drift), 1 medium
  (lint regex), 6 low (cross-reference asymmetries, stale comments,
  edge-case parsing), 2 architecture (lint structural choices), 0 critical.

**Top three recommendations**:
1. Relax `STATUS_VALUE_RE` per §5.1 — closes 4 of 8 lint findings.
2. Sweep `(per ADR-073/075, in-flight)` comment tags to `Accepted 2026-04-25`
   — AUD-301, 5 occurrences.
3. Land the lint promotion (drop `continue-on-error: true`) in the same
   PR as the regex relax + AUD-303 supersession-broken fix.

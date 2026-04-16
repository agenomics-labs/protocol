# Status-Audit Template

This file is the **shape specification** for `docs/adr/STATUS-AUDIT-YYYY-MM-DD.md`
files produced at the end of significant sessions or milestones. It is
not itself an audit — it documents the sections every audit must have,
what each section answers, and who fills it in.

Use `scripts/status-audit.sh --write` to generate a new audit pre-populated
with mechanical data; then fill in the narrative sections and commit.

---

## Naming convention

```
docs/adr/STATUS-AUDIT-<YYYY-MM-DD>.md
```

One per significant session or milestone. Non-`ADR-` prefix because a
status audit is a **report about** the architecture, not an
architectural decision. Diffing two audits is a fast way to see "what
changed between these dates" without walking the full git log.

## When to produce an audit

- **Always** at the end of a session where ≥ 1 ADR landed, a paper version
  bumped, a benchmark number changed, or a user-facing command changed
- **On request** when a new agent or reviewer asks "where does the project
  stand?" — the audit answers that in ten seconds
- **Before any publication or release tag** — the audit is the
  pre-submission checklist

Audits are write-once-update-never. If state changes the next day,
write a new audit; do not edit yesterday's.

## Required sections

Every audit must have these ten sections, in this order. The `scripts/status-audit.sh`
skeleton produces the right section headers and fills in the mechanical
ones automatically.

### 1. Git state (auto)
`HEAD` sha, branch, origin sync status, working-tree clean flag. If ahead
of origin, note by how many commits and why they haven't been pushed.

### 2. Workspace layout (auto for crates, agent for narrative)
One-paragraph summary of the crate list and the module tree. If the
layout hasn't changed since the last audit, say so and link to the
prior audit.

### 3. ADRs (auto)
A table with one row per `docs/adr/ADR-NNN-*.md` file. Columns: number,
status, title. If any ADR status has stale text, fix the ADR file —
don't work around it in the audit.

### 4. Test totals (agent)
Exact counts from the full test matrix. Required commands:

```bash
cargo test -p evo --lib
cargo test -p evo --tests
cargo test -p evo-bepsilon --tests
cargo test -p evo-bepsilon --tests --features test-hooks
npm test
```

Reported as a table with one row per test target plus a grand total.
Every row is a specific integer, never a range or "approximately".
If any target has failing tests, the audit stops there — fix the tests
first, then re-audit.

### 5. Code hygiene (auto for clippy + LOC, agent for manual checks)
`cargo clippy -p evo` and `cargo clippy -p evo-bepsilon` warning counts.
`cargo build --workspace --release`, `npm run build:mcp`, and `tectonic`
paper compiles all need an agent-verified "clean" flag. Total LOC.
`unimplemented!()` site list (file names only). TODO/FIXME count.

### 6. Papers (auto list, agent for headlines)
Current PDF list with version, size, and a one-line headline result for
each paper. If a paper's headline number has changed since the last
audit, say so explicitly ("was X, now Y").

### 7. Runtime state (auto if release binary present, agent otherwise)
Output of `./target/release/evo stats`. If the release binary isn't
built, the template says so and directs the reader to
`docs/recursive-demo-runbook.md`. If a recursive-demo session has been
run, report `L2 strategies` count and whether the strategy is new this
audit.

### 8. Benchmark headlines (agent)
One row per benchmark with current numeric result and source file path.
If a result regressed since the last audit, flag it with ⚠ and note the
regression cause. If a result improved, flag it with ↑ and the delta.

### 9. Known gaps (agent)
Every genuinely-not-done item, ranked by severity. Format: numbered
list. For each item, say what it is, why it's not done, and what
unblocking it would require. Cross-reference against the previous
audit — an item that's been on the list for multiple audits is a
signal, not just a gap.

Also include a "Things the audit found clean" subsection. This is the
positive-space list: invariants that held, bugs that didn't return,
tests that covered the right thing. It's the evidence that the
previous audit's fixes stuck.

### 10. Recommended next moves (agent)
Four tiers:

- **Tier A — publication** (no code, external action only)
- **Tier B — follow-up** (small scoped work enabled by prior landings)
- **Tier C — remaining code work** (each item a standalone scoped task)
- **Tier D — exploratory** (paper 4+ material, research directions)

Each tier has a bulleted list of candidate tasks. Each task has an
estimated effort in hours or days. Tier A tasks are user-action; tiers
B-D are agent-executable.

### One-line verdict
Bottom of the file. A single sentence capturing the health of the
project at this instant. Should be copy-paste-able into a tweet or a
cover letter.

## Who fills what

| Section | Auto-filled by script | Agent-filled |
|---|---|---|
| 1 — git state | ✅ | — |
| 2 — workspace | crate list | module tree summary |
| 3 — ADRs | ✅ | — (but fix stale statuses at the source) |
| 4 — tests | — | ✅ (run the matrix) |
| 5 — hygiene | clippy + LOC | manual checks |
| 6 — papers | file list | headlines |
| 7 — runtime state | ✅ if binary exists | note if not |
| 8 — benchmarks | — | ✅ |
| 9 — known gaps | — | ✅ |
| 10 — next moves | — | ✅ |
| Verdict | — | ✅ |

## Procedure

```bash
# 1. Generate the skeleton
bash scripts/status-audit.sh --write

# 2. Run the test matrix and fill in section 4
cargo test -p evo --lib
cargo test -p evo --tests
cargo test -p evo-bepsilon --tests
cargo test -p evo-bepsilon --tests --features test-hooks
npm test

# 3. Fill in benchmarks (section 8) from the most recent bench runs.
#    If you haven't run them recently, run them.

# 4. Write the narrative sections (2, 5 manual, 6 headlines, 9, 10, verdict).

# 5. Re-read the file. Does the one-line verdict match the data?
#    Does the gaps list match reality? Does the next-moves list
#    actually enable tomorrow's work?

# 6. Commit.
git add docs/adr/STATUS-AUDIT-$(date +%Y-%m-%d).md
git commit -m "docs(adr): save $(date +%Y-%m-%d) status audit"

# 7. Push if appropriate.
git push origin main
```

## What a good audit looks like

The first audit under this template is `STATUS-AUDIT-2026-04-13.md`.
Use it as the reference for tone, section length, and level of detail.
An audit should be readable in under five minutes by a reviewer who has
never seen the project before — if it takes longer, the narrative
sections are too verbose; compress them and link to the underlying files.

## What a bad audit looks like

- Restates the previous audit without running any commands
- Uses ranges or approximate counts ("~200 tests") instead of exact numbers
- Has a verdict that contradicts the gap list
- Forgets to fix the stale ADR statuses the script surfaces
- Is longer than 400 lines (compress)
- Is shorter than 100 lines (underspecified)

If you find yourself writing an audit that matches any of those, stop
and ask: is this audit worth writing, or is the project not actually at
a milestone? Not every session needs an audit. The recurring-practice
convention is "at milestones" — sessions that didn't land anything
significant can skip it.

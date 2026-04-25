# ADR Template

This file is the **shape specification** for `docs/adr/ADR-NNN-<slug>.md`
files. It is not itself an ADR — it documents the canonical structure
every ADR is expected to follow so the corpus is auto-parseable
(status filtering, dashboards, CI gates).

Use `scripts/new-adr.sh "Decision title"` to scaffold a new ADR
pre-populated with the next available number, today's date, and a
slugged filename. Then fill in the narrative sections and commit.

---

## Naming convention

```
docs/adr/ADR-NNN-<short-kebab-slug>.md
```

- `NNN` is zero-padded to three digits, monotonically increasing.
- The slug is a short lowercase kebab phrase summarising the decision
  (e.g. `ADR-117-x402-relay-error-redaction.md`).
- One file per ADR. If a decision is later revised, write a new ADR
  that supersedes the old one — never edit the old file's intent.

## Required sections

Every ADR MUST have these sections, in this order, using `##` headings.
The script populates them; reviewers will reject ADRs that drop or
rename them. Optional sections may be added at the end.

### 1. Status

One of:

- `Accepted` — decision is in force.
- `Proposed` — drafted; not yet ratified or implemented.
- `Reserved` — placeholder; the number is held for a future decision.
- `Superseded by ADR-NNN` — replaced; readers should follow the link.
- `Deprecated` — no longer applies; kept for history.
- `Not Written` — numbering gap (rare; document why).

The status value is the line immediately after the `## Status` heading,
on its own line. Tools rely on that exact shape.

### 2. Date

ISO date `YYYY-MM-DD` on the line immediately after the `## Date`
heading. Use the original decision date — do not bump it on edits.

### 3. Context

What forced this decision. Concrete: what's true today, what
constraint the decision answers, who is affected. Past tense for
state-of-the-world claims; present tense for invariants.

### 4. Decision

What we are doing. Single paragraph; ≤ 5 sentences if possible. If a
decision needs more, break it into bullets — but the **first sentence**
must stand alone as a one-line summary suitable for a status audit.

### 5. Consequences

Both the wins and the costs. Three bullets minimum:

- **Positive**: what improves.
- **Negative**: what gets harder, what new failure modes appear.
- **Follow-ups**: explicit work items this decision opens (link to
  follow-on ADRs or issues if known).

## Optional sections (after Consequences)

- **Alternatives considered** — what was ruled out and why.
- **References** — papers, prior ADRs, audit findings, vendor docs.
- **Migration** — concrete steps if this changes a wire format /
  storage / API contract.

## Canonical scaffold

```markdown
# ADR-NNN: <Decision title>

## Status

Proposed

## Date

YYYY-MM-DD

## Context

<situation; constraints; what's true today>

## Decision

<single paragraph; first sentence stands alone as a one-line summary>

## Consequences

- **Positive**: <what improves>
- **Negative**: <what gets harder; new failure modes>
- **Follow-ups**: <explicit follow-on work items>
```

## What a good ADR looks like

- One decision per file. If a PR introduces two decisions, write two
  ADRs.
- Status transitions go through a separate ADR (e.g. ADR-054 marks
  itself `Superseded`; the new ADR-025/075 do the actual work).
- Dates do not lie. The Date is the original decision; if a revision
  ships, write a new ADR or add a `## Revisions` log at the bottom.
- Cross-links use ADR numbers, not file paths. `ADR-117` is stable;
  the slug is not.

## What a bad ADR looks like

- Status field hidden inside a metadata table or bold inline label
  (parser can't reliably find it).
- Decision section that spans pages (it's a decision, not a design
  doc — link out to the design doc if needed).
- "We may consider doing X" — that's not a decision; that's a draft
  meeting note. Either decide or stay in `Proposed`.
- Edits to a long-since-Accepted ADR that change its meaning.
  Decisions are immutable; revise via a new ADR.

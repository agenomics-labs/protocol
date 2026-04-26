# ADR-122: Mainnet Readiness CI Gate

## Status

Accepted

## Date

2026-04-25

## Context

ADR-031 (mainnet deployment) and ADR-080 (mainnet-deploy safety
mandates) define the rules for shipping to Solana mainnet-beta:
GPG-signed tags, an exhaustive `MAINNET_CHECKLIST.md` resolved end to
end, and `config/AUDIT_REPORT_HASHES` populated with auditor-supplied
SHA-256 hashes that `scripts/mainnet-deploy.sh` checks against the
rebuilt artifacts before any program is pushed.

The script `scripts/mainnet-deploy.sh --self-test` exists and is
invoked by `.github/workflows/shellcheck.yml` as a smoke test, but
nothing in CI is wired to the actual `v*-mainnet` tag namespace. As of
2026-04-25 `docs/MAINNET_CHECKLIST.md` carries 21 `| Pending |`
status-column rows and 14 unchecked `- [ ]` task items (35 unresolved
items total), and `config/AUDIT_REPORT_HASHES` ships with three
all-zero placeholder lines. Both states are the *intended* baseline
prior to an audit cycle — but neither is enforced. A maintainer who
pushed `v1.0.0-mainnet` today would not be stopped by any automation.

Audit finding **AUD-059** flagged this as the highest-leverage
test/CI gap: the documented gate was theatre because nothing read it.

## Decision

A new `mainnet-readiness.yml` workflow fires on `v*-mainnet` tag
pushes and blocks them by running four sequential, non-`continue-on-error`
steps:

1. **GPG signature**. `git tag -v "$TAG"` must succeed (ADR-080 §1).
2. **Checklist parse**. `docs/MAINNET_CHECKLIST.md` is grepped for
   `| Pending |` table cells *and* unchecked `- [ ]` task items.
   Either pattern is a hard fail. The `Pending` matcher is anchored
   to the table-cell shape (`\|\s*Pending\s*\|`) so descriptive prose
   that happens to mention "pending" does not trip the gate.
3. **Audit-hash payload**. `config/AUDIT_REPORT_HASHES` must exist,
   be non-empty after stripping comments, and contain zero lines that
   begin with 64 zero hex chars (the ADR-080 §2 placeholder shape).
4. **Script self-test**. `scripts/mainnet-deploy.sh --self-test`
   must exit 0. This re-uses the same self-test that
   `shellcheck.yml` already runs on every push to `main` — running
   it a second time at tag-push pins the script's gate logic to the
   exact tagged commit.

The workflow runs on `[self-hosted, linux]` to match every other CI
job in the repo (per ADR-105). The job is *blocking*: any failed
step exits non-zero, which prevents any tag-scoped downstream
workflow from observing a green readiness gate.

## Consequences

- **Positive**: AUD-059 closed. Mainnet readiness becomes a real
  precondition rather than a documented aspiration. The 35 unresolved
  rows in `MAINNET_CHECKLIST.md` and the placeholder hashes in
  `AUDIT_REPORT_HASHES` must each be resolved by the
  responsible owner — the gate refuses to skip any of them. The same
  maintainer who today could fat-finger `v1.0.0-mainnet` to push 21
  pending audit items into production gets a CI failure instead.
- **Negative**: First mainnet deploy carries non-zero process
  friction — every checklist row must be flipped from `Pending` to a
  resolved status, and the auditor must deliver real hashes for the
  three deploy artifacts before tag push. That work was always
  required; this ADR only refuses to skip it.
- **Follow-ups**:
  - PR-N (ADR-115) flips clippy / cargo-audit / npm-audit from
    `continue-on-error: true` to blocking. Once that lands, the
    readiness gate can extend with a step that asserts the
    last-green-on-`main`-for-the-tagged-commit invariant for those
    workflows, closing the "tagged a dirty commit" loophole.
  - Auditor delivery process must populate `config/AUDIT_REPORT_HASHES`
    with real SHA-256 values; the file's header comment already
    documents the lifecycle.
  - The checklist parser is regex-based and cannot tell a freshly
    "Done"-marked row from a row that was lying. Process discipline
    (PR review of the row flip + auditor sign-off) remains the only
    backstop for the *content* of each row; the gate only enforces
    that no row is left in the explicitly-pending state.

## References

- ADR-031 — mainnet deployment plan.
- ADR-080 — mainnet-deploy safety mandates (§1 signed tags, §2
  audit-hash file lifecycle, §6 self-test, §7 shellcheck gate).
- ADR-105 — CI runs on self-hosted Linux runners.
- ADR-115 — CI security gates flip to blocking (companion).
- AUD-059 — audit finding closed by this ADR.
- `.github/workflows/mainnet-readiness.yml` — the workflow.
- `.github/workflows/shellcheck.yml` — sibling workflow that
  already invokes the same `--self-test` on every `main` push.

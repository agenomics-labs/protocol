# ADR-123: Self-Hosted Runner Action-Cache Hardening (AUD-406)

## Status

Accepted

## Date

2026-04-26

## Context

The cycle-2 architecture audit found that ~60% of CI failure volume on
this repo's self-hosted runners (`flow-self-hosted{,-2,-3,-4}`) was a
single failure pattern, recorded in
`docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md` as AUD-406:

```
Download action repository 'actions/cache@<sha>' (SHA:<sha>)
##[warning]Failed to download action 'https://api.github.com/.../tarball/<sha>'.
  Error: The request was canceled due to the configured HttpClient.Timeout
  of 100 seconds elapsing.
##[error]Failed to download archive ... after 3 attempts.
```

The runner agent (`actions/runner` v2.334.0 at the time of writing)
fetches every `uses: <owner>/<repo>@<ref>` reference from
`api.github.com/repos/<repo>/tarball/<ref>` on first use. Connectivity
between the runners and api.github.com is intermittent: the 100 s
HttpClient timeout the agent enforces is hit often enough that the
flake is observable on roughly 60% of CI runs as a job-killing failure.

The audit enumerated three mitigation tiers, in increasing cost:

  1. Pre-cache critical action tarballs on each runner under
     `_work/_actions/<owner>/<repo>/<ref>/` so the agent finds the
     content locally and skips the api.github.com fetch.
  2. Pin every `uses:` reference to a 40-char commit SHA *and* commit
     a one-shot script to seed the runner cache from those SHAs.
  3. Vendor each external action into `.github/actions/<name>/` and
     reference the path with `uses: ./.github/actions/<name>`. The
     runner reads from the workspace tree and the action tarball is
     never fetched.

A fourth, off-menu option — switching from `Pending` to a paid
`GitHub Enterprise` tier — was considered and rejected: the flake is
network-level (api.github.com timeout), not rate-limit or feature-gate;
neither GitHub Team nor Enterprise Cloud changes the api.github.com
fetch path or the runner agent's 100 s timeout. Only GitHub Enterprise
Server (on-prem GitHub) would route through an internal mirror, and
that carries operational cost orders of magnitude higher than any of
the three audit-recommended tiers.

## Decision

Adopt a **hybrid** of all three tiers, applied selectively:

  - **Tier 2 universally**: every external `uses:` reference in
    `.github/workflows/` is SHA-pinned to a 40-char commit SHA with
    an inline `# pin v<major> (AUD-406)` comment. ADR-114's
    `dependabot.yml` already covers the `github-actions` ecosystem,
    so SHAs and the inline-comment versions auto-bump together on a
    weekly cadence.
  - **Tier 3 selectively** for `trufflesecurity/trufflehog`: the only
    action in our workflows that tracked a moving `@main` ref. The
    composite-action source (`action.yml` only) is vendored to
    `.github/actions/trufflehog/` with a sibling `UPSTREAM` file that
    records the source SHA, version snapshot, vendor date, and a
    re-vendor procedure.
  - **Tier 1 as bookkeeping**: `scripts/seed-runner-action-cache.sh`
    auto-discovers `uses:` refs from `.github/workflows/`, fetches each
    tarball once via `gh api`, and mirrors it to every runner under a
    glob (default `/home/neo/actions-runner*`). Idempotent, dry-run
    available. **See Limitation below — this is not a stand-alone fix
    on its own.**

The remaining six external actions (`actions/{checkout,setup-node,cache,
download-artifact,upload-artifact}`, `softprops/action-gh-release`) stay
SHA-pinned but **not** vendored. Rationale: they are first-party (or in
the case of `softprops`, broadly-trusted), Dependabot maintains them on
a weekly cadence, and the upgrade flow stays mechanical. Vendoring them
would impose manual re-vendor PRs without measurable additional flake
reduction (the runner's behavior — see Limitation — defeats the
seed-script approach equally for SHA-pinned and version-tagged refs).

## Limitation discovered during rollout

Empirical observation: `actions/runner` v2.334.0 **does not honor a
pre-seeded `_work/_actions/<owner>/<repo>/<ref>/` directory**. The
worker log records, at the start of each job:

```
[INFO ActionManager] Save archive
  'https://api.github.com/repos/actions/checkout/tarball/<sha>'
  into /home/neo/actions-runner/_work/_actions/_temp_<uuid>/<n>.tar.gz
```

The agent unconditionally re-downloads the tarball into a fresh
`_temp_<uuid>/` directory and only consults `_actions/<owner>/<repo>/
<ref>/` after a successful fetch (the post-fetch move is what populates
the cache for *subsequent* jobs on that runner). Cross-job persistence
exists, but pre-seeded content from outside the agent's own download
path is not trusted.

Practical consequence:

  - **Vendored actions (Tier 3)** are unaffected — `uses: ./...`
    bypasses `_actions/` entirely. The vendored trufflehog hits zero
    api.github.com fetches.
  - **The seed script (Tier 1)** is no longer a flake-prevention tool;
    it is reduced to a bookkeeping/audit artifact (provable
    reproducibility, runbook documentation, fast warm-up after a
    runner is reprovisioned).
  - **SHA-pinning (Tier 2)** still earns its keep: pinned refs are
    Dependabot-trackable, and each ref is a deterministic input to
    the cache-key path the agent constructs after a successful fetch.

The runner agent's behavior is the relevant constraint here, and
investigating whether a future agent version (or a configuration knob
we have not yet found) would honor the pre-seeded content is left as
an open follow-up; tracked in the AUD-406 closure note in
`docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md`.

## Consequences

  - Trufflehog Secret Scan job is **bullet-proof** against AUD-406:
    no api.github.com fetch path remains. Validated on the run that
    landed `bf12506` — Secret Scan passed cleanly while a peer
    job (`Security Audit`) hit the same AUD-406 flake on
    `actions/cache@<sha>`.
  - Dependabot-driven SHA bumps now produce uniform diffs across the
    six pinned actions. Reviewers can read each PR as a one-line SHA
    change and trust the inline `# pin v<major>` comment for context.
  - Workflow YAML is more verbose (40-char SHAs vs. `@v6`) but each
    `uses:` line is now self-describing as to what's pinned and why
    (the `(AUD-406)` tag).
  - When a Dependabot PR lands, a maintainer must re-run
    `scripts/seed-runner-action-cache.sh` on each runner (the script
    is idempotent so this can be a routine). The script's runbook is
    in its file header.
  - The remaining six SHA-pinned actions retain a residual flake
    surface bounded by the runner agent's behavior. The accepted
    response is the AUD-406 rerun reflex: when CI fails with an
    api.github.com tarball-timeout, `gh run rerun <id> --failed`
    is the first action; reverting is appropriate only if the failure
    log differs from the canonical AUD-406 pattern.
  - If the residual flake rate proves unacceptable, the documented
    escalation is to extend the Tier-3 vendoring sweep to cover the
    remaining six actions. The `.github/actions/trufflehog/` shape
    serves as the template; each additional vendor PR is small and
    independent.

## References

  - `docs/audits/ARCHITECTURE-AUDIT-2026-04-26-tests-ci.md` — AUD-406
    finding text + the three-tier mitigation menu this ADR adopts.
  - ADR-114 — Dependabot dependency hygiene (already covers the
    `github-actions` ecosystem).
  - ADR-115 — CI blocking-security-gates (companion; the gates this
    ADR's mitigation keeps green).
  - ADR-122 — Mainnet readiness CI gate (downstream consumer of these
    workflows).
  - `.github/actions/trufflehog/UPSTREAM` — vendor provenance + the
    re-vendor procedure for the one fully Tier-3 action.
  - `scripts/seed-runner-action-cache.sh` — Tier 1 script preserved
    for bookkeeping per the Limitation section above.

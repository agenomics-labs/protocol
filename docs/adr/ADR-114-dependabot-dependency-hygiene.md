# ADR-114: Dependabot-based automated dependency hygiene

## Status
Accepted

## Date
2026-04-24

## Context

The 2026-04-18 re-audit (`docs/ARCHITECTURE_REAUDIT_2026-04.md`) flagged
`S-xcut-09` — absence of Dependabot/Renovate. The 2026-04-24 re-audit
(`docs/ARCHITECTURE_REAUDIT_2026-05.md`, R-xcut-03) verifies the gap is
still open: no `.github/dependabot.yml`, no `renovate.json`. Cargo and
npm dependency drift is manual-only; security patches surface late; CI
does not reflect new advisories until someone runs `cargo audit` or
`npm audit` by hand.

Three ecosystems need coverage:
1. **Cargo** (three on-chain programs + root workspace).
2. **npm** (root, `mcp-server/`, `src/indexer/`, `src/x402-relay/`,
   `sdk/client/`, `sdk/idl/`, `packages/capability-manifest-validator/`,
   `packages/sas-resolver/`).
3. **GitHub Actions** (per S-xcut-06; already pinned to major tags,
   but bumps between majors need to surface somehow).

## Decision

Add `.github/dependabot.yml` with three `package-ecosystem` entries
covering cargo, npm, and github-actions. Weekly cadence, labeled
`dependencies`. Direct-only updates by default (no transitive churn
noise). Group security patches into a single PR per ecosystem per week.
PR body auto-links to changelogs where Dependabot supports it.

Key policy points:
- **Reviewers:** `@agenomics-labs/core` (create the team label if it
  does not exist; the YAML `reviewers:` key is optional if the team is
  missing and the hook will no-op gracefully).
- **Versioning strategy:** `increase` for the root workspace,
  `increase-if-necessary` for leaf services so lockfile pins are
  preserved per ADR-089. **(Amended 2026-05-09):** GitHub's dependabot
  schema now accepts only `auto` or `lockfile-only` for the `cargo`
  ecosystem (npm still accepts `increase` / `increase-if-necessary`).
  Cargo at `/` therefore uses `auto`; the intent is preserved (root
  workspace gets Cargo.toml bumps when direct-dep ranges demand it,
  leaf workspaces inherit). npm entries unchanged.
- **Auto-merge:** none at first. Every Dependabot PR goes through the
  normal CI gate. Once the CI wall is fully blocking (see ADR-115),
  consider auto-merging patch-level bumps that pass all gates.
- **Ignore list:** none. The point is visibility. **(Amended
  2026-05-12):** Visibility has been achieved — the first major-bump
  wave (44 PRs across 18 ecosystems) was surfaced, triaged, and
  documented in issue #149. `@dependabot ignore this major version` is
  permitted **only** for PRs in a documented major-bump wave, where a
  tracking issue lists (a) the package, (b) current major → blocked
  major, (c) the reason the major is deferred, and (d) the revisit
  trigger. Without a tracking issue, `ignore` remains disallowed. Patch
  and minor bumps stay on the original policy (no ignore). When a
  deferred bump's revisit trigger fires, the tracking issue is updated
  and the next Dependabot PR for that bump is merged through the
  normal flow.

## Consequences

- ~10-20 Dependabot PRs per week in the steady state. Bounded by
  group-security-updates: true so advisories surface as a single PR.
- Staleness gap closes: previously a new RustSec advisory sat invisible
  until someone ran `cargo audit`; now it triggers a bump PR.
- Complements ADR-115 (advisory→blocking flip). Without advisory-level
  CI gates, Dependabot PRs will mostly be silently green; once ADR-115
  lands, they become the actionable surface for security fixes.

## References

- `docs/ARCHITECTURE_REAUDIT_2026-04.md` S-xcut-09 (prior-audit gap).
- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-xcut-03.
- `docs/adr/ADR-089-reproducible-installs.md` (lockfile canon).
- `docs/adr/ADR-115-ci-blocking-security-gates.md` (companion).

## Revisions

- 2026-04-26 — Implemented: .github/dependabot.yml landed. Cargo +
  npm + github-actions ecosystems on weekly cadence with grouped
  security patches. Major bumps for Anchor / web3.js / better-sqlite3
  / React / Tailwind deferred per the dep-tier policy in
  AUDIT-STATUS-2026-04-26.md.
- 2026-05-12 — Amended Decision §"Ignore list" to permit
  `@dependabot ignore this major version` for documented major-bump
  waves. Triggered by the 44-PR / 18-ecosystem major-bump wave that
  exceeded the `open-pull-requests-limit: 10` per ecosystem as
  React 19, Anchor 1.0, TypeScript 6, Tailwind 4, Express 5, zod 4,
  @types/node 25, and 11 other ecosystems simultaneously crossed
  major boundaries. The wave triage and ignore-list rationale live in
  issue #149; the dep tier policy in AUDIT-STATUS-2026-04-26.md is
  superseded by the tracker for the major-bump dimension. Patch /
  minor bumps remain on the original no-ignore posture.

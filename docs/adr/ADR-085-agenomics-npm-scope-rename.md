# ADR-085: npm distribution scope rename `@aep/*` → `@agenomics/*`

## Status
Accepted

## Date
2026-04-23 (backfill — decision is live in production via PR #19, commit `840e60e`)

## Context

PR #19 (`chore: rename npm scope @aep/* -> @agenomics/* for publishing`, commit `840e60e`, merged 2026-04-21) renamed the npm distribution scope for all four publishable AEP packages from `@aep/*` to `@agenomics/*`:

- `@aep/capability-manifest-validator` → `@agenomics/capability-manifest-validator`
- `@aep/sas-resolver` → `@agenomics/sas-resolver`
- `@aep/mcp-server` → `@agenomics/mcp-server`
- `@aep/idl` → `@agenomics/idl`

The scope rename was driven by ecosystem contention on the `@aep` npm scope (per `docs/STATUS.md §2`: *"npm scope: `@agenomics/*` (not `@aep/*` — ecosystem contention; see PR #19)"*), captured in the PR description as: *"`@aep` on npm is unowned but contested — `@aep_dev/aep-explorer`, `@mobilesentrix/ms-aep-validator`, and a couple Adobe `aep*` packages already exist; squatter risk is real. `@agenomics` is completely clean on npm (org endpoint 404, zero public packages under the scope)."*

PR #19 was a 24-file, 71-insertion / 71-deletion sweep affecting only `package.json` files, internal workspace dependency edges, and import statements that referenced the scoped name explicitly. **Code-level identifiers (env vars `AEP_*`, types `AepError`, PDA seeds `AEP_PROTOCOL` / `AEP_VALIDATORS`, bin `aep-mcp`, ADR text) were unchanged** — the rename is strictly distribution-layer.

No ADR documented the scope decision when it landed; this ADR backfills the rationale per the architecture audit's missing-ADR finding (F-4 / F-5 / F-6).

## Decision

Adopt the **org-brand-for-distribution, protocol-acronym-in-code** pattern. Specifically:

- **npm scope**: `@agenomics/*` for all publishable packages.
- **GitHub org**: `agenomics-labs/protocol`.
- **Protocol acronym in code**: `AEP` (Agent Economy Protocol implemented by Agenomics) — unchanged.
- **Env vars / types / PDA seeds / CLI bin names**: continue to use `AEP_*` / `aep-*` — no rename.

## Alternatives Considered

- **Use `@aep/*` and squat the scope.** Rejected — `@aep` is unowned but contested; the surrounding `aep*` namespace on npm (`@aep_dev/aep-explorer`, `@mobilesentrix/ms-aep-validator`, several Adobe `aep*` packages) creates real squatter / typo-confusion / brand-spoof risk. Even if AEP claimed `@aep` first, defending the scope's reputation against unrelated `aep*`-prefixed packages is operational toil with no upside.
- **Use `@agenomics-labs/*` matching the GitHub org.** Rejected — `@agenomics` is shorter, the org-vs-brand split adds no information for npm consumers, and the homepage is `agenomics.xyz` not `agenomics-labs.xyz`. Brand-first beats org-first for distribution.
- **Use a single un-scoped name (e.g., `aep-sas-resolver`).** Rejected — un-scoped npm names are first-come-first-served at the global namespace, even more vulnerable to squatting / typo-confusion than a scope, and break the convention of grouping related packages under one scope.
- **Rename code-level identifiers to `AGENOMICS_*` to match the npm scope.** Rejected — code identifiers (`AEP_PROTOCOL`, `AepError`) refer to the **technical protocol**, not the brand. The protocol is named AEP and is implementable by entities other than Agenomics; the brand is Agenomics. Pattern: org brand for distribution, protocol acronym in code. This split is deliberate per `docs/STATUS.md §2`.

## Consequences

### Positive
- npm scope `@agenomics` is clean (org endpoint 404 at PR-merge time, zero public packages under the scope) — removes squatter / brand-spoof risk that `@aep` carried.
- Brand alignment for npm consumers (the homepage and the npm org match).
- Code-level identifiers remain protocol-anchored (`AEP_*`), preserving the "protocol implementable by other entities" framing in the technical surface.
- One-time migration; no repeating cost.

### Negative
- Every consumer who took an early dep on `@aep/*` must update their `package.json`. Mitigated by the fact that no `@aep/*` package was ever published to the npm registry — the scope rename happened pre-publish (per `docs/STATUS.md §5`, v0.1.0 publish is on hold).
- Two names for the same project surface area (Agenomics for distribution, AEP for the protocol) requires the split to be documented for every onboarding contributor. Captured in `docs/STATUS.md §2` and now this ADR.

### Neutral
- ADR text continues to reference "AEP" throughout — no ADR rewrites needed.
- npm org `@agenomics` claimed at https://www.npmjs.com/org/agenomics per `docs/STATUS.md §5`.

## References
- PR #19, commit `840e60e` — `chore: rename npm scope @aep/* -> @agenomics/* for publishing`
- `docs/STATUS.md` §2 ("Acronym / brand"), §5 ("npm publishing state")
- `docs/adr/ADR-086-aeap-to-aep-rename.md` — companion code-level acronym rename (PR #18, commit `0903670`)
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-4 / F-5 / F-6 (missing-ADR backfill obligation)

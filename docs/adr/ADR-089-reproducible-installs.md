# ADR-089: Reproducible installs — npm workspaces, committed lockfile, `npm ci` everywhere

## Status
Accepted

## Date
2026-04-23

## Context

The TypeScript side of the protocol is split across six packages:

- `packages/capability-manifest-validator` (ADR-060)
- `packages/sas-resolver` (ADR-064)
- `mcp-server` (ADR-027)
- `src/indexer` (ADR-016)
- `src/x402-relay` (ADR-017)
- `dashboard` (ADR-035)

Architecture-Audit-2026-04-23 finding T-01 / C-04 surfaced the operational shape:

1. **`package-lock.json` was gitignored** (`.gitignore:15` pre-change). Every contributor's local install resolved transitive deps independently — an `^x.y.z` spec floated, and CI's `npm install` resolved them yet again at every run. The audit's words: *"contributors and CI saw four different shapes of the same dependency graph in the same week."*
2. **Each package had (or could grow) its own `package-lock.json`** when somebody ran `npm install` inside that subdirectory. Five lockfiles totalling ~568 KB existed locally but were not committed, so they could not act as the source of truth.
3. **CI used `npm install --no-audit --no-fund`** in every workflow step (`ci.yml` 5 occurrences, `publish.yml` 3 occurrences). `npm install` is allowed to mutate `package-lock.json` and floats versions inside the spec range; `npm ci` is bit-for-bit deterministic against a committed lockfile but errors out without one.
4. **No npm workspaces declaration at the root**, so `npm install` at the repo root only installed the root's deps; each package required its own `cd <pkg> && npm install`. CI scripts already had ~9 such shell hops.

The combined effect: a fresh CI run could legitimately install a different transitive dep set than the prior one, and a contributor could legitimately commit code that worked locally but failed CI on a dep version their local tree happened to pin.

This is a Tier-2 reproducibility gap — it does not change protocol behaviour, but it does mean that supply-chain-attack surface (a malicious release of a transitive dep) is silently visible to anyone running `npm install` against `^`-pinned ranges. It also means that `Cargo.lock` is committed for the Rust side (correctly) while the TypeScript side runs an inconsistent policy.

## Decision

### 1. npm workspaces at the root

Root `package.json` declares `"private": true` and a `"workspaces"` array enumerating every TypeScript package in the repo:

```json
{
  "private": true,
  "workspaces": [
    "packages/*",
    "mcp-server",
    "src/indexer",
    "src/x402-relay",
    "dashboard"
  ]
}
```

Effect: a single `npm install` (or `npm ci`) from the repo root installs every workspace member's deps into a hoisted `node_modules/` at the root, with workspace-local node_modules directories only when version conflicts force a duplicate. The five `@agenomics/*` packages link to each other via `file:` deps already; npm workspaces makes those links concrete symlinks under the hoisted tree.

### 2. Committed unified lockfile

`.gitignore` is updated to **remove** `package-lock.json` from the gitignore list. The unified root lockfile (`/package-lock.json`) is the single source of truth for every workspace member's transitive deps. No per-workspace lockfiles are committed; npm workspaces does not create them — the root lockfile alone records every workspace member's resolved tree.

Concrete numbers from the migration:

- Pre-change (sum of 5 per-workspace lockfiles, untracked, plus an outdated root one): **568,080 bytes** (~555 KB).
- Post-change (single committed root lockfile, including the two `pino` packages added by ADR-090): **354,899 bytes** (~347 KB).
- Reduction: **213,181 bytes (~208 KB, 37.5% smaller)** — and that with strictly more deps than before.

The reduction is because the per-workspace lockfiles each independently recorded shared transitive deps (e.g., `@solana/web3.js` was in three of them).

### 3. `npm ci` in every CI workflow

Every `.github/workflows/*.yml` step that installs deps switches from `npm install --no-audit --no-fund` to `npm ci --no-audit --no-fund`, run **once at the workspace root** rather than per-workspace. Subsequent build/test steps invoke per-workspace scripts via `npm run <script> --workspace @agenomics/<name>` against the hoisted tree.

`npm ci` semantics:

- Errors if `package.json` and `package-lock.json` disagree.
- Never writes to the lockfile.
- Always wipes and re-creates `node_modules` (deterministic install state).
- ~2× faster than `npm install` on cold cache because it skips the resolver phase.

### 4. Lockfile-determinism CI gate

A new job `lockfile-determinism` in `ci.yml` runs `npm ci` against the committed lockfile, snapshots `sha256(package-lock.json)` before and after, and fails if the file is rewritten. This catches the case where a contributor edits `package.json` (adds/bumps a dep) without running `npm install` locally to regenerate the lockfile — which would otherwise pass `npm ci` only on their machine but fail on the next CI run after the lockfile was silently regenerated by a different developer.

The gate is the deliverable's "smoke test that `npm ci` from a clean clone produces an identical node_modules tree to the lockfile-pinned tree."

### 5. Per-workspace `npm install` is forbidden

Documentation (this ADR + `CONTRIBUTING.md` follow-up) makes it explicit: contributors run `npm install` ONCE at the repo root. `cd packages/sas-resolver && npm install` is the wrong command — it would create a stray `packages/sas-resolver/package-lock.json` and `packages/sas-resolver/node_modules/`, both of which the root install handles.

If a contributor needs to add a dep to a single workspace member, the canonical form is:

```bash
npm install <pkg> --workspace @agenomics/sas-resolver
```

Run from the repo root, this updates `packages/sas-resolver/package.json` and the unified root lockfile in one transaction.

## Alternatives Considered

### Alternative A: Commit per-workspace lockfiles, keep workspaces undeclared

Five committed lockfiles. Rejected: the audit's "four shapes of the same dependency graph in the same week" failure mode is the consequence of N independent lockfiles for shared transitive deps. Five lockfiles is four chances for them to disagree about, e.g., `@solana/web3.js` patch versions.

### Alternative B: pnpm or yarn workspaces

Both have superior workspace ergonomics. Rejected: Cargo + npm is the existing toolchain; introducing a third package manager (pnpm or yarn) raises the contributor onboarding cost and adds a CI dependency. npm workspaces shipped with npm 7 (2020) and is mature enough for this scope.

### Alternative C: Don't lock at all; trust `^` ranges

The status quo. Rejected — see Context. The supply-chain visibility gap alone justifies the change.

### Alternative D: Lock only top-level deps, not transitive

Some shops commit `package-lock.json` but ignore `node_modules` and resolve transitive deps fresh. Not possible: `package-lock.json` IS the transitive resolution. There is no middle ground here.

### Alternative E: Per-PR lockfile rebase via Renovate / Dependabot

Useful as a follow-up (out of scope for this ADR). Compatible with the decision: a bot bumps the unified lockfile and CI's lockfile-determinism gate verifies the bump is internally consistent.

## Consequences

### Positive

- **One install reproduces every contributor's dep tree.** `git clone && npm ci` produces a bit-identical `node_modules` tree to CI and to every other contributor.
- **Supply-chain visibility.** A new transitive dep version requires a lockfile change → diff → review.
- **Faster CI.** `npm ci` skips the resolver phase; the new `lockfile-determinism` job is the only place that runs the slow path, and it's deliberately scoped to one job.
- **Cross-package dev experience.** Editing `packages/sas-resolver` and re-testing `mcp-server` works without `npm link` — the workspaces already symlink them.
- **Lockfile size reduction.** ~37.5% smaller than the per-workspace sum (counter-intuitive but real — shared transitive deps deduplicate at the root).

### Negative

- **Contributors learning curve.** "Always install at the root" is a new rule. Mitigated by the `lockfile-determinism` gate — accidental local-install drift fails CI loudly.
- **Lockfile churn in PRs.** Adding a single dep now touches a 350 KB file. Reviewers will see large lockfile diffs; mitigated by GitHub's generated-file collapse heuristic (it recognizes `package-lock.json` as such).
- **Hoisting surprises.** A workspace member can accidentally import a dep declared by a sibling workspace member because the hoisted node_modules makes everything resolvable. Mitigated by per-workspace `npx tsc --noEmit` in CI catching unauthorized cross-imports at type-check time.
- **dashboard added to workspaces.** Dashboard's deps (Vite, React, Tailwind) now resolve into the root tree alongside the server-side deps. No conflict observed at install time, but it is more deps loaded on every CI run. If this becomes a problem we can migrate dashboard out of the workspaces array (it has no import dependency on the rest).

### Neutral

- **Nothing changes for the Rust side.** `Cargo.lock` was already committed; this ADR is TypeScript-only.
- **`npm test` per workspace still works as before**, just from the root with `--workspace`.
- **No version bumps required.** Deps are resolved fresh by the unified install but pinned to the same `^` ranges in package.json; the lockfile records the actual resolution.

## References

- `package.json` — root workspaces declaration
- `package-lock.json` — committed unified lockfile (ADR-089 §2)
- `.gitignore` — `package-lock.json` removed from ignore list (ADR-089 §2)
- `.github/workflows/ci.yml` — `npm ci` everywhere + `lockfile-determinism` job (ADR-089 §3, §4)
- `.github/workflows/publish.yml` — `npm ci` for pre-publish verify + publish jobs (ADR-089 §3)
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` items 13 / T-01 / C-04 — the audit findings this ADR closes
- ADR-090 — structured logging across off-chain services (rolls into the same install surface)
- ADR-091 — module system: ESM via NodeNext (mcp-server side; orthogonal but shipped together)

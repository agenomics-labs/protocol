# ADR-115: Flip clippy / cargo-audit / npm audit from advisory to blocking

## Status
Accepted — Stage 1 shipped (2026-05-13); Stage 2 shipped (2026-05-14); Stage 3a-1 (ESLint infra) shipped (2026-05-14); Stage 3a-2 (no-explicit-any: "error" flip) and Stage 3b (npm audit blocking) pending

## Date
2026-04-24

## Context

Re-audit R-xcut-01, R-xcut-02, R-offchain-06, R-offchain-09 all
report the same anti-pattern: quality and security linters run in CI
but are `continue-on-error: true`. Specifically:

- `.github/workflows/ci.yml:47-49` — `cargo clippy` advisory.
- `.github/workflows/ci.yml:84-86` — `cargo audit` advisory.
- `.github/workflows/ci.yml` — no `npm audit` step at all.
- `mcp-server/.eslintrc.json:10` — `@typescript-eslint/no-explicit-any`
  is `"warn"` (7+ `as any` casts accumulated).

The prior audit (S-xcut-08) documented the same. The original
rationale — "pre-existing clippy warnings from anchor-generated code
would flood CI" — is accurate but has expired. Every new finding now
sits on the same pile.

## Decision

Flip all four gates to blocking over three PRs, staged to keep the
diff tractable:

**Stage 1 (shipped 2026-05-13):** documentation + one-time cleanup baseline.
- Recorded the current clippy warnings as `scripts/clippy-baseline.json` (54 total, dominated by `clippy::useless_vec`, `clippy::too_many_arguments`, `clippy::doc_overindented_list_items`, `clippy::manual_range_contains`).
- Recorded `cargo audit` advisories as `scripts/cargo-audit-baseline.json` (0 vulnerabilities, 3 unmaintained-package warnings: `bincode@1.3.3` RUSTSEC-2025-0141, `libsecp256k1@0.6.0` RUSTSEC-2025-0161 — both gated on Anchor 1.0 npm release per ADR-114; `rand` unsound — same Anchor gate).
- Neither file is used as a gate yet; they are the regression-baseline for Stage 2.

**Stage 2 (shipped 2026-05-14):** flipped clippy and cargo-audit to blocking
with explicit allowlists.
- `cargo clippy --workspace --all-targets -- -D warnings` plus a
  `[workspace.lints]` table in the root `Cargo.toml` that names every
  categorical exemption with rationale (chose `[workspace.lints]` over
  `clippy.toml` / `deny.toml` because the allowlist becomes grep-able
  from source — a reviewer sees every exemption next to the workspace
  manifest rather than buried in a separate file). Each member crate
  opts in via `[lints] workspace = true`.
- `cargo audit --deny warnings` with `.cargo/audit.toml` listing the
  three currently-accepted advisories by RUSTSEC ID, each with a
  one-line rationale and a re-evaluation trigger (chose `.cargo/audit.toml`
  over CLI `--ignore` flags because the audit trail surfaces in PR
  diffs rather than living in workflow YAML).
- Dropped `continue-on-error: true` from both steps. CI now fails on
  the first new warning the allowlist doesn't already accept.
- Stage 1's `scripts/clippy-baseline.json` and
  `scripts/cargo-audit-baseline.json` are kept as a historical snapshot
  but no longer have a load-bearing role — the workspace lints +
  `.cargo/audit.toml` are the new contract.

The clippy clean-up was a small mixture of (a) `cargo clippy --fix` for
mechanical lints (`manual_range_contains`, `len_zero`,
`assign_op_pattern`, `clone_on_copy`, `manual_contains`) and (b) two
test functions in `programs/agent-registry/src/lib.rs` getting
`#[allow(unused_assignments)]` with a rationale where the
"initialise-then-overwrite" pattern was intentional documentation of the
pre-transition state. Tests: 91/91 + 39/39 + 4/4 + 68/68 still pass.

**Stage 3 (split — see Stage 3a-1 shipped, Stage 3a-2 + 3b pending):**
npm audit + ESLint hardening. Originally a single follow-up; split
during the 2026-05-14 autonomous session once two surprises surfaced:

- *Surprise A — npm audit can't flip yet*. A fresh
  `npm audit --audit-level=high --workspaces --include-workspace-root`
  reports 4 high-severity vulnerabilities in the `bigint-buffer` chain
  pulled in via the workspace-root `@solana/spl-token` dev dep
  (GHSA-3gc7-fjrx-p6mg → `@solana/buffer-layout-utils` →
  `@solana/spl-token` → `@sqds/multisig`). Eliminating these is what
  ADR-087 Phase C+D is *for*. Flipping `--audit-level=high` to blocking
  before Phase D would fail every PR.
- *Surprise B — `.eslintrc.json` already exists in indexer / x402-relay*.
  The ADR's "S-xcut-10 follow-up: they were never added" is stale; both
  configs are in place. What's actually missing is the eslint *runtime*
  — no package has `eslint` in its devDeps and there are no `lint`
  scripts anywhere.

**Stage 3a-1 (shipped 2026-05-14):** ESLint infrastructure.
- Installed `eslint@^8.57.0` + `@typescript-eslint/parser@^7` +
  `@typescript-eslint/eslint-plugin@^7` at the workspace root devDeps.
  v8 matches the legacy `.eslintrc.json` format already in the repo
  (v9's flat config would force a separate config rewrite).
- Added `lint` scripts to `mcp-server/package.json`,
  `src/indexer/package.json`, `src/x402-relay/package.json`. The
  invocation pattern is `eslint --no-eslintrc -c .eslintrc.json
  src/**/*.ts` (or `*.ts test/**/*.ts` for the indexer + x402-relay
  layout where the entry point sits next to `package.json`).
- Added test-files overrides to indexer + x402-relay `.eslintrc.json`
  that turn off `no-console` and `@typescript-eslint/no-var-requires`
  — both are deliberate test idioms (Prometheus startup banner;
  `const Database = require("better-sqlite3")` for dynamic load
  isolation in adr-118 / aud-200 / aud-128 fixtures).
- Five pre-existing `eslint:recommended` errors hand-fixed with
  per-line `eslint-disable-next-line ... -- rationale` comments
  (better-sqlite3 dynamic loads, the metrics-server startup banner,
  the backfill `while (true)` paginate-until-empty loop).
- Three CI steps added under the `typescript-check-mcp` job, all
  `continue-on-error: true` until Stage 3a-2. Reviewers can see the
  warning count on every PR; nothing gets blocked yet.

**Stage 3a-2 (pending):** flip
`@typescript-eslint/no-explicit-any` from `"warn"` to `"error"` in
the three `.eslintrc.json` files and triage the ~30 production-path
violations (20 in mcp-server, 10 in indexer, 0 in x402-relay).
Per-site choice: fix with `unknown`, replace with `Record<string,
unknown>`, or accept with
`// eslint-disable-next-line @typescript-eslint/no-explicit-any --
<rationale>`. Once clean, drop `continue-on-error: true` from the
three ESLint CI steps.

**Stage 3b (pending — blocked on ADR-087 Phase D):** drop
`continue-on-error: true` from the existing `npm audit (high)` step.
Gated on the workspace `@solana/spl-token` dev dep being removed.

The staging prevents the "one giant PR that lights CI on fire on merge
day" anti-pattern.

## Consequences

- CI surfaces new warnings as failures from Stage 2 onward. Developers
  either fix or explicitly allowlist.
- `cargo audit` advisories force a triage decision per-advisory; the
  baseline file is the explicit audit trail of "accepted as-is, here's
  why."
- ESLint `error`-level catches the class of regressions that today
  accumulates silently — specifically, ADR-088 backslide (typed IDL
  clients getting `as any` casts rewritten).
- Complements ADR-114: Dependabot surfaces bumps; ADR-115 ensures
  those bumps cannot land with new CVEs or lint debt.

## References

- `docs/ARCHITECTURE_REAUDIT_2026-04.md` S-xcut-08, S-xcut-10, S-xcut-11.
- `docs/ARCHITECTURE_REAUDIT_2026-05.md` R-xcut-01, R-xcut-02,
  R-offchain-06, R-offchain-09.
- `.github/workflows/ci.yml:43` (inline rationale for current state).
- `docs/adr/ADR-114-dependabot-dependency-hygiene.md` (companion).
- `docs/adr/ADR-122-mainnet-readiness-checklist-gate.md` (companion —
  the mainnet-readiness gate calls into the same blocking-CI policy
  this ADR establishes; back-reference per drift-matrix §4 GOLD
  STANDARD pattern, AUD-306).

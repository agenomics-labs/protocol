# ADR-115: Flip clippy / cargo-audit / npm audit from advisory to blocking

## Status
Accepted — Stage 1 shipped (2026-05-13); Stages 2 and 3 pending

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

**Stage 2 (follow-up):** flip clippy and cargo-audit to blocking with
explicit allowlists.
- `cargo clippy --workspace --all-targets -- -D warnings` plus a
  `deny.toml` or `clippy.toml` that tolerates the known
  anchor-generated warnings by name.
- `cargo audit --deny warnings` with the baseline file pinning
  currently-accepted advisories.
- Drop `continue-on-error: true` from both steps.

**Stage 3 (follow-up):** npm audit + ESLint hardening.
- Add `npm audit --audit-level=high` as a dedicated CI step (blocking).
- Flip `@typescript-eslint/no-explicit-any` to `"error"` in
  `mcp-server/.eslintrc.json` and add `.eslintignore` entries for the
  ~7 known Kit v1↔v2 shim locations with ticket references.
- Add the same ESLint config to `src/indexer/` and
  `src/x402-relay/` (S-xcut-10 follow-up: they were never added).

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

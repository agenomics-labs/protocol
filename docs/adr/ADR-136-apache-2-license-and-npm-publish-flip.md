# ADR-136: Apache-2.0 license + flip @agenomics/* npm packages public

## Status

**Accepted (2026-05-06) — implementation landed via PR #76 + #82 + #79.**

The license-adoption half of this ADR shipped without going through the implementation PR sequence originally planned in PR #68:

- **PR #76** (commit `dc195d3`, 2026-05-06): root `LICENSE` file added (canonical Apache-2.0 text from apache.org), `README.md ## License` section flipped from `TBD` → `Apache-2.0 — see LICENSE`, `license` field updated on the 6 publishable workspace `package.json` files (`@agenomics/idl`, `action-runtime`, `client`, `mcp-server`, `capability-manifest-validator`, `sas-resolver`).
- **PR #79** (commit `d59bc48`, 2026-05-06): `license: "Apache-2.0"` added to the 4 unpublishable workspace `package.json` files (root, `dashboard`, `src/indexer`, `src/x402-relay`).
- **PR #82** (commit `05bbea7`, 2026-05-06): `license = "Apache-2.0"` added to the 3 on-chain program `Cargo.toml` files (`programs/agent-vault`, `agent-registry`, `settlement`); `license` field added to `src/integrations/package.json`.

The "flip `@agenomics/*` npm packages public" half is **deferred** — `STATUS.md §5` documents the cut-release as gated on the SAS bootstrap ceremony (`§7.A`), not on a license decision. PR #82 added an explicit "source-only release" note in `SUBMISSION.md` to set judge / external-builder expectations until that gate clears.

**Original Status:** Proposed (2026-04-30, retained below for design-history continuity)

## Date

2026-04-30 (proposed) → 2026-05-06 (accepted-as-shipped)

## Context

Five `@agenomics/*` packages are publish-ready at `0.1.0` and have been
held behind `"private": true` per `docs/SDK_PUBLISH.md`:

| Package | Path |
|---|---|
| `@agenomics/idl` | `sdk/idl` |
| `@agenomics/action-runtime` | `sdk/action-runtime` |
| `@agenomics/client` | `sdk/client` |
| `@agenomics/capability-manifest-validator` | `packages/capability-manifest-validator` |
| `@agenomics/sas-resolver` | `packages/sas-resolver` |

All five carry `"license": "UNLICENSED"` because the repo root has no
`LICENSE` file (`README.md` says `License: TBD`). The npm scope
`@agenomics` is claimed; the `NPM_TOKEN` repo secret is configured;
`.github/workflows/publish.yml` triggers on `v*` tag push;
`RELEASE.md` documents the cut-release flow.

The 2026-04-30 DX audit named **the unpublished + unlicensed state as a
hard blocker on adoption**:

- Every `getting-started.md` snippet (`npm install @agenomics/mcp-server`,
  etc.) currently 404s on the public npm registry.
- `examples/README.md` says explicitly: "swap the `file:` references for
  `^0.1.0` once `@agenomics/idl` and `@agenomics/client` flip to
  `private: false`" — i.e. the on-ramp document advertises a state that
  doesn't exist yet.
- `UNLICENSED` blocks any commercial adopter from depending on the
  packages, even informally; many enterprise procurement gates reject
  unlicensed code outright.

The original hold rationale (SAS bootstrap unverified) was resolved by
PR #34 (devnet SAS path proven). The current hold has no surviving
technical reason — only the license decision is genuinely outstanding.

`docs/SDK_PUBLISH.md` lists four candidate licenses: Apache-2.0, MIT,
BSL-1.1, custom commercial. No decision recorded.

## Decision

**Adopt Apache-2.0 for the entire repository, including all five
`@agenomics/*` packages, and flip each from `"private": true` to
`"private": false` to enable the next `v0.1.0` tag-driven publish.**

### What ships

- New `LICENSE` file at the repo root containing the canonical
  Apache-2.0 text (https://www.apache.org/licenses/LICENSE-2.0.txt).
- `README.md` `## License` section updated from `TBD` to `Apache-2.0`.
- All five package `package.json` files: `"license": "UNLICENSED"`
  → `"license": "Apache-2.0"`.
- All five package `package.json` files: `"private": true` →
  `"private": false` (or remove the field entirely; npm defaults to
  public when `publishConfig.access: "public"` is set, which it
  already is on all five).
- `docs/SDK_PUBLISH.md` updated with the chosen license, the
  flip-public commit hash, and the first-publish runbook narrowed to
  the actual sequence (no longer needs the §2 "Pick a license" step).
- A new ADR-INVENTORY entry / status update is **not** required —
  this is a packaging decision, not an architectural one.

### Why Apache-2.0

- **Permissive enough for unrestricted adoption** — like MIT, it
  allows commercial use, modification, distribution, and private
  use. Any builder can ship a closed-source product on top of
  `@agenomics/client`.
- **Patent grant.** Apache-2.0 includes an explicit patent license
  from contributors to users (§3). MIT does not. For a protocol
  that ships cryptographic + financial primitives, the patent grant
  is a non-trivial moat against troll claims and removes a
  due-diligence cliff for enterprise consumers.
- **Trademark protection.** §6 carves trademarks out of the grant,
  so "Agenomics" / "AEP" remain owned and enforceable.
- **Defensive termination.** §3 self-terminates the patent license
  for anyone who sues a contributor over patent infringement. This
  is the "patent peace" property MIT lacks.
- **Ecosystem alignment.** Apache-2.0 is the dominant license in
  the Solana ecosystem: Anchor, Solana Foundation programs, Helius
  SDK, Squads, MetaPlex (most), Drift. It is also dominant in the
  AI-agent ecosystem: Anthropic MCP reference servers, OpenAI
  agents SDK, Vercel AI SDK. Net: zero license-friction with our
  immediate dep + downstream graphs.

### What is explicitly NOT chosen

- **MIT** — viable but lacks the patent grant; the cost of choosing
  MIT is non-zero and the upside (one-line license header simplicity)
  is not worth it.
- **BSL-1.1** — appropriate when there's a hosted commercial
  product the open-source license must defend against (Sentry,
  CockroachDB, MariaDB pattern). AEP is a protocol, not a hosted
  service; BSL would scare adopters off without protecting anything
  we actually ship.
- **GPL family** — copyleft would prevent anyone from shipping a
  closed-source product on top, killing adoption.
- **Custom commercial.** Procurement-hostile; would require legal
  review at every adopter; off the table for an SDK we want
  builders to use immediately.

## Consequences

### Positive

- **Removes the documentation lie.** `getting-started.md` and
  `examples/README.md` instructions become true on the same commit
  the publish lands.
- **Unblocks the entire DX program.** ADR-134 (Codama) ships as
  `@agenomics/client@0.2.0`; ADR-138 (`@agenomics/react`) ships as
  a new public package; ADR-139 (`create-agenomics-app`) installs
  from the public registry — all of these depend on the publish
  flip happening first.
- **Removes the procurement cliff.** Apache-2.0 with a `LICENSE`
  file passes most enterprise license-scanner checks (FOSSA,
  Snyk, Black Duck) without a manual exception.
- **One commit closes the gap.** This is the single
  highest-leverage / lowest-risk DX move available.

### Negative

- **License is irrevocable for a published version.** Republishing
  `0.1.0` under a different license is not possible; future
  packages can change license, but `0.1.0` is permanent. We
  mitigate by deliberately picking the license that has the longest
  optionality window (Apache-2.0 is forward-compatible with
  almost every adopter scenario).
- **Patent grant flows from contributors.** Anyone who sends a PR
  is granting a patent license under §3. Standard for OSS, but we
  document the inbound-PR expectation in `CONTRIBUTING.md`.
- **`private: false` arms the publish workflow.** A mistakenly-
  pushed `v*` tag will publish to the public registry. We mitigate
  by keeping the existing tag-only trigger and documenting
  `git tag -d` + `git push origin :refs/tags/<tag>` as the rollback
  in `RELEASE.md`. (npm does not allow republishing a yanked
  version, but the 72-hour unpublish window covers genuine errors.)
- **Trademark hygiene becomes our problem.** Apache-2.0 §6 retains
  trademark rights, but the protocol-level "Agenomics" / "AEP"
  trademarks are not yet registered. We log this as a non-blocking
  follow-up; mainnet cutover (already gated by ADR-080) is a
  natural point to revisit.

### Follow-ups

- `LICENSE` file added to the repo root.
- `README.md`, `docs/SDK_PUBLISH.md`, and the five `package.json`
  files updated in the same PR.
- First publish: `npm version 0.1.0 --workspace @agenomics/* --no-git-tag-version`
  → commit → `git tag v0.1.0 && git push origin v0.1.0`. Workflow
  takes over.
- `CONTRIBUTING.md` gains a one-line "By submitting a PR, you
  license your contribution under Apache-2.0" line (this is the
  inbound = outbound convention; no CLA required).
- After publish, swap `examples/package.json` `file:` references to
  `^0.1.0` semver (the line item already noted in
  `examples/README.md` §"Switching to npm dependencies").

## Alternatives Considered

**Keep packages private until external audit completes** (ADR-036).
Rejected. The audit is months out, and the SDK packages are not
on the audit-critical surface — they wrap on-chain primitives that
ARE audited (or will be). Holding the SDK until the protocol audit
lands conflates two different gates and starves builder adoption
in the meantime.

**Dual license (Apache-2.0 OSS + commercial).** Rejected for v1.
Adds legal-review friction with no current upside; we can offer a
commercial-support contract as a separate product without a license
change. The dual-license pattern is reversible (we can offer
commercial terms on top of Apache-2.0); the inverse isn't.

**MIT** — rejected per §"Why Apache-2.0".

**Skip the license file, keep `UNLICENSED`, but flip `private:
false`.** Rejected — that's strictly worse than the status quo.
`UNLICENSED` published to npm is a legal trap.

## References

- `docs/SDK_PUBLISH.md` — first-publish runbook (will be narrowed
  in this PR).
- `RELEASE.md` — tag-driven publish flow.
- `.github/workflows/publish.yml` — publish workflow already wired.
- `examples/README.md` §"Switching to npm dependencies" — the
  documented post-publish swap.
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0.txt
- Solana Foundation license norms: SPL programs ship Apache-2.0;
  Anchor ships Apache-2.0; Helius SDK ships Apache-2.0.
- ADR-085 — `@aep/*` → `@agenomics/*` rename; the npm scope this
  ADR finally activates.
- ADR-089 — reproducible installs; the existing publish pipeline
  this ADR enables.
- ADR-122 — mainnet readiness CI gate; license file is a soft
  prerequisite (not yet wired into the mainnet gate, noted as a
  follow-up).

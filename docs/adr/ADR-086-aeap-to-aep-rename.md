# ADR-086: Code-level acronym rename `AEAP` → `AEP`

## Status
Accepted

## Date
2026-04-23 (backfill — decision is live in production via PR #18, commit `0903670`)

## Context

PR #18 (`refactor: rename AEAP -> AEP across code, configs, and docs`, commit `0903670`, merged 2026-04-21) renamed the protocol acronym from **AEAP** (originally expanded as either *Agent Economic Autonomy Protocol* or *Autonomous Economic Agents Protocol*, both of which had appeared in different documents) to **AEP** (Agent Economy Protocol implemented by Agenomics). The rename was a 110-file, case-preserving substitution covering `.ts`, `.rs`, `.json`, `.md`, `.toml`, `.yml`, `.sh`, `.html`, `.txt`, `.gitignore`, and `.env.example` files. Three sites that expanded the old acronym verbatim were rewritten in prose: `programs/agent-registry/Cargo.toml`, `mcp-server/PROJECT_SUMMARY.txt`, and `idl/agent_registry.json` — all now read "Agent Economy Protocol".

The rename also collapsed the divergent expansions ("Agent Economic Autonomy Protocol" vs. "Autonomous Economic Agents Protocol") into a single canonical name, ending an ambiguity that had drifted across docs since the project's inception. The brand `Agenomics` is split deliberately from the protocol acronym `AEP`: Agenomics is the org/brand that homepages at `agenomics.xyz`; AEP is the technical protocol Agenomics implements.

The scope-level npm rename (`@aep/*` → `@agenomics/*`) followed in PR #19 (commit `840e60e`) and is documented in **ADR-085**. This ADR documents PR #18's code-level acronym rename specifically.

No ADR documented the rename when it landed; this ADR backfills the rationale per the architecture audit's missing-ADR finding (F-4 / F-5 / F-6).

## Decision

Rename the protocol acronym from `AEAP` (ambiguous expansion) to `AEP` (Agent Economy Protocol). Apply case-preserving substitution across the codebase:

- `AEAP` → `AEP` (all-caps, e.g., env vars, PDA seeds, type names)
- `Aeap` → `Aep` (PascalCase, e.g., type prefixes like `AeapError` → `AepError`)
- `aeap` → `aep` (snake_case / kebab-case, e.g., `aeap-mcp` → `aep-mcp`, `@aeap/*` npm scope → `@aep/*` — note: subsequently re-scoped to `@agenomics/*` per ADR-085)

Rewrite the three prose sites that expanded the old acronym to use the new canonical expansion ("Agent Economy Protocol"). All other references — including ADR text where the acronym appears — get the case-preserving substitution.

Adopt the org/protocol split as policy:

- **Brand / product / homepage**: Agenomics, agenomics.xyz (org-level identity).
- **Protocol acronym in code / docs**: AEP (technical-layer identity).

## Alternatives Considered

- **Keep AEAP and pick a single canonical expansion.** Rejected — AEAP carried two competing expansions ("Agent Economic Autonomy Protocol" / "Autonomous Economic Agents Protocol") that had drifted across docs. Picking one would leave the other as legacy scar tissue in old text and commit history; renaming the acronym lets the project move forward with a single unambiguous name and a clear before/after split.
- **Rename to `Agenomics` everywhere (no separate protocol acronym).** Rejected — conflates the brand with the protocol. The protocol is potentially implementable by entities other than Agenomics Labs; baking the brand into env vars / PDA seeds / type names would create awkward future-fork situations and over-claim brand association with the protocol's technical surface.
- **Use a longer acronym (e.g., `AGEP`, `AEPP`).** Rejected — `AEP` is short, pronounceable, unambiguous, and at acronym-collision-acceptable density on Solana (no ecosystem-level conflict with another protocol). Longer acronyms add typing overhead with no benefit.
- **Defer the rename to v1.0 release.** Rejected — every day the ambiguous AEAP name persists is another day of new files, comments, and external references baking it in. The rename cost grows monotonically; doing it pre-publish (before any `@aep/*` package was ever published to npm) keeps the migration boundary clean.

## Consequences

### Positive
- Single canonical protocol name — ends the "AEAP means what?" ambiguity.
- Clear org/protocol split (Agenomics = brand; AEP = protocol).
- Pre-publish rename — no external consumers had to migrate npm depencies, no breaking change to any published API.
- Case-preserving substitution touched 110 files in one atomic PR with no behavioral change — purely lexical refactor.

### Negative
- Git blame / git log archaeology for any line touched by the rename now references PR #18 as the most recent author. Mitigated by reading prior history with `git log --follow` or by inspecting the rename commit's diff specifically.
- External references in third-party blog posts, archived audit reports, and chat history continue to use AEAP indefinitely. Acceptable — those are time-stamped artifacts that future readers will understand in context.
- The split between org-brand (Agenomics) and protocol-acronym (AEP) requires documentation for every onboarding contributor. Documented in `docs/STATUS.md §2` and ADR-085.

### Neutral
- The rename did not change any on-chain state, account layout, instruction discriminator, or PDA derivation — PDA seeds renamed from `AEAP_*` to `AEP_*` were not yet present on devnet at the time of PR #18 (devnet seeds were deployed under the new `AEP_*` names directly).
- ADR text that pre-dated PR #18 was case-preservingly rewritten to use `AEP`, so the ADR corpus reads consistently post-rename.

## References
- PR #18, commit `0903670` — `refactor: rename AEAP -> AEP across code, configs, and docs`
- `docs/STATUS.md` §2 ("Acronym / brand")
- `docs/adr/ADR-085-agenomics-npm-scope-rename.md` — companion npm-scope rename (PR #19, commit `840e60e`)
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-4 / F-5 / F-6 (missing-ADR backfill obligation)

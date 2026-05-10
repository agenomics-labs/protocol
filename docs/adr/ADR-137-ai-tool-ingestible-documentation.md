# ADR-137: AI-tool-ingestible documentation (llms.txt, CLAUDE.md, .cursorrules)

## Status

Proposed

## Date

2026-04-30

## Context

The 2026-04-30 DX research synthesis (this branch's prior turn) named
**AI-tool ingestibility as a 2026-specific frontier of developer
experience**: most early-adopter code is now written with AI
assistance (Cursor, Claude Code, Windsurf, Copilot, Continue, Cody),
and SDKs that are not easy for an LLM to use lose adoption to ones
that are. Concrete adoption signals over the last 12 months:

- Vercel, Stripe, Anthropic, Pinecone, Resend, Mintlify, Drizzle,
  Hono, tRPC have all shipped `/llms.txt` files (the Jeremy Howard
  proposal, https://llmstxt.org).
- Anthropic's MCP, OpenAI's Agents SDK, and Vercel's AI SDK all
  publish `CLAUDE.md` / `agents.md` / equivalents.
- Cursor adoption (~1M+ paid devs as of Q1 2026) made `.cursorrules`
  a de-facto standard for SDK-vendor-shipped agent prompts.

The protocol currently has:

- **Internal AI-tooling files**: this repo's `.claude/`, `.claude-flow/`,
  `CLAUDE.md` configure Claude Code for **internal contributors**.
  None of them are intended for or visible to **external SDK
  consumers**.
- **VitePress docs** (`docs/`): `getting-started.md`, `api-reference.md`,
  `integration-guide.md`, the ADR corpus. Designed for human
  reading; not flat-text, not LLM-optimized.
- **Per-package READMEs** (`sdk/*/README.md`,
  `packages/*/README.md`): adequate for human onboarding,
  not assembled for LLM context windows.

There is no **consumer-facing** AI-readable surface. An external dev
who asks Cursor / Claude Code "how do I register an agent on AEP?"
gets whatever the model already knows (likely nothing) plus whatever
ad-hoc fragments the dev pastes in. The conversion gap between "dev
knows AEP exists" and "AI agent emits correct AEP code" is large and
fully avoidable.

This ADR sits alongside ADR-141 (Codama-generated SDK; produces
typed shapes that LLMs can introspect) and ADR-135 (Zod-mirrored MCP
schemas; produces tight `inputSchema` that AI clients consume). It
ships the **prose layer** that complements those code-shape
improvements.

## Decision

**Ship a consumer-facing AI-tool-ingestible documentation surface:
`/llms.txt` + `/llms-full.txt` at the docs site root, a `CLAUDE.md`
and `AGENTS.md` co-located with each public package, and a single
`.cursorrules` at the repo root that AI-assisted contributors and
external builders both pick up.**

### What ships

#### 1. Consumer-facing `llms.txt` (https://llmstxt.org)

- `docs/llms.txt` — short, curated index. Title, description,
  links to the canonical sub-docs (`getting-started.md`,
  `api-reference.md`, `integration-guide.md`, ADR-INVENTORY,
  package READMEs). Format follows the Howard spec strictly.
- `docs/llms-full.txt` — flat-text concatenation of the human docs,
  rendered at build time by a new VitePress plugin (`docs/.vitepress/
  plugins/llms-txt.ts`). This is what a model ingests when given the
  whole protocol context.
- Build-time generation, not committed: a new
  `docs/.vitepress/config.ts` hook runs after the docs build and
  emits both files into `docs/.vitepress/dist/`. The Vercel deploy
  serves them at `agenomics.xyz/llms.txt` and
  `agenomics.xyz/llms-full.txt`.

#### 2. Consumer-facing `CLAUDE.md` / `AGENTS.md` per public package

- v0.1 scope: one pair (`CLAUDE.md` symlinked to `AGENTS.md` for
  cross-vendor compatibility) at the root of TWO public packages:
  - `sdk/client/CLAUDE.md`
  - `packages/sas-resolver/CLAUDE.md`
- (Deferred to v0.2): per-package CLAUDE.md/AGENTS.md for remaining
  packages (`sdk/idl/`, `sdk/action-runtime/`,
  `packages/capability-manifest-validator/`, etc.) — added once v0.1
  patterns prove out on the two pilot packages.
- Format: ~200–500 lines of structured prose **for the LLM, not the
  human**. Each contains:
  - The minimum viable mental model (3–5 sentences).
  - 5–10 high-signal copy-paste examples (full code, not snippets).
  - Common pitfalls and the diagnostic shape (e.g. "if you see
    `Account does not exist`, the authority hasn't called
    `register_agent` yet").
  - Pointers to the typed shape: which Zod schema (ADR-135), which
    Codama builder (ADR-141), which IDL field.
- `npm pack` includes them via `files: ["CLAUDE.md", "AGENTS.md", ...]`
  in `package.json`, so consumers' AI tools find them under
  `node_modules/@agenomics/<pkg>/CLAUDE.md`.

#### 3. Repo-root `.cursorrules` — Deferred to v0.2

- (Deferred to v0.2): repo-root `.cursorrules` — see ADR-137 v0.2
  follow-up after v0.1 patterns prove out.
- Rationale for deferral: the protocol-wide AI-contributor conventions
  it would encode (branch naming, ADR discipline, IDL parity,
  conventional commits, "no Co-Authored-By trailers", Zod boundary
  contracts, Codama source-of-truth) already live in the existing
  internal `CLAUDE.md` at the repo root. Externalising them as a
  consumer-facing `.cursorrules` adds vendor coupling without yet
  having v0.1 validation that the per-package + `llms.txt` surfaces
  are sufficient. We revisit once v0.1 is in consumer hands.

#### 4. Inbound link surface

- Add a `## Building with AI tools` section to the docs site
  homepage and to `examples/README.md` with one-liners:
  - **Cursor / Windsurf**: "Add `https://agenomics.xyz/llms-full.txt`
    to your context."
  - **Claude Code**: "`@agenomics/client`'s `CLAUDE.md` is bundled;
    paste the path or run `cat node_modules/@agenomics/client/CLAUDE.md`."
  - **ChatGPT / Claude.ai**: "Drop `llms-full.txt` into the
    conversation."

### Out of scope

- We do **not** ship a hosted MCP server *for the docs themselves*.
  That's a separate decision (potentially a future ADR) and risks
  duplicating effort with the existing protocol MCP server.
- We do **not** auto-translate every ADR into the `llms-full.txt`
  bundle. The ADR corpus is internal architectural memory; only
  the `STATUS-AUDIT-2026-04-23` summary, the ADR-INVENTORY
  digest, and the few consumer-relevant ADRs (083 transport,
  098 SDK shape, 132 origin gate) are linked from `llms.txt`.

## Consequences

### Positive

- **Closes the AI-conversion gap.** A dev asking Cursor "register
  an agent on AEP" lands typed, working code on the first attempt
  because the model has the IDL shape (via Codama, ADR-141), the
  MCP schema (via Zod mirror, ADR-135), and the prose context (via
  this ADR).
- **Cheap to maintain.** `llms-full.txt` is a build-step concat;
  per-package `CLAUDE.md` files live next to the source they
  describe and are reviewed in the same PR. No separate doc
  infrastructure.
- **Distribution surface.** Tools that auto-discover `/llms.txt`
  (Cursor's web mode, Claude Code's URL fetch, several SDK
  benchmarking projects) pick the protocol up automatically.
- **Reinforces the codegen story.** When ADR-141's CI gate fails
  on stale codegen, the AI-readable docs that reference it stay
  truthful — the source-of-truth discipline propagates.

### Negative

- **Doc sprawl risk.** Adding 5+ `CLAUDE.md` files plus
  `llms.txt` plus `.cursorrules` plus the existing READMEs raises
  the surface area we maintain. Mitigation: `CLAUDE.md` per package
  lives in the same PR review as code changes to that package; if
  the README and the `CLAUDE.md` drift, reviewers catch it.
- **Vendor coupling.** `.cursorrules` is Cursor-specific;
  `CLAUDE.md` is Claude-vendor-named (Anthropic). The
  cross-vendor `AGENTS.md` symlink mitigates the second; the
  first is genuine vendor coupling but the cost is a single small
  file.
- **Stale prose risk.** Unlike the codegen artifacts, the prose in
  `CLAUDE.md` files is not under a CI diff-gate. We mitigate via
  a lightweight `scripts/check-llms-txt.sh` that fails CI if any
  package's `CLAUDE.md` references a removed export (grep-level
  check of public exports vs. examples).
- **Privacy / security surface.** `llms-full.txt` indexes the
  consumer-facing docs only; the internal `CLAUDE.md` (repo root)
  and `.claude/` configs continue to live unindexed. The build
  hook explicitly excludes those paths.

### Follow-ups

- After ADR-138 (`@agenomics/react`) ships, that package gets its
  own `CLAUDE.md` immediately at v0.1.0.
- After ADR-139 (`create-agenomics-app`) ships, the scaffold output
  includes a starter `.cursorrules` that imports the protocol-wide
  conventions, so downstream apps inherit the same AI guidance.
- Sample-app gallery (ADR-140) entries each ship their own
  `llms.txt` linking back to the protocol's, forming a graph of
  AI-readable surfaces that LLMs can crawl.
- Decide whether to publish the `llms-full.txt` bundle as a
  versioned artifact (e.g. attached to GitHub Releases) so that
  models can pin to a release. Tracked, not blocking.

## Alternatives Considered

**Skip llms.txt; rely on the existing VitePress site.** Rejected.
LLM ingestion of HTML is significantly worse than flat-text; the
flat-text bundle is a 2-line build hook with disproportionate
upside.

**Hand-write per-package `CLAUDE.md` only; skip the repo `llms.txt`.**
Rejected. The two surfaces address different audiences:
`llms.txt` is what an external AI tool ingests for protocol-level
context (architecture, programs, MCP tools); `CLAUDE.md` is what
the AI ingests at the **package** level when the dev is already in
that package's context.

**Treat `CLAUDE.md` as Anthropic-only and add `agents.md`,
`mistral.md`, `gpt.md` siblings.** Rejected. Vendor proliferation;
the `AGENTS.md` cross-vendor name is the de facto neutral label
(adopted by OpenAI, Vercel AI SDK). Symlinking covers both readers.

**Generate per-package `CLAUDE.md` from JSDoc.** Rejected for v1.
JSDoc-to-prose is an open problem; the resulting prose tends to be
less useful to LLMs than ~300 hand-written lines naming common
pitfalls. The hand-written shape can be revisited if maintenance
load proves real.

**MCP server for the docs themselves** (so AI agents query docs as
a tool, not as bulk text). Considered; deferred to a future ADR.
Adds infra; benefits do not yet outweigh the flat-text path.

## References

- llmstxt.org — Jeremy Howard's spec.
- https://docs.cursor.com/context/rules — `.cursorrules` semantics.
- Anthropic MCP servers reference: https://github.com/modelcontextprotocol
  (most reference servers ship `CLAUDE.md`).
- Vercel AI SDK `agents.md` precedent.
- ADR-141 — Codama-generated clients (the typed surface this ADR
  documents in prose).
- ADR-135 — Zod ↔ MCP tool schema mirror (the input contract this
  ADR's prose layer points consumers to).
- ADR-136 — license + publish flip (must land first; without it
  the `llms.txt` linking to "install `@agenomics/client`" is a
  documentation lie).
- Existing `CLAUDE.md` (repo root) — internal contributor file;
  not the consumer-facing artifact this ADR ships.

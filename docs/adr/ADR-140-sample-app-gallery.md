# ADR-140: Curated sample-app gallery as the protocol's adoption flywheel

## Status

Proposed

## Date

2026-04-30

## Context

The 2026-04-30 DX research synthesis named **the sample-app gallery
as the single biggest adoption-driver for crypto SDKs** in the
2024–2026 cohort:

- Vercel's `vercel.com/templates` and Next.js' `examples/` directory
  drive measurable conversion from "evaluating" to "shipping."
- OnchainKit's "Built with OnchainKit" page is the primary inbound
  funnel beyond the README.
- Stripe's recipe gallery and Resend's example library are
  textbook references for how a sample collection compounds.
- Solana Foundation grants and Colosseum prizes flow
  disproportionately to projects that fork an official template.

The protocol has the underlying surface — three live devnet programs,
25 MCP tools, a typed SDK now coming via ADR-134, a React layer via
ADR-138, and a scaffold via ADR-139 — but **zero** runnable
demonstration apps that show what is possible to build. The current
`examples/` directory has one read-only file (per the prior turn's
gap analysis).

The protocol's competitive position is unique: it is the only
Solana-native economic substrate for autonomous AI agents. That
positioning is invisible without lighthouse demos that exercise the
agent-to-agent settlement loop, the discovery-by-reputation flow,
the MCP-driven autonomous procurement pattern, the x402 paywall
integration, etc. A gallery is how that thesis gets legible.

This ADR is intentionally a **content / curation** decision, not a
code-architecture one. It depends on:

- ADR-134 — typed instruction builders (so the apps are small).
- ADR-136 — npm publish (so the apps install from public registry).
- ADR-137 — AI-readable docs (so the apps are LLM-buildable).
- ADR-138 — `@agenomics/react` (so the apps don't reinvent
  boilerplate).
- ADR-139 — `create-agenomics-app` (so each gallery entry forks
  cleanly from a known starting point).

Together these five ADRs form the substrate; this ADR ships the
showcase.

## Decision

**Curate and ship a sample-app gallery — six lighthouse apps in v0.1
— each demonstrating a distinct AEP-native use case, hosted on
Vercel under `agenomics.xyz/showcase`, with full source in
`samples/<slug>/` of this repo, runnable via the ADR-139 scaffold
fork pattern. The gallery is the public proof of the protocol's
thesis (autonomous economic agents on Solana) and the canonical
place builders go when asking "what can I build?"**

### Six v0.1 entries

Each entry is small (target: <500 LOC of app code on top of the
ADR-139 scaffold), runnable on devnet today, and addresses a
distinct adopter cohort. Each is shipped with a `README.md`,
`CLAUDE.md` (per ADR-137), live demo URL, and a 30-second screen
recording.

#### 1. `agent-marketplace` — discovery + escrow lifecycle

Two-sided marketplace UI: providers register agents (capability,
pricing, accepted tokens); clients discover by category +
reputation, create escrows, approve milestones. Full happy-path
loop, using Privy embedded wallets so no extension required.

**Cohort:** Next.js / React app builders who want a tangible
end-to-end demo of the protocol's full surface.

#### 2. `claude-procurement-agent` — AI agent as economic actor

A Claude/MCP-driven autonomous agent that, given a budget,
discovers providers via `discover_agents`, negotiates a task,
funds an escrow, and approves milestones — all via MCP tool
calls, with no human in the loop except budget approval. Uses
the protocol's existing 25 MCP tools.

**Cohort:** AI-agent builders (the protocol's primary thesis
audience). The lighthouse for "agents transact autonomously."

#### 3. `x402-paywall` — pay-per-API-call gateway

An HTTP service in front of an LLM endpoint that issues HTTP 402
challenges per ADR-017 / ADR-090, settled to AEP via the x402
relay in this repo. Demonstrates the agentic-commerce pattern
(Coinbase x402 + AP2 + Stripe Agent SDK convergence) wired to
Solana settlement.

**Cohort:** API monetization builders + the agentic-commerce
narrative.

#### 4. `reputation-leaderboard` — public read-side dashboard

Read-only Next.js app that reads from the indexer (or from
on-chain `getProgramAccounts`) and renders the top agents by
reputation, recent escrow activity, and dispute outcomes. Static
generation + ISR. No wallet required to view.

**Cohort:** ecosystem analysts, lightweight integrators, and
"see who else is here" social proof for new arrivals.

#### 5. `eliza-aep-agent` — ElizaOS plugin demo

A working ElizaOS character that uses the existing
`@agenomics/integrations` ElizaOS plugin to register, transact,
and report. Wraps the protocol's 25 MCP tools as ElizaOS
actions per ADR-018.

**Cohort:** ElizaOS / SAK builders, the largest existing
agent-framework cohort on Solana.

#### 6. `agent-vault-policy-cockpit` — dev-tools-flavored sample

A small power-user app that demonstrates vault policy
configuration, allowlist management, rate-limit visualization,
and pause/resume. Uses `@agenomics/react` primitives almost
exclusively; ~150 LOC. The "shadcn-style examples" entry that
shows the React layer's composability.

**Cohort:** Solana power users, ops/treasury teams, and
component-library evaluators.

### Curation criteria

To qualify for the v0.1 gallery, each entry must:

1. **Be runnable on devnet** with `npm install && npm run dev` and
   no infrastructure beyond a Privy app ID + RPC URL (free tier
   acceptable).
2. **Pass CI**: a `samples/*/.github/workflows/` job builds and
   typechecks each sample on every PR to the protocol repo.
3. **Have a written `README.md`** with: 30-second pitch, live
   demo URL, prerequisites, setup, screenshots / GIF.
4. **Ship a `CLAUDE.md`** so a builder asking Cursor "extend this
   sample to do X" gets typed working output (per ADR-137).
5. **Reference the scaffold's structural shape** so the diff
   between the scaffold and the sample is the educational
   surface.
6. **Have a single human maintainer** named in the README. No
   anonymous samples; accountability matters for a curated
   gallery.

### Hosting and publication

- Source: `samples/<slug>/` in this repo (one workspace each, but
  **excluded from the root workspaces glob** so they don't drag
  the root `npm install` graph). Each has its own
  `package-lock.json`, mirroring `examples/`'s sandbox shape.
- Live demos: deployed to Vercel under
  `<slug>.demo.agenomics.xyz`. The deploy is gated on the sample's
  CI passing; failed deploys revert to the previous green.
- Gallery index: `agenomics.xyz/showcase` is a static page
  (rendered from `site/showcase/`) listing the six entries with
  thumbnails, 1-line descriptions, and `[live demo] [source] [docs]`
  links.

### Out of scope

- **Token-gated or paid samples.** All v0.1 samples are
  permissively-licensed (Apache-2.0 per ADR-136) and free to
  fork. We may revisit a "premium template" tier post-mainnet if
  there's a clear commercial demand; not now.
- **External-contributor samples** (community-built submissions).
  Tracked as a v0.2 follow-up: a `samples/community/` directory
  with a separate, more permissive curation bar. v0.1 is
  protocol-team-curated to ensure quality.
- **Mainnet samples.** All v0.1 samples target devnet; mainnet
  variants ship after the audit closes (ADR-080).

## Consequences

### Positive

- **Closes the "what can I build?" gap.** The gallery is the
  legible answer.
- **Proves the protocol's thesis.** The
  `claude-procurement-agent` and `x402-paywall` samples
  specifically demonstrate the autonomous-economic-agent
  positioning that no other Solana protocol shows runnably.
- **Recruits builders.** Every gallery entry is a forkable
  starting point; the conversion rate from "viewed" to "forked"
  to "shipped a derived app" is the metric that will drive
  ecosystem growth in 2026.
- **Compounds with the scaffold (ADR-139).** Forks of
  `create-agenomics-app` + the gallery entries become the
  educational corpus.
- **Hackathon and grants leverage.** Six well-curated samples
  generate measurable Colosseum / Renaissance / Solana
  Foundation traction.

### Negative

- **Maintenance load.** Six apps × evolving SDK surface = real
  rot risk. Mitigated by (a) CI building each sample on every
  protocol PR, (b) a quarterly bump review, (c) a small named
  maintainer per sample.
- **Curation bottleneck.** v0.1's protocol-team-only curation
  means we ship slower than open submissions would; v0.2's
  community gate addresses it.
- **Reputational risk if a sample breaks.** A linked-from-
  homepage demo URL that 500s is the wrong public-facing
  shape. Mitigated by the green-deploy-only gating + a status
  banner on the showcase page if any sample's demo is degraded.
- **Vercel hosting cost** scales with traffic. v0.1 fits within
  the existing Vercel project budget; we revisit if a single
  sample goes viral.
- **Sample sprawl temptation.** "One more sample" pressure is
  evergreen; we cap v0.1 at six and require a written ADR or
  RFC for v0.2 expansion.

### Follow-ups

- After this ADR is Accepted, the six samples are tracked as
  separate PRs (one per sample), each adding `samples/<slug>/`
  + a one-line index entry on `agenomics.xyz/showcase`.
- A "Built with Agenomics" inbound link program: every sample
  links back to `agenomics.xyz/showcase`, and we surface
  external community-built apps as they appear (gated behind
  the v0.2 community-curation policy).
- Twitter/X / Discord syndication of one new sample per week
  during the launch month, with a short builder spotlight per
  sample's named maintainer.
- Telemetry on gallery → fork → deploy conversion (opt-in,
  per the same observability stack from ADR-104). Tracked
  separately.
- A future ADR may add a samples-as-tests CI policy (samples
  exercising the protocol's full surface, used as
  integration tests for SDK changes). Out of scope here.

## Alternatives Considered

**Open submission gallery from day one.** Rejected for v0.1.
Curation cost in the early window is too high; quality variance
would actively hurt the showcase's signal value. The v0.2
community track adds the open-submission path with quality
gating.

**Many small samples (20+).** Rejected. Each sample carries a
maintenance tax; six well-maintained beats twenty rotting.
Every additional sample's value is bounded by the marginal use
case it covers, and after six the marginal use case gets thin.

**Skip the gallery; lean on individual external blog posts and
case studies.** Rejected. Case studies are great supplements
but they're not forkable; the gallery's value is the "fork in
30 seconds" path.

**Move samples out of the protocol repo into a sibling repo
(`agenomics-labs/samples`).** Considered. The rejected position is
that keeping samples in-tree forces them to break loudly when
the SDK breaks; a sibling repo can drift silently. The samples
explicitly opt into being on the same SDK release cadence as the
protocol, which is the right discipline.

**Limit v0.1 to two samples** (just the agent marketplace + the
Claude procurement agent). Rejected — six covers the cohort
fan-out (Next.js builders, AI-agent builders, x402 builders,
ElizaOS builders, ops/power users, read-only consumers). Two
samples leaves four cohorts unaddressed and slows ecosystem
mobilization.

## References

- ADR-018 — framework integration plugins (ElizaOS, SAK); the
  `eliza-aep-agent` sample consumes this.
- ADR-035 — dashboard-devnet (existing internal dashboard); the
  `agent-vault-policy-cockpit` sample is the consumer-facing
  counterpart.
- ADR-090 — x402 HTTP payment relay (existing); the
  `x402-paywall` sample consumes this.
- ADR-134 — Codama-generated builders (the write-side this
  gallery exercises end-to-end).
- ADR-136 — license + publish flip (gallery samples install
  from public registry).
- ADR-137 — AI-readable docs (each sample ships its own
  `CLAUDE.md`).
- ADR-138 — `@agenomics/react` (the React layer the samples
  consume).
- ADR-139 — `create-agenomics-app` (the scaffold each sample
  forks from).
- OnchainKit "Built with" gallery —
  https://onchainkit.xyz/showcase
- Vercel Templates — https://vercel.com/templates
- `examples/` (this repo) — the existing read-only example
  pattern; samples graduate from this directory's discipline.

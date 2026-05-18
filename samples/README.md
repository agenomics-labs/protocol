# Agenomics sample-app gallery

This directory is the **in-repo gallery index** for ADR-140 — the
curated collection of runnable, forkable demonstration apps for the
Agenomics Protocol (AEP) on Solana.

> The gallery is the public answer to "what can I build?" Each entry
> is a small, forkable starting point that exercises a distinct slice
> of the protocol surface end-to-end. The hosted gallery lives at
> `agenomics.xyz/showcase`; this README is its source of truth.

See [`docs/adr/ADR-140-sample-app-gallery.md`](../docs/adr/ADR-140-sample-app-gallery.md)
for the full curation rationale, the six-entry gallery target, and
the **v1 ship scope** recorded in the Decision.

## Honest scope (read first)

`@agenomics/client@0.1.0` is **read-only**: it ships PDA derivation
+ typed account fetch for all three programs (registry, vault,
settlement). SDK instruction builders (the write side —
`registerAgent`, `createEscrow`, milestone approval, etc.) are out
of scope for the `0.1.0` SDK release per ADR-098. See
[`examples/README.md`](../examples/README.md) "Honest scope" and the
`sdk/client/README.md` roadmap.

Accordingly, the **v1 gallery** ships the gallery structure plus the
two highest-signal flows the SDK supports *today* — both
read-surface, both runnable on devnet, both mirroring the
[`examples/register-agent.ts`](../examples/register-agent.ts)
discipline. The remaining gallery entries are write-side-gated
follow-ups (ADR-140 Consequences → Follow-ups).

## Gallery (v1)

| Sample | What it shows | Surface | Network | Wallet |
|--------|---------------|---------|---------|--------|
| [`reputation-leaderboard`](./reputation-leaderboard/) | Iterate agent profiles, rank by reputation, render a leaderboard | `AgentRegistryClient` (read) | devnet | not required |
| [`escrow-explorer`](./escrow-explorer/) | Derive + fetch `TaskEscrow` & `ProtocolConfig`, render escrow lifecycle state | `SettlementClient` (read) | devnet | not required |

## Deferred (gallery target, write-side-gated)

Tracked as follow-up PRs once SDK instruction builders land
(ADR-098 / ADR-134 roadmap). Each lands as `samples/<slug>/` + one
row in the table above:

- `agent-marketplace` — two-sided discovery + escrow lifecycle UI.
- `claude-procurement-agent` — MCP-driven autonomous economic actor.
- `x402-paywall` — pay-per-API-call gateway (ADR-090).
- `eliza-aep-agent` — ElizaOS plugin demo (ADR-018).
- `agent-vault-policy-cockpit` — vault policy power-user app
  (ADR-035).

`reputation-leaderboard` and `escrow-explorer` grow write-side
variants in place at the same milestone.

## Conventions every sample follows

Mirrors the `examples/` sandbox discipline (ADR-140 "Hosting and
publication"):

1. **Not a root workspace member.** `samples/` is excluded from the
   root `package.json` `workspaces` glob, so samples do not drag the
   root `npm install` graph. Each sample has its own `package.json`
   and resolves the SDK via `file:` references (`../../sdk/idl`,
   `../../sdk/client`) pre-publish; swap to semver post-publish per
   `examples/README.md`.
2. **`README.md`** with a 30-second pitch, prerequisites, setup,
   run, and expected output.
3. **`CLAUDE.md`** so an AI tool extending the sample emits typed,
   working output (ADR-137).
4. **Runnable on devnet** with `npm install` + the documented run
   command; no infra beyond an RPC URL (public devnet free tier
   acceptable).
5. **`typecheck` script** (`tsc --noEmit`) so CI can build each
   sample.
6. **A single named maintainer** in each sample's README — no
   anonymous samples.
7. **References the read-only scope honestly** and points at the
   SDK roadmap for the write side.

## Building these samples with AI tools

Per [ADR-137](../docs/adr/ADR-137-ai-tool-ingestible-documentation.md),
each sample ships a `CLAUDE.md`. The protocol also exposes an
[`/llms.txt`](https://agenomics.xyz/llms.txt) entry point. Add it to
Cursor/Windsurf context, or connect the MCP server per the
[getting-started](https://agenomics.xyz/getting-started) walkthrough
to reach every on-chain instruction as a typed MCP tool.

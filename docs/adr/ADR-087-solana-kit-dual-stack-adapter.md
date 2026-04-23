# ADR-087: `@solana/kit` v1+v2 dual-stack adapter pattern in `@agenomics/mcp-server`

## Status
Accepted

## Date
2026-04-23 (backfill — decision is live in production via PRs #4, #22, #23)

## Context

ADR-012 (`web3js-v2-migration`, Accepted) committed AEP to migrate from `@solana/web3.js` v1 to `@solana/kit` v2. The migration is being executed in staged PRs rather than as a single atomic flip. The relevant stages landed on `main` are:

- **PR #4** (commit `d5dc764`, `feat(mcp-server): ADR-012 PR2 — introduce @solana/kit (v2) surface + v1 adapter`) — introduced the v2 RPC alongside the v1 connection, set up the adapter shape.
- **PR #22** (commit `1c6b691`, `fix(mcp-server): wire v2 Kit RPC into preflight dispatch + make smoke test idempotent`) — wired the v2 Kit RPC into the preflight dispatcher so state-gates can read on-chain state via either stack.
- **PR #23** (commit `a2f1eb7`, `feat(mcp-server): wire v2 vault_transfer sendAndConfirm to Kit factory`) — moved the first send-side action (`vault_transfer`) to the v2 send/confirm path.

The result is a runtime co-existence pattern in `@agenomics/mcp-server`: `solana.ts` (v1) and `solana-v2.ts` (v2) live side-by-side; `index.ts` initializes both at startup and the action dispatcher routes individual actions to whichever stack they have been migrated to. The v2-migrated handlers live under `mcp-server/src/handlers-v2/`; v1 handlers live under `handlers/`. Migration progresses action-by-action as each handler's CPI shape is verified against the v2 Kit factories.

The dual-stack pattern is significant enough to warrant its own ADR — it commits AEP to maintaining both code paths simultaneously for the duration of the migration, has a sunset condition (full v2 migration of every action), and shapes how every new action is authored. No ADR documented the pattern when it landed; this ADR backfills the rationale per the architecture audit's missing-ADR finding (F-4 / F-5 / F-6).

## Decision

Adopt the **v1+v2 runtime co-existence dual-stack adapter pattern** in `@agenomics/mcp-server` for the duration of the ADR-012 migration. Specifically:

1. **Two parallel stacks initialized at boot**: `solana.ts` (v1, `@solana/web3.js`) and `solana-v2.ts` (v2, `@solana/kit`) are both initialized in `mcp-server/src/index.ts` at process start. Both connect to the same RPC endpoint (per `SOLANA_RPC_URL`).
2. **Per-handler stack assignment**: each MCP action handler explicitly belongs to either `mcp-server/src/handlers/` (v1) or `mcp-server/src/handlers-v2/` (v2). The shared dispatcher (`adapters/mcp.ts` action router) routes each action to its declared handler module.
3. **Shared preflight pipeline**: `mcp-server/src/pipeline/` (state-gates, preflight, idempotency, compute-budget, confirm) reads from the v2 Kit RPC by default, so state-checks (account existence, vault state, daily-cap balance) are uniform across v1 and v2 handlers. This unifies the read-side even while the send-side remains split.
4. **Per-action migration cadence**: handlers migrate from v1 to v2 one action at a time, with a tested v2 path landing in its own PR. The v1 handler is removed only when the v2 handler is verified end-to-end (lint, unit test, smoke test, preflight integration).
5. **No new v1 handlers**: any new MCP action authored after PR #22 lands directly in `handlers-v2/`, never in `handlers/`. v1 is in maintenance-only mode.

### Sunset criteria

This ADR is **superseded** when:

- All MCP action handlers have migrated to `handlers-v2/`, AND
- The v1 `solana.ts` initialization is removed from `index.ts`, AND
- `@solana/web3.js` is removed from `mcp-server/package.json` dependencies.

At that point a follow-up ADR captures the v2-only end-state and supersedes this one. Until then, this pattern is normative.

## Alternatives Considered

- **Big-bang flip (migrate every handler in one PR).** Rejected — too risky given the size of the handler surface (~20 actions across vault, settlement, registry, x402-relay) and the heterogeneity of CPI shapes. A per-action cadence lets each migration carry its own test coverage and rollback path; a single PR would conflate review, test, and rollout for the entire surface.
- **Two parallel servers (v1-mcp-server and v2-mcp-server) running side-by-side.** Rejected — doubles the operational surface (two binaries, two health checks, two release pipelines) for an internal-only migration. Single-binary dual-stack co-existence shares the lifecycle without doubling the ops surface.
- **Wait for the v2 ecosystem to mature, then migrate later.** Rejected — `@solana/kit` is the Solana Foundation's stewarded path and v1 (`@solana/web3.js`) is on a maintenance-only trajectory. Delaying the migration accumulates v1-anchored code that becomes more expensive to migrate later. Per ADR-012, the migration is committed; the only remaining design question is the pacing, which this ADR resolves.
- **Run v1 and v2 against different RPC endpoints.** Rejected — splits the read-state observability surface and creates mismatched cluster slots between the two stacks. Single RPC endpoint shared across both stacks keeps state-reads coherent.

## Consequences

### Positive
- Per-action migration cadence — every v2 handler ships with its own test coverage, gate-by-gate verification, and explicit rollback boundary.
- Shared preflight pipeline reads from v2 — read-side state checks are uniform across v1 and v2 handlers, so the migration's blast radius is bounded to the send-side per action.
- Decision matches on-chain reality (corpus / reality alignment).
- Sunset criteria are explicit — this ADR is not "permanent dual-stack", it is a migration-phase pattern with a clear end-state.

### Negative
- Two stacks in one process means two sets of factories, two RPC connection objects, two type surfaces that both need maintenance until sunset. Mitigated by the single-RPC-endpoint policy and the pipeline-reads-v2 unification.
- Onboarding cost: a new contributor needs to understand the v1/v2 split, the per-handler routing, and which stack a given action lives in. Mitigated by the `handlers/` vs. `handlers-v2/` directory split, which makes the assignment grep-able.
- The longer the migration takes, the longer this ADR is normative. There is no enforced deadline — but the audit punch list (item 15) names the related "module: NodeNext" + dynImport-shim cleanup as a high-priority follow-up, which incentivizes finishing the migration sooner.

### Neutral
- Migration progress is visible in `git log` via the `handlers-v2/` directory growth and the `handlers/` directory shrinkage; no separate tracking is needed.
- The dispatcher is stack-agnostic — it routes by action name, not by stack. Adding new actions does not touch the dispatcher.

## References
- `docs/adr/ADR-012-web3js-v2-migration.md` — original v1→v2 migration commitment
- PR #4, commit `d5dc764` — `feat(mcp-server): ADR-012 PR2 — introduce @solana/kit (v2) surface + v1 adapter`
- PR #22, commit `1c6b691` — `fix(mcp-server): wire v2 Kit RPC into preflight dispatch + make smoke test idempotent`
- PR #23, commit `a2f1eb7` — `feat(mcp-server): wire v2 vault_transfer sendAndConfirm to Kit factory`
- `mcp-server/src/index.ts` — dual-stack boot wiring
- `mcp-server/src/solana.ts` (v1), `mcp-server/src/solana-v2.ts` (v2)
- `mcp-server/src/handlers/` (v1) and `mcp-server/src/handlers-v2/` (v2)
- `mcp-server/src/pipeline/` — shared preflight reading from v2
- `mcp-server/src/adapters/mcp.ts` — action router
- `docs/adr/ARCHITECTURE-AUDIT-2026-04-23.md` F-4 / F-5 / F-6 (missing-ADR backfill obligation)

# CLAUDE.md — escrow-explorer

AI-tool context for extending this Agenomics gallery sample (ADR-137).

## What this sample is

A read-only Solana devnet script that inspects the settlement
program: the singleton `ProtocolConfig` plus any `TaskEscrow`, via
`@agenomics/client`'s `SettlementClient`. Single entry point:
[`explorer.ts`](./explorer.ts).

## Hard constraints (do not violate)

- **Read-only.** `@agenomics/client@0.1.0` ships PDA derivation +
  typed account fetch ONLY. There are NO settlement instruction
  builders (`createEscrow`, `fundEscrow`, `approveMilestone`,
  `disputeEscrow`, `settleEscrow`) — out of scope per ADR-098. Do
  not write code that signs or submits a settlement transaction; it
  will not compile against the shipped SDK. If asked to "create an
  escrow here," explain the write surface is SDK-roadmap and point
  at `sdk/client/README.md`.
- **Keep it a single-file sample.** Match the `examples/`
  discipline: one runnable `.ts`, `tsconfig.json`, `package.json`
  with `start` + `typecheck`, `README.md`, this `CLAUDE.md`.
- `samples/` is excluded from the root workspaces glob. SDK deps
  resolve via `file:../../sdk/idl` and `file:../../sdk/client`.
- The IDL is passed via the canonical cast pattern
  (`SettlementIdl as unknown as ConstructorParameters<typeof
  SettlementClient>[1]`). Do not "fix" this to import a non-exported
  `Settlement` type — that type is internal to the client package.

## Canonical SDK surface this sample uses

- `getProgramIds("devnet")` → `{ agentRegistry, agentVault, settlement }`
- `new SettlementClient(provider, idlCast, settlementProgramId)`
- `await settlement.protocolConfigPda()` → `Address` (async)
- `await settlement.fetchProtocolConfig()` → Anchor-decoded
  `ProtocolConfig` (`minEscrowAmount`, `disputeTimeoutSeconds`, ...
  all `BN`); throws if not bootstrapped — catch and explain.
- `await settlement.escrowPda(client, provider, taskId)` → `Address`
- `await settlement.fetchEscrow(client, provider, taskId)` →
  Anchor-decoded `TaskEscrow` (`status` is an enum-shaped object
  like `{ active: {} }`; `totalAmount: BN`; `milestones: [...]`;
  `disputedAt: BN | null`); throws if the account does not exist —
  catch and explain.
- `EscrowStatus` (numeric enum) from `@agenomics/client` for the
  known variant labels.

## Safe extension ideas (all stay read-only)

- Add a `--json` mode for piping into a dashboard or indexer.
- Poll an escrow on an interval and diff its `status` over time.
- Cross-reference with `reputation-leaderboard`: show "this
  escrow's provider, and its current reputation rank."
- Decode + render `milestones[].graceEndsAt` as human time.
- Read multiple `taskId`s for a `(client, provider)` pair and
  render an escrow history.

## When the write side ships

When SDK settlement instruction builders land, this sample grows a
sibling "create + fund + watch" flow IN PLACE — do not delete the
read path; it remains the no-wallet, no-signing entry point and the
audit/observability surface.

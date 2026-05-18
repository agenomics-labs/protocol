# CLAUDE.md — reputation-leaderboard

AI-tool context for extending this Agenomics gallery sample (ADR-137).

## What this sample is

A read-only Solana devnet script that ranks Agenomics agents by
on-chain reputation using `@agenomics/client`'s `AgentRegistryClient`.
Single entry point: [`leaderboard.ts`](./leaderboard.ts).

## Hard constraints (do not violate)

- **Read-only.** `@agenomics/client@0.1.0` ships PDA derivation +
  typed account fetch ONLY. There are NO instruction builders
  (`registerAgent`, `updateAgent`, ...) — they are out of scope per
  ADR-098. Do not write code that signs or submits transactions; it
  will not compile against the shipped SDK. If asked to "register an
  agent here," explain the write surface is SDK-roadmap and point at
  `sdk/client/README.md`.
- **No bulk enumeration.** There is no `getProgramAccounts` /
  `all()` helper on `AgentRegistryClient` in 0.1.0. Discovery is by
  known `(authority, nonce)`. The candidate set comes from the
  `AGENT_AUTHORITIES` env var. Do not fabricate a bulk-fetch API.
- **Keep it a single-file sample.** Match the `examples/` discipline:
  one runnable `.ts`, a `tsconfig.json`, a `package.json` with
  `start` + `typecheck`, a `README.md`, this `CLAUDE.md`.
- `samples/` is excluded from the root workspaces glob. SDK deps
  resolve via `file:../../sdk/idl` and `file:../../sdk/client`.

## Canonical SDK surface this sample uses

- `getProgramIds("devnet")` → `{ agentRegistry, agentVault, settlement }`
- `new AgentRegistryClient(provider, AgentRegistryIdl as Idl, programId)`
- `await registry.profilePda(authority, nonce)` → `Address` (async)
- `await registry.fetchProfile(authority, nonce)` → Anchor-decoded
  `AgentProfile`; throws if the account does not exist (the expected
  "not registered" case — catch and skip).
- `clampReputationScore(BigInt(profile.reputationScore.toString()))`
  → number in `[0, MAX_REPUTATION_SCORE]` (AUD-112-safe rendering).
- `MAX_REPUTATION_SCORE` = 100 (ADR-094).

## Safe extension ideas (all stay read-only)

- Add a `--json` output mode for piping into a dashboard.
- Read each profile's `status` / `pricingModel` and add columns
  (import `AgentStatus`, `PricingModel` from `@agenomics/client`).
- Rank across multiple nonces per authority (loop `nonce` 0..N,
  using `fetchOwnerNonce` to bound N).
- Wire into `escrow-explorer` to show "top agents + their open
  escrows" once that sample's read surface is composed in.

## When the write side ships

When SDK instruction builders land, this sample grows a sibling
"register then watch your rank" flow IN PLACE — do not delete the
read path; it remains the no-wallet entry point.

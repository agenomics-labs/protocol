# ADR-046: Add Missing MCP Tools (vault_token_transfer, stake_reputation, resolve_dispute_timeout)

**Status:** Accepted
**Date:** 2026-04-16

## Context

The AEAP MCP server exposes three on-chain programs (Vault, Registry, Settlement) to AI agents. Several on-chain instructions added in previous ADRs lacked corresponding MCP tool definitions, making them inaccessible to agents:

1. **`executeTokenTransfer`** (Vault) -- SPL token transfers from the vault were not exposed. Agents could only transfer native SOL via `vault_transfer`.
2. **`stakeReputation`** (Registry, ADR-020) -- Reputation staking was implemented on-chain but had no MCP entry point.
3. **`resolveDisputeTimeout`** (Settlement, ADR-030) -- Automatic timeout-based dispute resolution existed on-chain but could not be triggered by agents.

## Decision

Add three new MCP tools with corresponding handlers:

### 1. `vault_token_transfer`
- **Parameters:** `tokenMintAddress`, `recipientTokenAccount`, `amount`
- **Handler:** `handleVaultTokenTransfer` -- derives the vault's ATA for the given mint and calls `executeTokenTransfer` on the Vault program.

### 2. `stake_reputation`
- **Parameters:** `amount` (in SOL)
- **Handler:** `handleStakeReputation` -- derives a staking PDA with seeds `[authority, "reputation-stake"]` and calls `stakeReputation` on the Registry program.

### 3. `resolve_dispute_timeout`
- **Parameters:** `escrowAddress`
- **Handler:** `handleResolveDisputeTimeout` -- fetches the escrow to obtain party addresses and token mint, derives ATAs, and calls `resolveDisputeTimeout` on the Settlement program.

All handlers use the existing validation helpers (`requireString`, `requirePositiveNumber`).

## Alternatives Considered

1. **Batch all missing tools in one release** -- We considered auditing every on-chain instruction for missing MCP coverage. Decided to ship these three now as they are the most requested, and audit remaining gaps separately.
2. **Generic `call_program` tool** -- A single tool that accepts arbitrary instruction data. Rejected because it bypasses type safety and human-readable descriptions that make MCP tools agent-friendly.

## Consequences

- **Positive:** Agents can now perform SPL token transfers, stake reputation, and resolve expired disputes without custom transaction building.
- **Positive:** Tool count increases from 20 to 23, covering the most critical missing instructions.
- **Negative:** Each new tool adds surface area that must be maintained alongside on-chain changes.

## Files Changed

- `mcp-server/src/tools.ts` -- Added tool definitions and updated `allTools` array and `ToolName` type.
- `mcp-server/src/index.ts` -- Added handler functions and switch cases.

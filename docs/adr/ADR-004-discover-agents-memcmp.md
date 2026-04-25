# ADR-004: Add memcmp Filters to discover_agents

## Status
Accepted

## Date
2026-04-15

## Context
The `discover_agents` MCP handler called `agentProfile.all()` with no filters, fetching every `AgentProfile` account from the RPC node. On devnet with a handful of accounts this was acceptable, but on mainnet with thousands of registered agents, `getProgramAccounts` without filters would:

1. Time out on public RPC endpoints (default 30s timeout)
2. Consume excessive bandwidth and compute
3. Get rate-limited by RPC providers
4. Cause poor user experience for AI agents waiting for results

## Decision
Add RPC-level `memcmp` filters to push filtering to the Solana RPC node:

1. **Status filter (default)**: Filter to Active agents only using a `memcmp` on the status enum byte at the computed offset in the `AgentProfile` layout. This is the most impactful filter since most queries want active agents.
2. **Client-side filters**: Category and capability filters remain client-side because:
   - Category is a variable-length `String` — memcmp on the length prefix is fragile
   - Capability matching requires substring search across a `Vec<String>`
3. **Opt-out**: Pass `includeInactive: true` to skip the status filter

The status byte offset (998) is computed from the serialized `AgentProfile` layout with Anchor discriminator.

## Alternatives Considered

### Alternative: Add a secondary index account (category -> agent list)
Rejected for v1 as it requires additional on-chain accounts and maintenance instructions. Better suited for a dedicated indexer service.

### Alternative: Use Helius DAS API or custom indexer
Good long-term solution but adds infrastructure dependency. memcmp filters provide immediate improvement with no additional infrastructure.

## Consequences

### Positive
- Significantly reduces RPC payload on mainnet (only active agents transferred)
- No infrastructure changes required
- Backward compatible — default behavior unchanged

### Negative
- Status offset calculation is coupled to `AgentProfile` struct layout — any field reordering requires recalculation
- Variable-length fields (String, Vec) make exact offset calculation fragile
- Category/capability filtering still happens client-side

## Files Changed
- `mcp-server/src/index.ts` - `handleDiscoverAgents` rewritten with filters

## Revisions

- 2026-04-25 — Superseded by ADR-042 (memcmp offset removed). AUD-2026-04-25
  drift matrix §4.

# ADR-042: Remove Fragile memcmp Offset from discover_agents

**Status:** Accepted
**Date:** 2026-04-16

## Context

The `handleDiscoverAgents` handler in the MCP server used a hardcoded `memcmp` filter at byte offset 998 to filter agent profiles by their `status` field directly at the RPC level. This offset was manually computed from the Anchor `AgentProfile` account layout (discriminator + authority + name + description + category + capabilities + pricing_model + pricing_amount + accepted_tokens + vault_address = 998 bytes).

This approach is fragile because:

1. Any change to the `AgentProfile` struct field order, size, or padding invalidates the offset silently.
2. Anchor version upgrades may change alignment or discriminator handling.
3. The offset calculation is not verified at compile time and has no runtime assertion.
4. A wrong offset causes the filter to match against unrelated bytes, returning incorrect results with no error.

## Decision

Remove the `memcmp`-based status filter entirely. Fetch all `agentProfile` accounts from the RPC and apply status filtering client-side:

```typescript
if (!args.includeInactive) {
  filtered = filtered.filter((a) => a.status === "active");
}
```

This trades a small increase in RPC data transfer for correctness and maintainability. The registry is expected to hold hundreds to low thousands of agents, well within client-side filtering capacity.

## Alternatives Considered

1. **Keep memcmp with a unit test guard** -- Add a test that serializes a known profile and asserts the status byte offset. Rejected because it couples the MCP server tests to the on-chain schema serialization format.
2. **Use Anchor discriminator + `dataSlice`** -- Fetch only the status byte via `dataSlice` to reduce bandwidth. Rejected because it still requires a hardcoded offset.
3. **Add an on-chain index/view account** -- Maintain a separate account listing active agents. Rejected as over-engineering for the current scale.

## Consequences

- **Positive:** The handler is now resilient to any on-chain schema changes.
- **Positive:** Simpler code with fewer magic numbers.
- **Negative:** Slightly higher RPC bandwidth when many inactive agents exist.
- **Negative:** Cannot push filtering to the RPC node; all accounts are fetched every call.

## Files Changed

- `mcp-server/src/index.ts` -- `handleDiscoverAgents` rewritten to use client-side status filtering.

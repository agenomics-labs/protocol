# ADR-018: Framework Integration Plugins

## Status
Accepted

## Date
2026-04-15

## Context
The AEAP MCP server exposes 20 tools across three domains (Vault, Registry, Settlement). While any MCP-compatible agent can use these tools directly, two major agent frameworks -- ElizaOS and Solana Agent Kit (SAK) -- have their own plugin/tool interfaces. Native plugins for these frameworks lower the adoption barrier by providing idiomatic integrations that framework users expect.

The architecture doc (Section 1: Ecosystem Integrations) identifies ElizaOS and Solana Agent Kit as primary integration targets.

## Decision
Create two framework-specific plugin files that wrap all 20 AEAP MCP tools:

### ElizaOS Plugin (`src/integrations/elizaos-plugin.ts`)
- Exports an `aeapPlugin` object conforming to ElizaOS's plugin interface (`{ name, description, version, actions }`)
- Each action maps 1:1 to an MCP tool with the same parameters
- Actions are prefixed with `aeap_` to avoid naming conflicts
- A `setMcpClient()` function allows injection of the MCP transport layer
- Uses a factory pattern (`createAction`) to minimize boilerplate across all 20 actions
- Actions organized into three groups: vault (7), registry (4), settlement (9)

### Solana Agent Kit Plugin (`src/integrations/solana-agent-kit-plugin.ts`)
- Exports `aeapTools` array conforming to SAK's tool interface (`{ name, description, inputs, execute }`)
- Same 1:1 mapping to MCP tools with `aeap_` prefix
- Uses a factory pattern (`sakTool`) for consistent tool definitions
- Input definitions use SAK's `{ name, type, description, required }` format

Both plugins delegate actual execution to the MCP client, keeping the plugins as thin adapters. This ensures:
- Business logic stays in the MCP server (single source of truth)
- Framework updates don't require tool logic changes
- New MCP tools are easy to add to both plugins

## Alternatives Considered

### Alternative A: Direct Solana SDK calls in each plugin
Rejected because it would duplicate the transaction-building logic from the MCP server. Changes to on-chain programs would require updates in three places (MCP server + both plugins) instead of one.

### Alternative B: Single universal adapter with framework detection
Rejected because ElizaOS and SAK have fundamentally different plugin interfaces. A single adapter would need runtime framework detection and conditional exports, adding unnecessary complexity.

### Alternative C: Code generation from MCP tool schemas
Considered but deferred. For 20 tools the manual approach is maintainable. If AEAP grows beyond 50 tools, a code generator from the tool definitions in `mcp-server/src/tools.ts` would be warranted.

## Consequences

### Positive
- ElizaOS agents can use AEAP with standard plugin installation
- SAK agents can use AEAP tools alongside existing SAK tools
- Thin adapter pattern keeps maintenance cost low
- Factory pattern ensures consistent naming and parameter mapping
- Both plugins are dependency-free (only need an MCP client instance)

### Negative
- Plugins must be manually updated when new MCP tools are added
- Type definitions for ElizaOS and SAK are locally defined (not imported from framework packages)
- No runtime validation of parameters beyond what the MCP server provides
- Goat framework integration deferred to a future ADR

## Files Changed
- `src/integrations/elizaos-plugin.ts` - ElizaOS plugin wrapping 20 MCP tools as actions
- `src/integrations/solana-agent-kit-plugin.ts` - SAK plugin wrapping 20 MCP tools as SAK tools

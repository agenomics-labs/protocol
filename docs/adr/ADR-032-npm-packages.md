# ADR-032: npm Package Preparation

**Status:** Accepted
**Date:** 2026-04-15

## Context

AEAP needs publishable npm packages so that external developers can install and use the MCP server and integration plugins without cloning the repository.

## Decision

Create two scoped npm packages:

1. **@aeap/mcp-server** - The MCP server as a standalone CLI and library. Configured with `bin` entry for `aeap-mcp`, `types` for TypeScript consumers, `publishConfig` for public access, and a `files` whitelist for clean publishes.

2. **@aeap/integrations** - ElizaOS and Solana Agent Kit plugins as a single package. Exports `aeapPlugin` (ElizaOS) and `aeapTools` (SAK) from a barrel `index.ts`. Declares `@modelcontextprotocol/sdk` as a peer dependency.

## Consequences

- External developers can `npm install @aeap/mcp-server` and run it directly via `npx`.
- Framework integration is a single `npm install @aeap/integrations` away.
- Both packages publish only compiled `dist/` output, keeping source private.
- Peer dependency on MCP SDK avoids version conflicts with host projects.

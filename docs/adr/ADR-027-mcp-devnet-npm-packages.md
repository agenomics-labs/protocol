# ADR-027: MCP Devnet Wiring and npm Package Configuration

- **Status**: Accepted
- **Date**: 2026-04-15

## Context

The MCP server, ElizaOS plugin, and Solana Agent Kit plugin have been developed as local TypeScript packages but lack the configuration needed for (a) devnet connectivity and (b) publishing to npm under the `@aeap` scope. Devnet testing requires a dedicated environment file so that developers do not accidentally point integration tests at mainnet-beta. Publishing separate npm packages allows third-party agent frameworks to depend on individual components without pulling the entire monorepo.

## Decision

1. **Devnet environment file**: Create `mcp-server/.env.devnet` with:
   - `SOLANA_RPC_URL=https://api.devnet.solana.com`
   - `SOLANA_KEYPAIR_PATH=~/.config/solana/id.json`
   
   The MCP server loads this file when `NODE_ENV=devnet` or when explicitly passed via `--env-file .env.devnet`.

2. **npm package configurations**: Prepare `package.json` files for three publishable packages:
   - `@agenomics/mcp-server` -- Model Context Protocol server exposing AEAP Solana instructions as MCP tools. Entry point: `dist/index.js`. Peer dependency on `@solana/web3.js ^2.0`.
   - `@agenomics/elizaos-plugin` -- ElizaOS plugin wrapping MCP tools for agent integration. Peer dependency on `@elizaos/core`.
   - `@agenomics/solana-agent-kit-plugin` -- Solana Agent Kit plugin providing AEAP actions. Peer dependency on `solana-agent-kit`.

3. **Build and publish workflow**: Each package includes `build`, `test`, and `prepublishOnly` scripts. A root-level `scripts/publish-packages.sh` orchestrates version bumping and `npm publish --access public` for all three packages.

## Alternatives Considered

1. **Single monolithic npm package** -- Simpler to publish but forces consumers to install unneeded dependencies (e.g., ElizaOS users would pull Solana Agent Kit deps).
2. **GitHub Packages registry** -- Avoids npmjs.com but adds authentication friction for external consumers.
3. **Hardcoded devnet RPC in source** -- Eliminates the `.env.devnet` file but prevents per-developer RPC endpoint customization and risks committing private RPC URLs.

## Consequences

- Developers can switch to devnet with `cp .env.devnet .env` or by setting `NODE_ENV=devnet`.
- Each package is independently versionable and publishable under the `@aeap` npm scope.
- `.env.devnet` is committed to the repo (contains no secrets); `.env` remains git-ignored.
- Third-party frameworks can install only the plugin they need, reducing dependency footprint.

## Files Changed

- `mcp-server/.env.devnet` -- new devnet environment configuration
- `mcp-server/package.json` -- add `@agenomics/mcp-server` name, build/publish scripts
- `integrations/elizaos-plugin/package.json` -- add `@agenomics/elizaos-plugin` name, peer deps
- `integrations/solana-agent-kit-plugin/package.json` -- add `@agenomics/solana-agent-kit-plugin` name, peer deps
- `scripts/publish-packages.sh` -- new multi-package publish orchestration script

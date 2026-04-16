# AEAP - Autonomous Economic Agents Protocol

A trustless economic layer on Solana where AI agents operate as independent economic entities — with on-chain identity, programmable wallets, discovery, and autonomous payment settlement.

## Architecture

```
AI Agents (Claude, ChatGPT, ElizaOS, custom)
         |
    MCP Server (23 tools)
         |
    Solana Blockchain
    +-- Agent Vault     (programmable wallets, spending policies)
    +-- Agent Registry   (identity, reputation, discovery)
    +-- Settlement       (escrow, milestones, disputes)
```

## Devnet Deployment

| Program | Address |
|---------|---------|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` |

## Quick Start

```bash
# Install MCP server
cd mcp-server && npm install

# Configure for devnet
cp .env.devnet .env

# Start MCP server
npm run dev
```

### Connect to Claude Desktop

Add to your Claude Desktop MCP config:
```json
{
  "mcpServers": {
    "aeap": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/AEAP/mcp-server"
    }
  }
}
```

## MCP Tools (23)

### Vault (8)
`create_vault` `get_vault_info` `vault_transfer` `vault_token_transfer` `update_vault_policy` `pause_vault` `resume_vault` `manage_allowlist`

### Registry (5)
`register_agent` `get_agent_profile` `update_agent_profile` `discover_agents` `stake_reputation`

### Settlement (10)
`create_escrow` `accept_task` `submit_milestone` `approve_milestone` `reject_milestone` `get_escrow_status` `cancel_escrow` `raise_dispute` `resolve_dispute` `resolve_dispute_timeout`

## Development

```bash
# Build programs
anchor build --no-idl

# Run unit tests (48 tests)
cargo test

# Run integration tests (31 tests)
cd mcp-server && npx ts-mocha -p tsconfig.test.json test/mcp-handlers.test.ts --timeout 120000

# Preview documentation
cd docs && npm run dev

# Preview dashboard
cd dashboard && npm run dev
```

## Key Features

- **Programmable Vaults** — Per-transaction limits, daily caps, rate limiting, token allowlists
- **Agent Discovery** — On-chain registry with categories, capabilities, and reputation scores
- **Escrow Settlement** — Milestone-based payments with atomic fund locking
- **Reputation Staking** — SOL collateral with automatic slashing on disputes (3 strikes = suspended)
- **Dispute Resolution** — 7-day timeout with auto-resolution, reputation penalties
- **Anti-Sybil** — Minimum escrow amounts, self-dealing prohibition
- **MCP Bridge** — Any AI agent framework can interact via Model Context Protocol

## Documentation

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [Integration Guide](docs/integration-guide.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security Audit Prep](docs/SECURITY_AUDIT.md)
- [50 ADRs](docs/adr/)

## Security

- 0 npm vulnerabilities
- 0 open audit findings (50 ADRs documenting all decisions)
- PDA-signed CPI for cross-program reputation updates
- Defense-in-depth: Anchor constraints + handler checks + economic barriers
- Reputation penalty scale: +50 (complete) / -25 (dispute) / -25 (timeout) / -10 (expiry)

## License

MIT

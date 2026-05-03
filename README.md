# Agenomics Protocol

A trustless economic layer on Solana where AI agents operate as independent economic entities — with on-chain identity, programmable wallets, discovery, and autonomous payment settlement.

## Architecture

```
AI Agents (Claude, ChatGPT, ElizaOS, custom)
         |
    MCP Server (27 tools)
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

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):
```json
{
  "mcpServers": {
    "agenomics": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/your/clone/of/protocol/mcp-server"
    }
  }
}
```
Restart Claude Desktop after editing. The 27 tools (`create_vault`, `register_agent`, `create_escrow`, etc) become available to any agent in the conversation.

## MCP Tools (27)

### Vault (9)
`create_vault` `get_vault_info` `vault_transfer` `vault_token_transfer` `update_vault_policy` `rotate_agent_identity` `pause_vault` `resume_vault` `manage_allowlist`

### Registry (6)
`register_agent` `get_agent_profile` `update_agent_profile` `discover_agents` `find_similar_agents` `stake_reputation`

### Reputation (1)
`get_agent_reputation`

### Settlement (10)
`create_escrow` `accept_task` `submit_milestone` `approve_milestone` `reject_milestone` `get_escrow_status` `cancel_escrow` `raise_dispute` `resolve_dispute` `resolve_dispute_timeout`

### Governance (1)
`verify_protocol_invariants`

## Development

```bash
# Build programs
anchor build --no-idl

# Run unit tests
cargo test

# Run mcp-server unit tests (383 tests; node:test + tsx)
cd mcp-server && npm test

# Anchor integration tests (full lifecycle against local validator)
anchor test

# Preview documentation
cd docs && npm run dev

# Preview dashboard
cd dashboard && npm run dev
```

## Key Features

- **Programmable Vaults** — Per-transaction limits, daily caps, rate limiting, token allowlists
- **Agent Discovery** — On-chain registry with categories, capabilities, and reputation scores
- **Escrow Settlement** — Milestone-based payments with atomic fund locking
- **Reputation Staking** — Optional SOL collateral (ADR-020); slash_count escalation suspends agents at 3 dispute losses (ADR-094, ADR-131)
- **Dispute Resolution** — Governance-tunable timeout (7-day default) with auto-resolution, reputation penalties
- **Anti-Sybil** — Minimum escrow amounts, self-dealing prohibition
- **MCP Bridge** — Any AI agent framework can interact via Model Context Protocol

## Documentation

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [Integration Guide](docs/integration-guide.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security Audit Prep](docs/SECURITY_AUDIT.md)
- [ADRs](docs/adr/)

## Security

- 0 npm vulnerabilities
- 0 open findings from internal audit cycles 1-3; external audit pending
- PDA-signed CPI for cross-program reputation updates
- Defense-in-depth: Anchor constraints + handler checks + economic barriers
- Reputation deltas: +10 (complete) / -5 (dispute or timeout) / -3 (expiry); capped at ±10 per call, scores clamped to [0, 100] (ADR-094)

## License

TBD

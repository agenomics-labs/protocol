---
layout: home
hero:
  name: AEP
  text: Agenomics Protocol
  tagline: Programmable vaults, agent discovery, and milestone-based settlement on Solana
  actions:
    - theme: brand
      text: Getting Started
      link: /getting-started
    - theme: alt
      text: API Reference
      link: /api-reference
features:
  - title: Agent Vault
    details: Programmable wallets with per-transaction limits, daily caps, rate limiting, token/program allowlists, and pause/resume controls.
  - title: Agent Registry
    details: On-chain discovery and reputation system. Register agents with capabilities, pricing models, and category-based search.
  - title: Settlement Protocol
    details: Milestone-based SPL token escrow with submit/approve/reject cycles, dispute resolution, and CPI reputation updates.
  - title: MCP Server
    details: 27 tools exposing all on-chain instructions via Model Context Protocol. Works with Claude, ChatGPT, and any MCP-compatible client.
---

## Quick Start

The MCP server isn't on npm yet — install from source:

```bash
# Clone and build the workspace (root postinstall builds all 4 TS packages)
git clone https://github.com/agenomics-labs/protocol
cd protocol && npm install

# Configure for devnet
cp mcp-server/.env.devnet mcp-server/.env

# Run the MCP server (or have your MCP client launch it via stdio)
node mcp-server/dist/index.js
```

See [Getting Started](./getting-started.md) for the full Claude Desktop / Cursor wiring.

## Architecture

AEP consists of three Solana programs connected via real CPI:

| Program | Program ID | Purpose |
|---------|-----------|---------|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | Programmable wallets with spending policies |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | Discovery and reputation |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | Milestone escrow and disputes |

## Links

- [Getting Started](/getting-started) - Installation and first steps
- [API Reference](/api-reference) - All 27 MCP tools documented
- [Integration Guide](/integration-guide) - ElizaOS, Solana Agent Kit, Claude/ChatGPT

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
    details: 20 tools exposing all on-chain instructions via Model Context Protocol. Works with Claude, ChatGPT, and any MCP-compatible client.
---

## Quick Start

```bash
# Install the MCP server
npm install @agenomics/mcp-server

# Or run directly
npx @agenomics/mcp-server

# Install integration plugins
npm install @agenomics/integrations
```

## Architecture

AEP consists of three Solana programs connected via real CPI:

| Program | Program ID | Purpose |
|---------|-----------|---------|
| Agent Vault | `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN` | Programmable wallets with spending policies |
| Agent Registry | `8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh` | Discovery and reputation |
| Settlement | `GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3` | Milestone escrow and disputes |

## Links

- [Getting Started](/getting-started) - Installation and first steps
- [API Reference](/api-reference) - All 20 MCP tools documented
- [Integration Guide](/integration-guide) - ElizaOS, Solana Agent Kit, Claude/ChatGPT

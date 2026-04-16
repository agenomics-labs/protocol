# AEAP MCP Server - Project Index

## Quick Links

### Getting Started
- **[SETUP.md](SETUP.md)** - Installation and quick start (5 minutes)
- **[README.md](README.md)** - Full documentation and tool reference
- **[.env.example](.env.example)** - Configuration template

### Understanding the Project
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design and data flow
- **[PROJECT_SUMMARY.txt](PROJECT_SUMMARY.txt)** - Project overview
- **[FILE_MANIFEST.md](FILE_MANIFEST.md)** - Detailed file listing

### Source Code
- **[src/index.ts](src/index.ts)** - Main MCP server (640 lines)
- **[src/tools.ts](src/tools.ts)** - Tool definitions (538 lines)
- **[src/solana.ts](src/solana.ts)** - Blockchain utilities (167 lines)

### Configuration
- **[package.json](package.json)** - Dependencies and build scripts
- **[tsconfig.json](tsconfig.json)** - TypeScript configuration
- **[.gitignore](.gitignore)** - Git ignore patterns

---

## Project at a Glance

**AEAP MCP Server** - A TypeScript Model Context Protocol server for the Autonomous Economic Agents Protocol on Solana.

### What It Does
Enables AI agents (Claude, ChatGPT, Eliza) to:
- Create and manage programmable agent wallets with spending policies
- Register agents in an on-chain reputation system
- Create task offers and escrow payments between agents
- Execute complex blockchain interactions safely

### The 12 Tools

#### Vault Tools (5)
1. `create_vault` - Initialize vault with policies
2. `get_vault_info` - Query vault state
3. `vault_transfer` - Execute policy-enforced transfers
4. `vault_program_call` - Execute composable calls
5. `get_audit_log` - View action history

#### Registry Tools (4)
1. `register_agent` - Register in agent registry
2. `discover_agents` - Search for agents
3. `get_agent_profile` - View agent details
4. `update_my_profile` - Update profile

#### Settlement Tools (4)
1. `create_task` - Create task with escrow
2. `accept_task` - Accept task offer
3. `complete_task` - Submit completion proof
4. `get_task_status` - Check task status

### Technology
- **Language**: TypeScript
- **Protocol**: Model Context Protocol (MCP)
- **Blockchain**: Solana
- **Key Libraries**: 
  - @modelcontextprotocol/sdk
  - @solana/web3.js
  - @coral-xyz/anchor

### Key Statistics
- **Code**: 1,345 lines (3 TypeScript files)
- **Config**: 112 lines (4 files)
- **Docs**: 1,600+ lines (6 documentation files)
- **Total**: 3,000+ lines

---

## Quick Start (5 Minutes)

1. **Install**
   ```bash
   cd /sessions/elegant-quirky-davinci/mnt/Solana/aeap/mcp-server
   npm install
   ```

2. **Configure**
   ```bash
   export SOLANA_RPC_URL="https://api.devnet.solana.com"
   export SOLANA_KEYPAIR_PATH="~/.config/solana/id.json"
   ```

3. **Build**
   ```bash
   npm run build
   ```

4. **Run**
   ```bash
   npm start
   ```

5. **Connect with Claude**
   - Add server path to Claude Desktop config
   - Restart Claude
   - Start using AEAP tools in conversations

For detailed instructions, see [SETUP.md](SETUP.md).

---

## Project Structure

```
aeap-mcp-server/
├── src/                          # Source code
│   ├── index.ts                 # Main server (640 lines)
│   ├── tools.ts                 # Tool definitions (538 lines)
│   └── solana.ts                # Blockchain utilities (167 lines)
├── dist/                         # Compiled JS (after npm run build)
├── package.json                 # Dependencies
├── tsconfig.json                # TypeScript config
├── .env.example                 # Configuration template
├── .gitignore                   # Git ignore
├── README.md                    # Full documentation
├── SETUP.md                     # Quick start guide
├── ARCHITECTURE.md              # System design
├── PROJECT_SUMMARY.txt          # Project overview
├── FILE_MANIFEST.md             # File listing
└── INDEX.md                     # This file
```

---

## Documentation Map

### For First-Time Users
1. Start with **[SETUP.md](SETUP.md)** - Get it running in 5 minutes
2. Try out the tools with Claude
3. Read **[README.md](README.md)** for detailed tool documentation

### For Developers
1. Read **[ARCHITECTURE.md](ARCHITECTURE.md)** - Understand system design
2. Review **[FILE_MANIFEST.md](FILE_MANIFEST.md)** - See what's in each file
3. Check **[src/index.ts](src/index.ts)** - Look at handler implementations
4. Study **[src/solana.ts](src/solana.ts)** - Understand blockchain integration

### For Integration
1. Review **[ARCHITECTURE.md](ARCHITECTURE.md)** - Understand integration points
2. Check **[PROJECT_SUMMARY.txt](PROJECT_SUMMARY.txt)** - See next steps
3. Look at handler placeholders in **[src/index.ts](src/index.ts)**
4. Plan on-chain program integration

---

## Common Tasks

### Build and Run
```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm start            # Start the server
npm run watch        # Auto-rebuild on changes
```

### Configure
- Copy `.env.example` to `.env`
- Set `SOLANA_RPC_URL` for your endpoint
- Set `SOLANA_KEYPAIR_PATH` to your keypair

### Debug
- Check TypeScript compilation: `npm run build`
- Verify wallet: `solana address`
- Check Solana connection: `solana cluster version`
- Run server in debug mode: `npm run dev`

### Deploy
1. Build the project: `npm run build`
2. Copy `dist/` to server
3. Install node modules: `npm ci --only=production`
4. Run: `node dist/index.js`

---

## Next Steps

### To Use Immediately
1. Follow [SETUP.md](SETUP.md)
2. Start using tools with Claude

### To Integrate On-Chain
1. Understand the design in [ARCHITECTURE.md](ARCHITECTURE.md)
2. Create/integrate Solana programs
3. Replace placeholder handlers with real blockchain calls
4. Deploy and test with local validator

### To Extend
1. Add more tools in [src/tools.ts](src/tools.ts)
2. Implement handlers in [src/index.ts](src/index.ts)
3. Add utilities to [src/solana.ts](src/solana.ts)

---

## Key Concepts

### Model Context Protocol (MCP)
A standard protocol for AI agents to discover and use tools. The server:
1. Defines tools with JSON schemas
2. Handles tool call requests
3. Returns structured results

### Agent Vault
A programmable wallet account that:
- Holds SOL and tokens for agents
- Enforces spending policies (daily limits, per-tx limits)
- Only allows whitelisted tokens and programs
- Creates an audit trail of all actions

### Agent Registry
An on-chain directory where agents:
- Register their capabilities and services
- Publish pricing information
- Build reputation scores
- Advertise to other agents

### Settlement Protocol
An escrow system for agent-to-agent tasks:
- Task requester locks payment
- Provider accepts and works on task
- Provider submits completion proof
- Settlement occurs upon verification

---

## Architecture Overview

```
Claude/AI Agent
       ↓
MCP Protocol (JSON-RPC via stdio)
       ↓
AEAP MCP Server (TypeScript)
  - Tools (12 functions)
  - Solana utilities
  - Error handling
       ↓
Solana Blockchain (via RPC)
  - Vault Program
  - Registry Program
  - Settlement Protocol
```

---

## Support & Resources

### Solana Documentation
- [Solana Documentation](https://docs.solana.com/)
- [Web3.js API Reference](https://solana-labs.github.io/solana-web3.js/)
- [Anchor Framework](https://www.anchor-lang.com/)

### MCP Documentation
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)

### Local Development
- [Solana CLI Guide](https://docs.solana.com/cli)
- [Local Development Setup](https://docs.solana.com/developers/setup-local-development)

---

## File Size Reference

| File | Size | Type |
|------|------|------|
| src/index.ts | 22 KB | TypeScript |
| src/tools.ts | 18 KB | TypeScript |
| src/solana.ts | 5.4 KB | TypeScript |
| README.md | 11 KB | Markdown |
| ARCHITECTURE.md | 16 KB | Markdown |
| SETUP.md | 5.6 KB | Markdown |
| PROJECT_SUMMARY.txt | 14 KB | Text |
| FILE_MANIFEST.md | 9.2 KB | Markdown |
| package.json | 766 B | JSON |
| tsconfig.json | 477 B | JSON |

---

## Project Status

✅ **Complete**: Scaffolding and tool definitions
✅ **Complete**: Solana integration utilities
✅ **Complete**: MCP server setup
✅ **Complete**: Comprehensive documentation

🟡 **Pending**: On-chain program integration
🟡 **Pending**: Real blockchain interactions
🟡 **Pending**: Comprehensive testing
🟡 **Pending**: Production deployment

---

## Contact & Questions

For questions about:
- **Setup/Usage**: See [SETUP.md](SETUP.md)
- **Tools/Features**: See [README.md](README.md)
- **Architecture/Design**: See [ARCHITECTURE.md](ARCHITECTURE.md)
- **File Organization**: See [FILE_MANIFEST.md](FILE_MANIFEST.md)

---

## Version Information

- **Project**: AEAP MCP Server
- **Version**: 1.0.0
- **Created**: 2026-04-14
- **Status**: Alpha (Scaffolding Complete)
- **License**: TBD

---

## Quick Links Summary

| Need | File |
|------|------|
| Get started quickly | [SETUP.md](SETUP.md) |
| Full documentation | [README.md](README.md) |
| System architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Project overview | [PROJECT_SUMMARY.txt](PROJECT_SUMMARY.txt) |
| File details | [FILE_MANIFEST.md](FILE_MANIFEST.md) |
| Main server code | [src/index.ts](src/index.ts) |
| Tool definitions | [src/tools.ts](src/tools.ts) |
| Blockchain utils | [src/solana.ts](src/solana.ts) |

---

**Start here**: [SETUP.md](SETUP.md) for quick start, or [ARCHITECTURE.md](ARCHITECTURE.md) for deep dive.

Last Updated: 2026-04-14

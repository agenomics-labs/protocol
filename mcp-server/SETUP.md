# AEAP MCP Server - Setup Guide

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

This installs:
- `@modelcontextprotocol/sdk` - MCP protocol library
- `@solana/web3.js` - Solana blockchain client
- `@coral-xyz/anchor` - Anchor framework (IDL support)
- TypeScript and dev dependencies

### 2. Configure Solana Wallet

Option A: Use default location
```bash
# Solana CLI creates keypairs here by default
~/.config/solana/id.json
```

Option B: Set custom path
```bash
export SOLANA_KEYPAIR_PATH="/path/to/your/keypair.json"
```

Option C: Use Solana CLI
```bash
solana-keygen new --outfile ~/.config/solana/id.json
```

### 3. Configure RPC Endpoint

Option A: Use Devnet (default)
```bash
# No configuration needed, defaults to:
# https://api.devnet.solana.com
```

Option B: Use custom endpoint
```bash
export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
# or local validator:
export SOLANA_RPC_URL="http://localhost:8899"
```

### 4. Build the Server
```bash
npm run build
```

This compiles TypeScript to `dist/` directory.

### 5. Start the Server
```bash
npm start
```

The server will:
1. Load your wallet
2. Connect to the Solana RPC
3. Initialize MCP on stdio
4. Wait for tool calls from MCP clients

## Usage with Claude

### Option 1: Claude Desktop (macOS/Windows)
Add to `~/.claude-config/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "aeap": {
      "command": "node",
      "args": ["/path/to/aeap/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop, then ask: "Connect to the AEAP server"

### Option 2: Claude API with MCP
```bash
# Use with the Claude SDK
npm install @anthropic-ai/sdk
```

Example:
```typescript
const client = new Anthropic({
  mcpServers: [
    {
      name: "aeap",
      command: "node /path/to/dist/index.js"
    }
  ]
});

// Now Claude can use AEAP tools in conversations
```

### Option 3: Direct Testing
```bash
# Test vault creation
curl -X POST http://localhost:3000/tools/call \
  -H "Content-Type: application/json" \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "create_vault",
      "arguments": {
        "dailySpendLimit": 10,
        "perTxLimit": 2,
        "allowedTokens": []
      }
    }
  }'
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `SOLANA_KEYPAIR_PATH` | `~/.config/solana/id.json` | Path to keypair file |

## Troubleshooting

### "Keypair file not found"
```bash
# Check if your keypair exists
ls -la ~/.config/solana/id.json

# If not, create one:
solana-keygen new --outfile ~/.config/solana/id.json
```

### "Connection failed"
```bash
# Verify RPC endpoint is accessible
curl https://api.devnet.solana.com -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

# Should return: {"jsonrpc":"2.0","result":"ok","id":1}
```

### Build errors
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build
```

## Development Workflow

### Watch Mode (Auto-rebuild on changes)
```bash
npm run watch
```

### Run with Nodemon (Auto-restart on changes)
```bash
npm install --save-dev nodemon
npx nodemon --watch dist dist/index.js
```

### Type Checking
```bash
npx tsc --noEmit
```

## Next Steps: Production Implementation

The current server provides:
- ✅ Complete tool definitions
- ✅ Solana utilities
- ✅ MCP server scaffolding
- ✅ Error handling

To make it production-ready, you'll need to:

1. **Create Solana programs** (on-chain contracts)
   - Agent Vault program (SPL-based wallet with policies)
   - Agent Registry program (PDA-based agent registry)
   - Settlement Protocol (escrow and payment logic)

2. **Implement tool handlers**
   - Replace placeholder returns with actual blockchain interactions
   - Add real transaction building and sending
   - Implement event/audit log queries

3. **Add comprehensive tests**
   - Unit tests for Solana utilities
   - Integration tests with local validator
   - MCP protocol compliance tests

4. **Deploy**
   - Deploy programs to Devnet/Mainnet
   - Update program addresses in code
   - Configure production RPC endpoint

## File Structure

```
mcp-server/
├── src/
│   ├── index.ts         # MCP server & handlers (640 lines)
│   ├── tools.ts         # Tool definitions (538 lines)
│   └── solana.ts        # Solana utilities (167 lines)
├── dist/                # Compiled JavaScript (auto-generated)
├── package.json         # Dependencies
├── tsconfig.json        # TypeScript config
├── README.md            # Full documentation
└── SETUP.md             # This file
```

## Useful Commands

```bash
# View wallet address
solana address

# Check balance
solana balance

# Fund wallet (Devnet)
solana airdrop 10

# Check RPC health
solana cluster version

# View recent transactions
solana transaction-history $(solana address)
```

## Architecture Notes

### MCP Communication Flow
```
Claude/Client
    ↓
MCP Protocol (JSON-RPC over stdio)
    ↓
AEAP MCP Server (Node.js)
    ↓
Tool Handlers (TypeScript)
    ↓
Solana Connection (web3.js)
    ↓
Blockchain (via RPC)
```

### Tool Categories
1. **Vault Tools** (5) - Agent wallets with policies
2. **Registry Tools** (4) - Agent discovery & reputation
3. **Settlement Tools** (4) - Task offers & escrow

Total: **12 tools** available to AI agents

## Support

For issues:
1. Check the troubleshooting section
2. Review generated error messages
3. Check Solana blockchain state via `solana account`
4. Verify wallet and RPC configuration

## License

TBD

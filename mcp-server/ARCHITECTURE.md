# Agenomics MCP Server Architecture

## High-Level Overview

The Agenomics MCP Server is a TypeScript-based Model Context Protocol server that provides a bridge between AI agents (Claude, ChatGPT, Eliza) and the Agenomics Protocol on Solana.

```
┌─────────────────────────────────────────────────────────────┐
│ AI Agents (Claude, ChatGPT, Eliza, etc.)                   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     │ MCP Protocol (JSON-RPC over stdio)
                     │
┌─────────────────────┴────────────────────────────────────────┐
│ Agenomics MCP Server (Node.js + TypeScript)                      │
│                                                              │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Tool Handlers (index.ts)                                │ │
│ │ - 12 tools organized in 3 categories                    │ │
│ │ - Request/response handling                            │ │
│ │ - Input validation                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│                     │                                        │
│                     ▼                                        │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Solana Utilities (solana.ts)                            │ │
│ │ - RPC connection management                            │ │
│ │ - Wallet loading & caching                             │ │
│ │ - Transaction building/sending                         │ │
│ │ - Balance queries                                      │ │
│ └─────────────────────────────────────────────────────────┘ │
│                     │                                        │
│                     ▼                                        │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      │ HTTPS (JSON-RPC)
                      │
┌─────────────────────┴────────────────────────────────────────┐
│ Solana Blockchain (Devnet/Mainnet)                          │
│                                                              │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ Agent Vault Program                                  │  │
│ │ - Vault accounts (PDAs)                             │  │
│ │ - Spending policies                                 │  │
│ │ - Transfer execution                                │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                              │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ Agent Registry Program                               │  │
│ │ - Agent accounts (PDAs)                             │  │
│ │ - Capabilities & pricing                            │  │
│ │ - Reputation tracking                               │  │
│ └───────────────────────────────────────────────────────┘  │
│                                                              │
│ ┌───────────────────────────────────────────────────────┐  │
│ │ Settlement Protocol Program                          │  │
│ │ - Task accounts                                     │  │
│ │ - Escrow accounts                                   │  │
│ │ - Payment settlement                                │  │
│ └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Module Structure

### 1. src/index.ts (640 lines)
**Main MCP Server & Tool Handlers**

#### Responsibilities:
- Initialize MCP server
- Register all 12 tools
- Implement tool handlers for each tool
- Handle JSON-RPC requests/responses
- Error handling and result serialization

#### Key Components:

**Server Initialization**
```typescript
const server = new Server({
  name: "aep-mcp-server",
  version: "1.0.0"
});
```

**Tool Registration**
- `tools/list` endpoint - Returns all available tools
- `tools/call` endpoint - Routes tool calls to handlers

**Handler Pattern**
```typescript
async function handleCreateVault(args: Record<string, unknown>) {
  // 1. Validate inputs
  // 2. Build instruction(s)
  // 3. Execute transaction
  // 4. Return result
}
```

#### Handler Organization:

**Vault Tool Handlers (5)**
1. `handleCreateVault` - Initialize vault with policies
2. `handleGetVaultInfo` - Query vault state
3. `handleVaultTransfer` - Execute policy-enforced transfer
4. `handleVaultProgramCall` - Execute composable calls
5. `handleGetAuditLog` - Retrieve action history

**Registry Tool Handlers (4)**
1. `handleRegisterAgent` - Register in on-chain registry
2. `handleDiscoverAgents` - Search by criteria
3. `handleGetAgentProfile` - Get agent details
4. `handleUpdateMyProfile` - Update agent info

**Settlement Tool Handlers (4)**
1. `handleCreateTask` - Create task offer with escrow
2. `handleAcceptTask` - Provider accepts task
3. `handleCompleteTask` - Submit completion proof
4. `handleGetTaskStatus` - Check task state

### 2. src/tools.ts (538 lines)
**Tool Definitions & JSON Schemas**

#### Responsibilities:
- Define all 12 tools with metadata
- Specify JSON input/output schemas
- Document tool parameters
- Enable MCP client discovery

#### Tool Definition Pattern:
```typescript
export const createVaultTool: Tool = {
  name: "create_vault",
  description: "...",
  inputSchema: {
    type: "object",
    properties: { /* JSON schema */ },
    required: [/* required fields */]
  }
};
```

#### Schema Validation:
- All tools use strict JSON Schema (draft 7)
- Input types: string, number, boolean, array, object
- Required vs optional parameters clearly marked
- Descriptions for each parameter

#### Tool Categories:

**Vault Tools (5)**
- Daily/per-tx spend limits
- Token whitelists
- Program whitelists
- Transfer execution
- Audit logging

**Registry Tools (4)**
- Agent registration
- Capability/pricing discovery
- Reputation tracking
- Profile updates

**Settlement Tools (4)**
- Task creation with escrow
- Provider acceptance
- Completion verification
- Status queries

### 3. src/solana.ts (167 lines)
**Solana Blockchain Integration**

#### Responsibilities:
- Manage RPC connection
- Load and cache wallet keypairs
- Build and send transactions
- Query blockchain state
- Utility functions

#### Key Functions:

**Connection Management**
```typescript
getConnection(): Connection
  // Lazy-loads RPC connection
  // Defaults to Devnet
  // Configurable via env var

loadWallet(walletPath?): Keypair
  // Loads keypair from file
  // Checks env var, then path, then default
  // Caches for performance

getWalletPublicKey(): PublicKey
  // Get agent's address
```

**Balance & Conversion**
```typescript
getBalance(pubkey): Promise<number>
  // Returns SOL balance

solToLamports(sol: number): number
  // Convert SOL to lamports (1 SOL = 10^9 lamports)

lamportsToSol(lamports: number): number
  // Convert lamports to SOL
```

**Transaction Building**
```typescript
sendTransaction(
  instructions: TransactionInstruction[],
  walletPath?: string,
  skipPreflightValidation?: boolean
): Promise<string>
  // 1. Create transaction
  // 2. Add instructions
  // 3. Set recent blockhash
  // 4. Sign with wallet
  // 5. Send and confirm
  // 6. Return signature
```

**Validation**
```typescript
isValidPublicKey(key: string): boolean
  // Check if valid base58 pubkey

parsePublicKey(key: string): PublicKey
  // Parse and return PublicKey
  // Throws if invalid
```

#### Configuration:
- `SOLANA_RPC_URL` - RPC endpoint (defaults to Devnet)
- `SOLANA_KEYPAIR_PATH` - Keypair file path

## Data Flow

### Example: Creating a Vault

```
1. Claude calls tool
   {
     "name": "create_vault",
     "arguments": {
       "dailySpendLimit": 10,
       "perTxLimit": 2,
       "allowedTokens": []
     }
   }

2. MCP Server receives request
   ↓ server.setRequestHandler(CallToolRequest, ...)

3. Route to handler
   ↓ handleCreateVault(args)

4. Validate inputs
   - Check dailySpendLimit > 0
   - Check perTxLimit <= dailySpendLimit
   - Verify array formats

5. Load wallet
   ↓ loadWallet()

6. Build instruction(s)
   - Create vault PDA
   - Initialize state
   - Set policies

7. Create transaction
   ↓ sendTransaction([instruction])

8. Get blockhash
   ↓ getLatestBlockhash()

9. Sign & send
   ↓ wallet.sign() + conn.sendTransaction()

10. Confirm
    ↓ conn.confirmTransaction()

11. Return result to Claude
    {
      "success": true,
      "vaultAddress": "...",
      "policies": {...},
      "transactionSignature": "..."
    }
```

## State Management

### Caching Strategy
```typescript
// RPC Connection (singleton)
let connection: Connection | null = null;
getConnection() // Returns cached or creates new

// Wallet (singleton)
let cachedWallet: Keypair | null = null;
loadWallet() // Returns cached or loads from disk
```

### No Persistent State
- Server is stateless
- All state is on-chain
- Cache is in-memory (lost on restart)
- Safe for horizontal scaling

## Error Handling

### Validation Errors
```typescript
if (!vaultAddress || !isValidPublicKey(vaultAddress)) {
  throw new Error("Invalid vault address");
}
```

### Network Errors
```typescript
try {
  await sendTransaction([instruction]);
} catch (error) {
  // Network error, insufficient fees, etc.
  return {
    error: error.message,
    tool: toolName
  };
}
```

### Response Format
```typescript
// Success
{
  "content": [
    {
      "type": "text",
      "text": "{ /* result JSON */ }"
    }
  ]
}

// Error
{
  "content": [
    {
      "type": "text",
      "text": "{ \"error\": \"...\", \"tool\": \"...\" }"
    }
  ],
  "isError": true
}
```

## Integration Points

### With On-Chain Programs

**Agent Vault Program**
- Instruction: `InitVault` - Create vault with policies
- Instruction: `Transfer` - Execute transfer
- Instruction: `ProgramCall` - Execute CPI
- Event: `VaultCreated`, `TransferExecuted`, etc.

**Agent Registry Program**
- Instruction: `RegisterAgent` - Create agent account
- Instruction: `UpdateProfile` - Modify capabilities/pricing
- Query: Filter agents by capability/reputation
- Event: `AgentRegistered`, `ProfileUpdated`, etc.

**Settlement Protocol Program**
- Instruction: `CreateTask` - Create task + escrow
- Instruction: `AcceptTask` - Provider accepts
- Instruction: `CompleteTask` - Submit proof
- Event: `TaskCreated`, `TaskAccepted`, `TaskSettled`, etc.

### Anchor IDL Integration
Once programs are deployed with Anchor:
```typescript
// Load IDL from chain
const idl = await Program.fetchIdl(programId, provider);

// Use for type-safe instruction building
const tx = await program.methods
  .createVault(dailyLimit, perTxLimit)
  .accounts({ vault, owner, systemProgram })
  .rpc();
```

## Security Considerations

### Wallet Security
- Never log private keys
- Load from secure file storage
- Keypair never transmitted
- Cached only in memory

### Transaction Security
- All transactions signed locally
- No private key exposure to RPC
- Confirmation polling to prevent double-spend
- Recent blockhash to prevent replay attacks

### Input Validation
- All tool inputs validated before use
- Base58 public key validation
- Amount validation (no negative transfers)
- Schema validation via JSON schema

### Future Enhancements
- Request signing/verification
- Rate limiting per agent
- Audit logging of all operations
- Multi-sig support for high-value operations

## Performance Characteristics

### Latency
- Tool call: ~100ms (JSON parsing)
- RPC query: ~500ms (network latency)
- Transaction confirmation: ~5-15s (blockchain)
- Total: ~5-20s per tool call

### Throughput
- Single server: ~10-20 concurrent calls
- Bottleneck: Solana network (not this server)
- Horizontal scaling: Possible via load balancer

### Memory
- Connection: ~1-2 MB (cached)
- Wallet: ~100 bytes (keypair)
- Per call: ~100-500 KB (temporary)

## Testing Strategy

### Unit Tests (solana.ts)
- Key validation
- SOL/lamports conversion
- Public key parsing

### Integration Tests (full flow)
- Vault creation
- Agent registration
- Task settlement
- With local validator

### MCP Protocol Tests
- Tool discovery
- Request/response format
- Error handling
- Schema validation

## Deployment

### Local Development
```bash
npm install
npm run build
npm start
```

### Docker
```dockerfile
FROM node:18
WORKDIR /app
COPY . .
RUN npm ci --only=production
RUN npm run build
CMD ["npm", "start"]
```

### Cloud Deployment
- Heroku, AWS Lambda, Azure Functions possible
- Requires HTTP-to-stdio bridge (not stdio direct)
- Stateless design makes scaling easy

## Future Enhancements

### Phase 2: Full Implementation
- Implement actual program interactions
- Add Anchor IDL integration
- Implement event/audit queries
- Add comprehensive tests

### Phase 3: Advanced Features
- Multi-sig vault support
- Recurring payments/subscriptions
- AI agent-to-agent contracts
- Advanced policy creation (conditional logic)

### Phase 4: Ecosystem Integration
- Integration with other MCP servers
- Support for other blockchain networks
- Advanced reputation/credit systems
- Multi-currency support

## References

- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [Solana Web3.js Documentation](https://solana-labs.github.io/solana-web3.js/)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Solana Program Examples](https://github.com/solana-labs/solana-program-library)

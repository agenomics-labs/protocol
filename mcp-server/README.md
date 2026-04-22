# Agenomics MCP Server

A TypeScript Model Context Protocol (MCP) server for the Agenomics Protocol on Solana. This server enables any AI agent (Claude, ChatGPT, ElizaOS, etc.) to interact with the AEP on-chain programs.

## Overview

The Agenomics MCP Server exposes three core components of the AEP:

### 1. Agent Vault
Programmable wallets for AI agents with customizable spending policies:
- **Daily spend limits** - Control how much can be spent in 24 hours
- **Per-transaction limits** - Cap individual transfers
- **Token whitelists** - Restrict which tokens the vault can transfer
- **Program whitelists** - Control which programs the vault can invoke (composability)

Tools:
- `create_vault` - Initialize a new vault with policies
- `get_vault_info` - Check vault balance and policies
- `vault_transfer` - Transfer tokens (enforces policies)
- `vault_program_call` - Execute composable program calls
- `get_audit_log` - View recent vault actions

### 2. Agent Registry
On-chain discovery and reputation system:
- Register agents with capabilities and pricing
- Search for service providers by category, reputation, or price
- Build agent-to-agent trust networks
- Track on-chain reputation scores

Tools:
- `register_agent` - Register in the registry with capabilities
- `discover_agents` - Search for agents by criteria
- `get_agent_profile` - View detailed agent information
- `update_my_profile` - Update agent capabilities or pricing

### 3. Settlement Protocol
Escrow and payment settlement between agents:
- Task-based service requests with escrowed payments
- Provider acceptance and proof-of-completion
- Automated settlement on verification
- Performance bonds for reliability

Tools:
- `create_task` - Create a task offer and lock payment
- `accept_task` - Accept a task as the provider
- `complete_task` - Submit completion proof
- `get_task_status` - Check task state

## Installation

### Prerequisites
- Node.js 18+
- TypeScript
- A Solana wallet configured locally

### Setup

```bash
# Install dependencies
npm install

# Build the TypeScript
npm run build

# Start the server
npm start
```

## Configuration

The server uses environment variables for configuration:

```bash
# Solana RPC endpoint (defaults to Devnet)
export SOLANA_RPC_URL="https://api.devnet.solana.com"

# Path to keypair file (defaults to ~/.config/solana/id.json)
export SOLANA_KEYPAIR_PATH="/path/to/keypair.json"

# Replay-protection backend (ADR-059 §5). Unset → in-memory store
# (single-instance). Set to a redis:// URL → multi-instance-safe
# Redis-backed store. Idempotent action results are JSON-serialized
# under key prefix `aep:idem:` with a 10-minute TTL.
export AEP_REDIS_URL="redis://localhost:6379"

# IPFS HTTP gateway base URL for capability-manifest fetches (ADR-060 §3).
# Must be a gateway root — the handler appends "/ipfs/<cid>" itself. Defaults
# to "https://ipfs.io". Set to a local Kubo daemon ("http://localhost:8080")
# to avoid public-gateway rate limits and propagation delays.
export AEP_IPFS_GATEWAY="http://localhost:8080"
```

### Replay-protection backend (`AEP_REDIS_URL`)

Idempotent settlement actions (`submit_milestone`, `approve_milestone`,
`resolve_dispute`, …) use a mutex-per-key store to collapse concurrent
duplicate submits into a single on-chain effect. Two backends are
available:

| Backend   | Selected when       | Scope              | Dep       |
| --------- | ------------------- | ------------------ | --------- |
| in-memory | `AEP_REDIS_URL` unset | single process  | none      |
| Redis     | `AEP_REDIS_URL` set   | multi-instance  | `ioredis` |

**JSON serialization caveat.** The Redis backend serializes cached
`Result<T>` values with `JSON.stringify`. `T` must therefore be JSON-safe
— primitives, arrays, and plain objects are fine; `Map`, `Set`, `BigInt`,
`Date`, functions, and circular references will not round-trip. All AEP
idempotent actions currently return plain string/number/boolean records,
so this is not a practical constraint today.

## Usage with Claude

To use this MCP server with Claude:

1. Build and run the server
2. Configure your MCP client (Claude Desktop, API, etc.) to use this stdio transport
3. Call tools via the MCP interface

Example tool call structure:
```json
{
  "method": "tools/call",
  "params": {
    "name": "create_vault",
    "arguments": {
      "dailySpendLimit": 10,
      "perTxLimit": 2,
      "allowedTokens": [],
      "vaultName": "My Agent Vault"
    }
  }
}
```

## Tool Reference

### Vault Tools

#### create_vault
Creates a new agent vault with spending policies.

**Parameters:**
- `dailySpendLimit` (number, required): Daily limit in SOL
- `perTxLimit` (number, required): Per-transaction limit in SOL
- `allowedTokens` (string[], required): Array of mint addresses
- `allowedPrograms` (string[], optional): Whitelisted program addresses
- `vaultName` (string, optional): Friendly name

**Returns:**
- `vaultAddress`: Address of the new vault
- `policies`: The configured spending policies
- `transactionSignature`: On-chain transaction ID

#### get_vault_info
Fetches current vault state and balance.

**Parameters:**
- `vaultAddress` (string, required): Base58 vault address

**Returns:**
- `balanceSol`: Current SOL balance
- `policies`: Active spending policies
- `spent24h`: Amount spent in last 24 hours
- `isActive`: Whether vault is active

#### vault_transfer
Transfer tokens from vault to recipient.

**Parameters:**
- `vaultAddress` (string, required): Source vault
- `recipientAddress` (string, required): Recipient address
- `amount` (number, required): Amount in SOL
- `tokenMint` (string, optional): Token mint (defaults to SOL)
- `memo` (string, optional): Transfer description

**Returns:**
- `transactionSignature`: On-chain tx ID
- `timestamp`: When transfer was executed

#### vault_program_call
Execute a program interaction from the vault (composable calls).

**Parameters:**
- `vaultAddress` (string, required): Vault address
- `programId` (string, required): Program to invoke
- `accounts` (object[], required): Account metadata
- `data` (string, required): Instruction data (hex-encoded)
- `memo` (string, optional): Call description

**Returns:**
- `transactionSignature`: On-chain tx ID
- `accountCount`: Number of accounts used

#### get_audit_log
Retrieve recent vault actions.

**Parameters:**
- `vaultAddress` (string, required): Vault address
- `limit` (number, optional): Max entries (default: 50)
- `offset` (number, optional): Pagination offset

**Returns:**
- `events`: Array of vault actions
- `totalCount`: Total events in log

### Registry Tools

#### register_agent
Register this agent in the on-chain registry.

**Parameters:**
- `agentName` (string, required): Agent name
- `agentDescription` (string, required): Description
- `capabilities` (string[], required): Service categories
- `basePricePerTask` (number, required): Price in SOL
- `minTaskValue` (number, optional): Minimum task size
- `maxConcurrentTasks` (number, optional): Concurrency limit
- `metadata` (object, optional): Extended profile data

**Returns:**
- `agentAddress`: Agent's registry address
- `transactionSignature`: Registration tx ID

#### discover_agents
Search for agents in the registry.

**Parameters:**
- `capability` (string, optional): Filter by capability
- `minReputation` (number, optional): Minimum score (0-100)
- `maxPricePerTask` (number, optional): Maximum price filter
- `sortBy` (string, optional): Sort field (reputation|price|name|createdAt)
- `limit` (number, optional): Results per page (default: 20)
- `offset` (number, optional): Pagination offset

**Returns:**
- `agents`: Array of agent summaries
- `totalCount`: Total matching agents

#### get_agent_profile
Get detailed information about an agent.

**Parameters:**
- `agentAddress` (string, required): Agent address

**Returns:**
- `agentName`: Agent name
- `capabilities`: Service categories
- `reputation`: Reputation score
- `basePricePerTask`: Standard rate
- `tasksCompleted`: Lifetime completions
- `taskSuccessRate`: Percentage of successful tasks
- `totalEarned`: Total SOL earned

#### update_my_profile
Update this agent's profile.

**Parameters:**
- `capabilities` (string[], optional): Updated capabilities
- `basePricePerTask` (number, optional): Updated price
- `agentDescription` (string, optional): Updated description
- `maxConcurrentTasks` (number, optional): Updated concurrency
- `metadata` (object, optional): Updated metadata

**Returns:**
- `updatedFields`: Fields that were changed
- `transactionSignature`: Update tx ID

### Settlement Tools

#### create_task
Create a task offer and lock payment in escrow.

**Parameters:**
- `providerAgentAddress` (string, required): Provider agent
- `taskDescription` (string, required): Task details
- `taskValue` (number, required): Payment in SOL
- `deadline` (number, required): Unix timestamp deadline
- `requiredProofs` (string[], optional): Proof types needed
- `metadata` (object, optional): Task-specific data

**Returns:**
- `taskId`: Unique task identifier
- `escrowBalance`: Escrowed amount
- `status`: Task status (should be "open")

#### accept_task
Accept a task as the provider agent.

**Parameters:**
- `taskId` (string, required): Task identifier
- `performanceBond` (number, optional): Bond amount in SOL
- `estimatedCompletionTime` (number, optional): Seconds to complete

**Returns:**
- `status`: Should be "accepted"
- `transactionSignature`: Acceptance tx ID

#### complete_task
Submit completion proof to finalize a task.

**Parameters:**
- `taskId` (string, required): Task identifier
- `completionProof` (string, required): Proof URL or hash
- `completionNotes` (string, optional): Provider notes
- `resultMetadata` (object, optional): Result data

**Returns:**
- `status`: Should be "completed_pending_approval"
- `transactionSignature`: Submission tx ID

#### get_task_status
Check the current state of a task.

**Parameters:**
- `taskId` (string, required): Task identifier

**Returns:**
- `status`: Current task state
- `requesterAgentAddress`: Task creator
- `providerAgentAddress`: Task provider
- `escrowBalance`: Current escrowed amount
- `deadline`: Task deadline
- `statusHistory`: Timeline of status changes

## Architecture

### File Structure
```
src/
  ├── index.ts       # MCP server entry point & handlers
  ├── tools.ts       # Tool definitions & schemas
  └── solana.ts      # Solana connection & utilities
```

### Key Components

**index.ts**
- MCP server initialization
- Tool registration
- Handler implementations for all 12 tools
- Request/response handling

**tools.ts**
- Tool metadata and JSON schemas
- Input validation schemas
- Consistent tool definitions for MCP discovery

**solana.ts**
- RPC connection management
- Keypair loading and caching
- Balance queries
- Transaction building and sending
- Utility functions (key validation, SOL/lamports conversion)

## Implementation Notes

### Current State
The current implementation provides:
- ✅ Complete tool definitions with JSON schemas
- ✅ Solana connection and wallet utilities
- ✅ MCP server setup and registration
- ✅ Error handling and validation
- ✅ Type-safe tool name handling

### Production Considerations
To move to production, you'll need to:

1. **Implement actual on-chain interactions:**
   - Create/fetch vault PDAs and accounts
   - Deserialize vault state from blockchain
   - Generate and send vault policy-enforcing instructions
   - Integrate with Anchor IDL for type-safe program calls

2. **Add real event/audit trail queries:**
   - Query Program Derived Addresses (PDAs)
   - Parse blockchain events for audit logs
   - Implement pagination for large result sets

3. **Implement settlement logic:**
   - Create escrow token accounts
   - Handle atomic settlement transactions
   - Verify completion proofs
   - Manage token accounts for different mints

4. **Security enhancements:**
   - Add request signing and verification
   - Implement rate limiting per agent
   - Add transaction batching for efficiency
   - Cache frequently-accessed state

5. **Error recovery:**
   - Handle network timeouts and retries
   - Implement transaction confirmation polling
   - Add fallback RPC endpoints
   - Log all operations for debugging

## Development

### Build
```bash
npm run build
```

### Watch mode
```bash
npm run watch
```

### Start
```bash
npm start
```

## License

TBD

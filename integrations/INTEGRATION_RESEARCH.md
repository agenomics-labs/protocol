# AEAP Integration Research

Integration analysis for the Autonomous Economic Agents Protocol (AEAP) with three key Solana ecosystem tools and standards.

---

## 1. x402 Protocol (by Coinbase)

### Overview

**x402** is an open payment protocol developed by Coinbase that enables autonomous, instant stablecoin payments directly over HTTP by reviving the HTTP 402 Payment Required status code. It allows AI agents and services to monetize APIs without accounts, sessions, or complex authentication.

**Sources:** [x402 Official](https://www.x402.org/), [Coinbase Developer Docs](https://docs.cdp.coinbase.com/x402/welcome), [GitHub: coinbase/x402](https://github.com/coinbase/x402), [AWS Blog](https://aws.amazon.com/blogs/industries/x402-and-agentic-commerce-redefining-autonomous-payments-in-financial-services/)

### How It Works

x402 operates through a three-step HTTP payment flow:

1. **Request & Challenge**: Client makes HTTP request to resource server. Server responds with `402 Payment Required` and includes payment instructions in the `PAYMENT-REQUIRED` header.

2. **Payment Construction**: Client selects one of the `PaymentRequirements` from server response and constructs a `PaymentPayload` based on the payment scheme and network. Client resends the HTTP request with the `PAYMENT-SIGNATURE` header containing the payload.

3. **Settlement**: Resource server either:
   - Directly settles the payment on-chain, OR
   - POSTs the Payment Payload to a facilitator's `/settle` endpoint
   - Facilitator server broadcasts the transaction to the blockchain

**Settlement Speed**: Payments settle at blockchain speed (~2 seconds), with funds moving directly from payer to receiver without intermediaries (zero protocol fees).

### Network Identification & Schemes

x402 uses **CAIP-2 Network Identifiers** for chain identification:
- `eip155:8453` = Base Sepolia
- `eip155:1` = Ethereum Mainnet  
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` = Solana Mainnet

The protocol is extensible through **payment schemes** (e.g., `erc20`, `spl-token`) that define how settlement happens on each network.

### Key Features

- **Multi-Token Support**: Any ERC-20 or SPL token via Permit2 (EVM) or token extensions (Solana/SPL)
- **Multi-Network**: Single client supports EVM chains (Base, Polygon, Ethereum) and Solana
- **Free Facilitator Tier**: Coinbase Developer Platform offers 1,000 free transactions/month
- **SDKs**: TypeScript, Go, and Python client/server libraries available
- **Extensions**: Service discovery, gasless approvals, authentication protocols

### AEAP Integration Approach

**Goal**: Use AEAP Agent Vaults as x402 payment sources to enable AI agents to pay for services.

**Integration Flow**:

```
AI Agent (with AEAP Identity)
    ↓
Requests protected resource (HTTP GET/POST)
    ↓
Server responds: 402 Payment Required + PaymentRequirements
    ↓
Agent constructs PaymentPayload using:
  - Agent's Vault PDA (AEAP Settlement program)
  - Selected network (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
  - Selected token (USDC)
  - Server's payment address
    ↓
Agent signs PaymentPayload with Vault authority
    ↓
Agent sends HTTP request with PAYMENT-SIGNATURE header
    ↓
Server verifies signature & settles via:
  - AEAP Settlement program (direct), or
  - x402 Facilitator (delegated)
```

**Key Integration Points**:

1. **Vault as Payment Source**: AEAP's Agent Vault PDA becomes the funding account for x402 transactions
   - Vault must hold sufficient SPL token balance (USDC recommended)
   - Vault authority must sign the payment payload
   
2. **Solana Program Integration**: AEAP Settlement program handles:
   - Verification of x402 PaymentPayload signatures
   - Token transfer from Agent Vault to merchant/facilitator
   - Event emission for payment logging

3. **Client Library**: Extend AEAP SDK to include:
   - `createX402PaymentPayload()` - constructs payload from Vault
   - `signX402Payment()` - signs with Vault authority
   - `submitX402Request()` - sends HTTP request with PAYMENT-SIGNATURE header

### Code Interface Sketch

```typescript
// x402 Payment Payload Construction
interface AeapX402Payment {
  vaultPda: PublicKey;          // Agent's AEAP Vault
  network: string;              // e.g., "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  scheme: string;               // e.g., "spl-token"
  token: PublicKey;             // SPL token mint (USDC)
  amount: u64;                  // Amount in token units
  merchant: PublicKey;          // Recipient address
  nonce: string;                // Request nonce for replay protection
  expiration: u64;              // Unix timestamp
}

// Client-side function signature
async function createX402PaymentPayload(
  agent: AeapAgent,
  requirements: PaymentRequirements,
  merchantAddress: PublicKey
): Promise<PaymentPayload>

// Settlement program instruction
async function settleX402Payment(
  connection: Connection,
  vaultPda: PublicKey,
  vaultAuthority: Keypair,
  paymentPayload: PaymentPayload
): Promise<string>  // Returns transaction signature
```

### Estimated Effort

**~12-16 hours** for an experienced Solana developer with x402 familiarity:

- 2h: Study x402 spec & facilitator integration
- 3h: Design AEAP Settlement program instruction for x402 payments
- 4h: Implement Settlement program logic (verify signature, transfer tokens, logging)
- 3h: Build client SDK extensions (payload construction, signing, HTTP submission)
- 2h: Write tests & documentation
- 2h: Buffer for debugging & edge cases

**Note**: If using Coinbase's x402 Facilitator (recommended for MVP), Settlement program complexity drops to ~2h (just transfer to facilitator address).

---

## 2. ElizaOS (AI Agent Framework)

### Overview

**ElizaOS** is an open-source AI agent operating system that provides a unified, plugin-based architecture for building autonomous agents. It supports multiple LLMs (OpenAI, Anthropic, Google, etc.) and enables agents to interact with various platforms through a modular plugin system.

**Key Stats**: 90+ official plugins, event-driven architecture, Hierarchical Task Networks (HTN) for complex goal decomposition.

**Sources:** [ElizaOS Docs](https://docs.elizaos.ai/plugins/architecture), [GitHub: elizaOS/eliza](https://github.com/elizaOS/eliza), [Plugin Reference](https://docs.elizaos.ai/plugins/reference), [ArXiv Paper](https://arxiv.org/html/2501.06781v1)

### How It Works

ElizaOS follows a plugin-based architecture where everything is a plugin:

**Core Components**:
- **Runtime**: Central orchestrator that processes messages, manages memory, and coordinates plugins
- **Client**: Interface layer (Discord, Telegram, direct HTTP, etc.)
- **Memory System**: Persists messages, facts, and knowledge across conversations
- **Actions**: Named behaviors that agents can execute
- **Evaluators**: Analyze context and recommend next actions
- **Providers**: Inject contextual data into agent reasoning
- **Services**: Long-running background processes

**Execution Flow**:
1. Client receives message → forwards to Runtime
2. Runtime loads relevant memories and character configuration
3. Providers inject context
4. Evaluators assess situation
5. Actions available for execution
6. LLM generates response/action
7. New memories stored
8. Response sent back through Client

### Plugin Interface

ElizaOS plugins implement the **Plugin** interface:

```typescript
interface Plugin {
  name: string;                    // Unique identifier
  description: string;             // What the plugin does
  actions?: Action[];              // Available actions
  evaluators?: Evaluator[];        // Decision-making logic
  providers?: Provider[];          // Context providers
  services?: Service[];            // Background services
  init?: (runtime: IAgentRuntime) => Promise<void>;  // Setup
}
```

**Action Interface**:
```typescript
interface Action {
  name: string;                    // Unique action name (e.g., "TRANSFER_TOKENS")
  similes?: string[];              // Alternative trigger phrases
  description?: string;            // What the action does
  validate: (runtime, message) => Promise<boolean>;    // Can execute?
  handler: (runtime, message) => Promise<any>;         // Execute action
  examples?: ActionExample[];      // Training examples for LLM
}
```

**Evaluator Interface**:
```typescript
interface Evaluator {
  name: string;                    // Unique evaluator name
  description?: string;
  similes?: string[];
  alwaysRun?: boolean;             // Run even without trigger
  handler: (runtime, message, state) => Promise<void>;
  validate?: (runtime, message) => Promise<boolean>;
  examples?: ActionExample[];
}
```

**Provider Interface**:
```typescript
interface Provider {
  name: string;
  description: string;
  get: (runtime, message, state) => Promise<ProviderResult>;
}

interface ProviderResult {
  values?: Record<string, unknown>;
  data?: any;
  text?: string;                   // Injected into prompt context
}
```

### AEAP Integration Approach

**Goal**: Write an AEAP plugin that enables ElizaOS agents to manage agent identities, wallets, and make payments.

**Plugin Structure**:

```
@aeap/eliza-plugin
├── src/
│   ├── index.ts                 # Plugin export
│   ├── actions/
│   │   ├── createAgentIdentity.ts
│   │   ├── checkBalance.ts
│   │   ├── transferTokens.ts
│   │   └── executeAeapAction.ts
│   ├── evaluators/
│   │   ├── shouldInitializeAgent.ts
│   │   └── shouldCheckBalance.ts
│   ├── providers/
│   │   ├── agentStateProvider.ts
│   │   └── walletBalanceProvider.ts
│   └── types.ts
```

**Integration Flow**:

1. **At Runtime Init**: Agent auto-initializes AEAP identity if needed
2. **Context Injection**: Providers supply agent wallet state & balances to LLM context
3. **Action Execution**: When LLM decides to pay for service, Action handles AEAP Settlement program interaction
4. **State Tracking**: Evaluators monitor agent resources and recommend conservation strategies

### Code Interface Sketch

```typescript
// Action: Create AEAP Agent Identity
export const createAgentIdentity: Action = {
  name: "CREATE_AEAP_IDENTITY",
  description: "Initialize AEAP identity & vault for this agent",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    return !await hasAeapIdentity(runtime.getSetting("agentAddress"));
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const tx = await aeapClient.createAgentIdentity({
      name: runtime.character.name,
      description: runtime.character.description,
    });
    await runtime.setSetting("agentVault", tx.vaultPda.toString());
    return { success: true, vaultPda: tx.vaultPda };
  },
  examples: []
};

// Provider: Agent Wallet State
export const agentStateProvider: Provider = {
  name: "AEAP_AGENT_STATE",
  description: "Provides agent's AEAP wallet state",
  get: async (runtime: IAgentRuntime, message: Memory, state) => {
    const vaultPda = new PublicKey(runtime.getSetting("agentVault"));
    const accountInfo = await connection.getAccountInfo(vaultPda);
    const aeapState = decodeAeapVault(accountInfo.data);
    
    return {
      text: `Agent vault: ${vaultPda.toString()}\nBalance: ${aeapState.balance} USDC\nActions used: ${aeapState.actionsCount}`
    };
  }
};

// Action: Transfer Tokens via AEAP Settlement
export const transferTokens: Action = {
  name: "TRANSFER_TOKENS_AEAP",
  description: "Transfer SPL tokens from agent vault",
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const vaultPda = new PublicKey(runtime.getSetting("agentVault"));
    const tx = await aeapClient.settleTransfer({
      fromVault: vaultPda,
      toAddress: new PublicKey(message.content.recipient),
      amount: BigInt(message.content.amount),
      token: USDC_MINT,
    });
    return { success: true, signature: tx };
  },
  examples: []
};
```

### Estimated Effort

**~16-20 hours** for an experienced TypeScript/Solana developer:

- 2h: Study ElizaOS plugin architecture & examples
- 2h: Study AEAP Settlement program interface
- 3h: Design plugin structure & interactions (actions, evaluators, providers)
- 4h: Implement core actions (identity creation, balance checks, transfers)
- 2h: Implement evaluators (resource monitoring)
- 2h: Implement providers (state injection into LLM context)
- 2h: Integration tests with ElizaOS runtime
- 1h: Documentation & README

**Note**: First plugin tends to be slower; second plugin would drop to ~8-10h.

---

## 3. Solana Agent Kit (by SendAI)

### Overview

**Solana Agent Kit** is an open-source toolkit that enables AI agents to interact with 60+ Solana protocols and perform token/NFT/DeFi operations. Built on a modular plugin architecture, it supports multiple AI frameworks (LangChain, Vercel AI SDK, Claude via MCP).

**Key Stats**: 60+ tools, v2 with modular plugins, embedded wallet support (Turnkey, Privy).

**Sources:** [GitHub: sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit), [Official Docs](https://docs.sendai.fun/), [Solana Guide](https://solana.com/developers/guides/getstarted/intro-to-ai), [CoinGecko Guide](https://www.coingecko.com/learn/build-ai-agent-using-solana-agent-kit)

### How It Works

Solana Agent Kit provides a suite of pre-built tools organized into modular plugins:

**Core Plugin Categories**:

1. **Token Plugin** (@solana-agent-kit/plugin-token)
   - Transfer assets, swap tokens, bridge assets, rug checks

2. **NFT Plugin** (@solana-agent-kit/plugin-nft)
   - Mint, list, manage Metaplex NFT metadata

3. **DeFi Plugin** (@solana-agent-kit/plugin-defi)
   - Stake, lend, borrow, trade (spot & perpetual)

4. **Misc Plugin** (@solana-agent-kit/plugin-misc)
   - Airdrops, price feeds, token info, domain registration

5. **Blinks Plugin** (@solana-agent-kit/plugin-blinks)
   - Interact with Solana Actions/blinks

**Advantages of Plugin Architecture**:
- Modular design reduces hallucinations (agents only see relevant tools)
- Performance optimization (lean agents with only needed capabilities)
- Easier testing & maintenance
- Simple plugin composition for custom needs

**Framework Integration**:
- **LangChain**: Via `createSolanaTools()` LangChain tool wrapper
- **Vercel AI SDK**: Via `createVercelAITools()` 
- **Claude**: Via MCP integration
- **Direct**: Raw `SolanaAgentKit` class for custom implementations

### Plugin Architecture

A plugin in Solana Agent Kit:

```typescript
interface SolanaAgentKitPlugin {
  name: string;
  description: string;
  tools: Tool[];              // Array of callable tools
}

interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;    // Tool parameter schema
  handler: (params) => Promise<ToolResult>;
}
```

**Tool Creation Pattern**:
1. Define tool interface (name, description, input schema)
2. Implement handler function that performs Solana operations
3. Return structured result (success/failure, data/error)
4. Register in plugin's `tools` array

### AEAP Integration Approach

**Goal**: Create a new AEAP plugin for Solana Agent Kit that exposes AEAP Settlement program operations as tools.

**Plugin Name**: `@solana-agent-kit/plugin-aeap`

**Integration Structure**:

```
@solana-agent-kit/plugin-aeap/
├── src/
│   ├── index.ts                 # Plugin export & registration
│   ├── tools/
│   │   ├── createIdentity.ts    # CREATE_AGENT_IDENTITY tool
│   │   ├── executeAction.ts     # EXECUTE_ACTION tool
│   │   ├── settlePayment.ts     # SETTLE_PAYMENT tool
│   │   └── getVaultState.ts     # GET_VAULT_STATE tool
│   ├── aeap-client.ts           # Client for AEAP Settlement program
│   └── types.ts
└── README.md
```

**Tool Definitions**:

```typescript
// Tool 1: Create Agent Identity
const createIdentityTool = {
  name: "create_aeap_identity",
  description: "Create a new AEAP agent identity & vault",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Agent name" },
      description: { type: "string", description: "Agent description" }
    },
    required: ["name"]
  }
};

// Tool 2: Execute Action (pay for service)
const executeActionTool = {
  name: "execute_aeap_action",
  description: "Execute payment action via AEAP Settlement",
  inputSchema: {
    type: "object",
    properties: {
      vaultPda: { type: "string", description: "Agent vault address" },
      actionType: { 
        type: "string", 
        enum: ["PAY_FOR_SERVICE", "TRANSFER", "SETTLE_BILL"],
        description: "Type of action to execute"
      },
      recipient: { type: "string", description: "Recipient address" },
      amount: { type: "string", description: "Amount in tokens" },
      metadata: { type: "object", description: "Action metadata" }
    },
    required: ["vaultPda", "actionType", "recipient", "amount"]
  }
};

// Tool 3: Get Vault State
const getVaultStateTool = {
  name: "get_aeap_vault_state",
  description: "Check AEAP vault balance & status",
  inputSchema: {
    type: "object",
    properties: {
      vaultPda: { type: "string", description: "Vault address to check" }
    },
    required: ["vaultPda"]
  }
};

// Tool 4: Settle Payment (x402 integration)
const settlePaymentTool = {
  name: "settle_x402_payment",
  description: "Settle x402 payment requirement via AEAP vault",
  inputSchema: {
    type: "object",
    properties: {
      vaultPda: { type: "string", description: "Agent vault" },
      paymentRequirements: { 
        type: "object", 
        description: "x402 PaymentRequirements object from server"
      },
      amount: { type: "string" },
      merchant: { type: "string", description: "Service provider address" }
    },
    required: ["vaultPda", "paymentRequirements", "amount"]
  }
};
```

**Integration Flow**:

```
LangChain/Vercel AI Agent
    ↓
Uses SolanaAgentKit + AEAP Plugin
    ↓
Calls "create_aeap_identity" tool
    ↓
AEAP Plugin → Solana Settlement Program
    ↓
Agent vault created & funded
    ↓
Agent calls "execute_aeap_action" or "settle_x402_payment"
    ↓
AEAP Plugin constructs & submits transaction
    ↓
Result returned to agent (success/error)
```

### Code Interface Sketch

```typescript
// Plugin implementation
export const aeapPlugin: SolanaAgentKitPlugin = {
  name: "AEAP Agent Identity & Payments",
  description: "Tools for AEAP agent identity, wallets, and payments",
  tools: [createIdentityTool, executeActionTool, getVaultStateTool, settlePaymentTool]
};

// Tool handler implementation
async function handleCreateIdentity(params: {
  name: string;
  description?: string;
}): Promise<ToolResult> {
  const tx = await aeapClient.createAgentIdentity({
    name: params.name,
    description: params.description || ""
  });
  
  return {
    success: true,
    data: {
      vaultPda: tx.vaultPda.toString(),
      signature: tx.signature,
      message: `Created AEAP identity ${params.name}`
    }
  };
}

// Usage in agent
const tools = createVercelAITools(agent, [
  "@solana-agent-kit/plugin-token",
  "@solana-agent-kit/plugin-defi",
  "@solana-agent-kit/plugin-aeap"  // Add AEAP plugin
]);

// Agent can now call:
// - "create_aeap_identity"
// - "execute_aeap_action"  
// - "settle_x402_payment"
// - All existing Solana Agent Kit tools
```

### Estimated Effort

**~10-14 hours** for an experienced TypeScript/Solana developer:

- 1h: Study Solana Agent Kit plugin architecture & existing plugins
- 1h: Study AEAP Settlement program interface
- 2h: Design plugin structure & tool definitions
- 3h: Implement tool handlers (identity, execute, settle, state)
- 2h: Build AEAP client wrapper for Settlement program
- 2h: Integration tests with LangChain/Vercel AI SDK
- 1h: Documentation & README
- 1h: Buffer for debugging

**Note**: Simpler than ElizaOS because Solana Agent Kit has fewer moving parts (no evaluators, providers, services). Plugin can be published to npm for ecosystem adoption.

---

## Summary & Recommendation

| Target | Complexity | Timeline | Integration Type | Best For |
|--------|-----------|----------|------------------|----------|
| **x402** | Medium | 12-16h | Settlement Program + SDK | HTTP payment flows; merchant monetization |
| **ElizaOS** | High | 16-20h | Plugin with Actions/Providers/Evaluators | Agent autonomy; natural language interaction |
| **Solana Agent Kit** | Low | 10-14h | Plugin with Tools | Framework interoperability; LLM agents |

### Recommended Implementation Order

1. **Solana Agent Kit plugin first** (10-14h): Quickest win, establishes core Settlement program interface
2. **x402 integration next** (12-16h): Builds on Settlement program, enables new payment use cases
3. **ElizaOS plugin last** (16-20h): Most complex, leverages patterns from first two, enables full agent autonomy

This sequence allows for incremental testing and reuses implementation work across integrations.

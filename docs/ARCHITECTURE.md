# Agenomics Protocol - Architecture

## 1. Protocol Overview

The Agenomics Protocol enables AI agents to operate as independent economic entities on Solana. By providing on-chain identity, programmable wallets, discovery mechanisms, and autonomous payment settlement, AEP creates a trustless economic layer where agents can discover each other, negotiate tasks, and settle payments without human intermediation.

### Core Vision

AEP transforms AI agents from stateless, one-shot interactions into persistent economic actors with:
- **On-chain identity**: Verifiable agent profiles and reputation
- **Autonomous wallets**: SPL token accounts with configurable spending policies
- **Discovery layer**: Registry for agents to find each other by capability and reputation
- **Trustless settlement**: Escrow-based task completion and payment finality

### Three Core Programs

1. **Agent Vault Program**: Manages on-chain wallets for AI agents with configurable spending policies, rate limits, and audit trails
2. **Agent Registry Program**: Maintains discoverable agent profiles with reputation scores, categories, and accepted tokens
3. **Settlement Protocol Program**: Handles task creation, escrow management, milestone-based releases, and dispute resolution

### Bridge: MCP Server

A single **Model Context Protocol (MCP) server** acts as the bridge between any AI agent framework and the on-chain programs:
- Converts agent framework commands into Solana transactions
- Standardizes wallet operations across ElizaOS, Solana Agent Kit, Goat, and custom frameworks
- Provides high-level abstractions (create_task, accept_task, complete_milestone) over low-level Solana calls
- Handles keypair management and transaction signing

### Ecosystem Integrations

- **ElizaOS**: Run fully autonomous agents with on-chain commerce capabilities
- **Solana Agent Kit**: Use AEP as a plugin for agentic wallets
- **Goat Framework**: Integrate with DeFi agent workflows
- **x402 Payment Relay**: Enable HTTP-based agent payments (402 Payment Required responses)

---

## 2. System Architecture Diagram

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Claude (API) │  │ ChatGPT      │  │ ElizaOS      │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│         │                 │                  │                   │
└─────────┼─────────────────┼──────────────────┼───────────────────┘
          │                 │                  │
          └─────────────────┴──────────────────┘
                     │
          ┌──────────▼────────────┐
          │    MCP Server         │
          │  ─────────────────    │
          │  • wallet_balance     │
          │  • transfer_tokens    │
          │  • create_task        │
          │  • accept_task        │
          │  • complete_milestone │
          │  • query_agents       │
          └──────────┬────────────┘
                     │
          ┌──────────▼──────────────────────────────┐
          │     Solana Blockchain                   │
          │                                         │
          │  ┌───────────────────────────────────┐ │
          │  │   Agent Vault Program             │ │
          │  │  • Vault account (PDA)            │ │
          │  │  • Spending policies              │ │
          │  │  • Rate limits & allowlists       │ │
          │  │  • Audit log events               │ │
          │  └───────────────────────────────────┘ │
          │                                         │
          │  ┌───────────────────────────────────┐ │
          │  │   Agent Registry Program          │ │
          │  │  • AgentProfile (PDA)             │ │
          │  │  • Discovery indexing             │ │
          │  │  • Reputation scoring             │ │
          │  │  • Category filtering              │ │
          │  └───────────────────────────────────┘ │
          │                                         │
          │  ┌───────────────────────────────────┐ │
          │  │   Settlement Protocol Program     │ │
          │  │  • TaskEscrow (PDA)               │ │
          │  │  • Milestone tracking             │ │
          │  │  • Fund release logic             │ │
          │  │  • Dispute handling               │ │
          │  └───────────────────────────────────┘ │
          │                                         │
          └─────────────────────────────────────────┘
                     │
          ┌──────────▼────────────┐
          │   x402 HTTP Relay     │
          │  (Optional)           │
          │  • 402 responses      │
          │  • Payment receipts   │
          │  • Access grants      │
          └───────────────────────┘
```

### Agent-to-Agent Payment Flow

```
Agent A Vault                 Settlement Escrow              Agent B Vault
     │                               │                            │
     │  ┌─────────────────────────────────────────────────────┐   │
     │  │ Task Created: Agent A locks funds in escrow         │   │
     │  └─────────────────────────────────────────────────────┘   │
     │                               │                            │
     │                        ┌──────▼──────┐                     │
     │                        │  ESCROWED   │                     │
     │                        │  USDC: 100  │                     │
     │                        └──────┬──────┘                     │
     │                               │                            │
     │                               │  ┌──────────────────────┐  │
     │                               │  │ Agent B Accepts Task │  │
     │                               │  └──────────────────────┘  │
     │                               │                            │
     │                               │  ┌──────────────────────┐  │
     │                               │  │  Agent B Completes   │  │
     │                               │  │  Milestone 1 (50%)   │  │
     │                               │  └──────────────────────┘  │
     │                               │                            │
     │                        ┌──────▼──────┐                     │
     │                        │  ESCROWED   │                     │
     │                        │  USDC: 50   │                     │
     │                        └──────┬──────┘                     │
     │                               │                            │
     │                      ┌────────▼────────┐                   │
     │                      │  Release 50 SOL │                   │
     │                      └────────┬────────┘                   │
     │                               │                            ◄────── Agent B
     │                               │  ┌──────────────────────┐  │       Receives
     │                               │  │ Agent B Completes    │  │       Payment
     │                               │  │ Milestone 2 (50%)    │  │
     │                               │  └──────────────────────┘  │
     │                        ┌──────▼──────┐                     │
     │                        │  ESCROWED   │                     │
     │                        │  USDC: 0    │                     │
     │                        └──────┬──────┘                     │
     │                               │                            │
     │                      ┌────────▼────────┐                   │
     │                      │  Release 50 SOL │                   │
     │                      └────────────────┘                    │
     │                               │                            ◄────── Agent B
     │                               │                            │       Receives
     │                               │                            │       Payment
```

### Registry Discovery

```
Agent Registry
    │
    ├─ Agent Profile A (PDA: ["agent_registry", authority_A])
    │   ├─ name: "DataAnalyst_001"
    │   ├─ categories: ["data-analysis", "python-programming"]
    │   ├─ reputation_score: 95
    │   ├─ tasks_completed: 247
    │   ├─ accepted_tokens: [USDC, USDT]
    │   └─ total_earnings: 5420.50 USDC
    │
    ├─ Agent Profile B (PDA: ["agent_registry", authority_B])
    │   ├─ name: "ContentCreator_002"
    │   ├─ categories: ["content-writing", "marketing"]
    │   ├─ reputation_score: 87
    │   ├─ tasks_completed: 156
    │   ├─ accepted_tokens: [USDC]
    │   └─ total_earnings: 3200.25 USDC
    │
    └─ [More profiles indexed by category, reputation, etc.]
```

---

## 3. Account Design

### Agent Vault Program Accounts

#### Vault Account (Program-Derived Account)

**Seed**: `["vault", authority]`

**Fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `authority` | Pubkey | Owner of this vault (the agent's keypair) |
| `agent_keypair` | Bytes(32) | Serialized agent keypair for transaction signing |
| `daily_limit` | u64 | Max tokens agent can spend per day (lamports/tokens) |
| `per_tx_limit` | u64 | Max tokens per single transaction |
| `allowed_tokens` | Vec<Pubkey> | SPL mint addresses allowed for transfer |
| `allowed_programs` | Vec<Pubkey> | Program IDs this vault can call |
| `daily_spent` | u64 | Tokens spent today (resets at `last_reset`) |
| `last_reset` | i64 | Unix timestamp of last daily limit reset |
| `paused` | bool | Admin pause flag for emergency shutdown |
| `audit_count` | u64 | Number of audit entries created |
| `bump` | u8 | PDA bump seed |

**Size**: ~500 bytes

#### AuditEntry Accounts

**Seed**: `["audit_entry", vault, audit_index]`

**Fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `vault` | Pubkey | Parent vault this entry belongs to |
| `action_type` | u8 | 0=transfer, 1=program_call, 2=config_update |
| `amount` | u64 | Amount involved (if applicable) |
| `token` | Pubkey | SPL mint used |
| `target` | Pubkey | Destination (agent, program, or config setting) |
| `timestamp` | i64 | Unix timestamp |
| `slot` | u64 | Solana slot number |
| `tx_signature` | Bytes(64) | Transaction signature for full verification |
| `bump` | u8 | PDA bump seed |

**Size**: ~200 bytes per entry

---

### Agent Registry Program Accounts

#### AgentProfile Account (Program-Derived Account)

**Seed**: `["agent_profile", authority]`

**Fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `authority` | Pubkey | Agent owner/keypair authority |
| `vault` | Pubkey | Reference to Agent Vault program PDA |
| `name` | String(64) | Display name (e.g., "DataAnalyst_001") |
| `description` | String(256) | Agent capabilities and bio |
| `categories` | Vec<String>(10, each 32 bytes) | Tags for discovery (e.g., ["data-analysis"]) |
| `pricing_model` | u8 | 0=flat_rate, 1=hourly, 2=milestone_based |
| `accepted_tokens` | Vec<Pubkey> | SPL mints agent accepts as payment |
| `status` | u8 | 0=active, 1=inactive, 2=suspended |
| `reputation_score` | u16 | 0-1000 score (tasks_completed / total_tasks * quality_rating) |
| `tasks_completed` | u64 | Total completed tasks |
| `tasks_disputed` | u64 | Total disputed tasks |
| `total_earnings` | u128 | Cumulative earnings in lamports |
| `created_at` | i64 | Registration timestamp |
| `updated_at` | i64 | Last profile update timestamp |
| `bump` | u8 | PDA bump seed |

**Size**: ~800 bytes

---

### Settlement Protocol Program Accounts

#### TaskEscrow Account (Program-Derived Account)

**Seed**: `["task_escrow", client_agent, task_id]`

**Fields**:
| Field | Type | Purpose |
|-------|------|---------|
| `client_agent` | Pubkey | Agent requesting work (task creator) |
| `provider_agent` | Pubkey | Agent accepting/completing work |
| `token_mint` | Pubkey | SPL token used for payment |
| `amount` | u64 | Total task payment (in token units) |
| `milestones` | Vec<Milestone> | Array of completion milestones |
| `status` | u8 | 0=created, 1=accepted, 2=in_progress, 3=completed, 4=disputed |
| `created_at` | i64 | Task creation timestamp |
| `deadline` | i64 | Unix timestamp for task completion deadline |
| `dispute_resolver` | Option<Pubkey> | Arbiter if dispute occurs (e.g., oracle, DAO) |
| `bump` | u8 | PDA bump seed |

**Milestone Structure**:
```
struct Milestone {
    id: u64,
    description: String(128),
    required_completion: bool,
    percentage: u16,  // 0-100, sum should = 100
    completed_at: Option<i64>,
    evidence_hash: Option<[u8; 32]>,  // IPFS hash or content hash
}
```

**Size**: ~1200 bytes

---

## 4. Instruction Flow Diagrams

### Flow 1: Agent Registration

```
┌─────────────────────────────────────────────┐
│  AI Agent wants to operate on-chain         │
└────────────────────┬────────────────────────┘
                     │
        ┌────────────▼────────────┐
        │  Create Agent Vault PDA │
        │  - Set authority        │
        │  - Set limits & rules   │
        │  - Fund with SOL        │
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────────────┐
        │  Vault Program Instruction:     │
        │  initialize_vault               │
        │  - authority: agent key         │
        │  - daily_limit: 100 USDC        │
        │  - per_tx_limit: 10 USDC        │
        │  - allowed_tokens: [USDC]       │
        │  - allowed_programs: [...]      │
        └────────────┬────────────────────┘
                     │
        ┌────────────▼───────────────────┐
        │ Register in Agent Registry      │
        │ - Create AgentProfile PDA       │
        │ - Link to vault                 │
        │ - Set name, categories, etc     │
        └────────────┬───────────────────┘
                     │
        ┌────────────▼───────────────────┐
        │  Registry Program Instruction:  │
        │  create_agent_profile           │
        │  - authority: agent key         │
        │  - vault: vault PDA address     │
        │  - name: "DataAnalyst_001"      │
        │  - categories: ["data-analysis"]│
        │  - pricing_model: 2 (milestone) │
        │  - accepted_tokens: [USDC]      │
        └────────────┬───────────────────┘
                     │
        ┌────────────▼───────────────────┐
        │  Fund Vault with USDC           │
        │  - Transfer USDC to vault ATA   │
        │  - Ready for autonomous ops     │
        └────────────┬───────────────────┘
                     │
        ┌────────────▼───────────────────┐
        │  Agent Ready!                   │
        │  ✓ On-chain identity            │
        │  ✓ Autonomous wallet            │
        │  ✓ Discoverable profile         │
        │  ✓ Active reputation score      │
        └───────────────────────────────┘
```

### Flow 2: Agent Discovery

```
┌────────────────────────────────┐
│  Agent B needs to find help    │
│  Looking for: data analyst     │
└────────────────┬───────────────┘
                 │
     ┌───────────▼──────────────┐
     │  Query Registry by Tag   │
     │  category == "data-*"    │
     │  status == "active"      │
     │  reputation > 80         │
     └───────────┬──────────────┘
                 │
     ┌───────────▼──────────────────────┐
     │ Retrieve Matching Profiles       │
     │                                  │
     │ ┌────────────────────────────┐  │
     │ │ Agent A (DataAnalyst_001)  │  │
     │ │ Reputation: 95             │  │
     │ │ Tasks: 247                 │  │
     │ │ Earnings: 5420.50 USDC     │  │
     │ │ Categories: [data-...]     │  │
     │ │ Accepted: [USDC, USDT]     │  │
     │ └────────────────────────────┘  │
     │                                  │
     │ ┌────────────────────────────┐  │
     │ │ Agent C (DataAnalyst_002)  │  │
     │ │ Reputation: 88             │  │
     │ │ Tasks: 156                 │  │
     │ │ Earnings: 3200.25 USDC     │  │
     │ │ Categories: [data-...]     │  │
     │ │ Accepted: [USDC]           │  │
     │ └────────────────────────────┘  │
     │                                  │
     └───────────┬──────────────────────┘
                 │
     ┌───────────▼────────────────┐
     │  Agent B Selects Agent A   │
     │  (highest reputation)      │
     └────────────────────────────┘
```

### Flow 3: Task Settlement (Escrow-Based)

```
┌─────────────────────────────────────────┐
│  Agent A wants to hire Agent B          │
│  Task: "Analyze 5GB dataset"            │
│  Payment: 100 USDC                      │
│  Milestones: 50% (analysis), 50% (report)
└──────────────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────┐
       │ Agent A: Create Task     │
       │ Settlement Instr:        │
       │ create_task_escrow       │
       │ - client: A              │
       │ - provider: B            │
       │ - amount: 100 USDC       │
       │ - token_mint: USDC       │
       │ - milestones: [...]      │
       │ - deadline: +7 days      │
       └───────────┬──────────────┘
                   │
       ┌───────────▼──────────────────────┐
       │  Settlement Program:             │
       │  1. Create TaskEscrow PDA        │
       │  2. Transfer 100 USDC to escrow  │
       │     (from A's vault ATA)         │
       │  3. Set status = "created"       │
       └───────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────┐
       │  Escrow holds 100 USDC   │
       │  Status: CREATED         │
       └───────────┬──────────────┘
                   │
       ┌───────────▼────────────────────┐
       │  Agent B: Accept Task          │
       │  Settlement Instr:             │
       │  accept_task                   │
       │  - task_escrow: [PDA]          │
       └───────────┬────────────────────┘
                   │
       ┌───────────▼──────────────────────┐
       │  Settlement Program:             │
       │  1. Update status = "accepted"   │
       │  2. Emit AcceptedTask event      │
       └───────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────┐
       │  Agent B: Start work     │
       │  (off-chain computation) │
       └───────────┬──────────────┘
                   │
       ┌───────────▼─────────────────────┐
       │  Agent B: Complete Milestone 1  │
       │  Settlement Instr:              │
       │  complete_milestone             │
       │  - task_escrow: [PDA]           │
       │  - milestone_id: 0              │
       │  - evidence_hash: QmX...        │
       └───────────┬─────────────────────┘
                   │
       ┌───────────▼──────────────────────┐
       │  Settlement Program:             │
       │  1. Verify milestone completion  │
       │  2. Release 50 USDC to B's vault │
       │  3. Mark milestone complete      │
       │  4. Emit MilestoneCompleted      │
       └───────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────────────┐
       │  Agent B: Complete Milestone 2   │
       │  Settlement Instr:               │
       │  complete_milestone              │
       │  - task_escrow: [PDA]            │
       │  - milestone_id: 1               │
       │  - evidence_hash: QmY...         │
       └───────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────────────┐
       │  Settlement Program:             │
       │  1. Release remaining 50 USDC    │
       │  2. Mark task status = "complete"│
       │  3. Update reputation scores     │
       │  4. Emit TaskCompleted event     │
       └───────────┬──────────────────────┘
                   │
       ┌───────────▼──────────────┐
       │  Agent B Receives:       │
       │  ✓ 50 USDC (milestone 1) │
       │  ✓ 50 USDC (milestone 2) │
       │  ✓ +1 to tasks_completed │
       │  ✓ Reputation increase   │
       └──────────────────────────┘
```

### Flow 4: x402 HTTP Payment

```
┌────────────────────────────────────────┐
│  Client requests protected resource    │
│  GET https://data-api.example.com/data │
└────────────────┬─────────────────────┘
                 │
     ┌───────────▼──────────────────┐
     │  HTTP 402 Payment Required   │
     │  X-Payment-Endpoint: (relay) │
     │  X-Price: 0.5 USDC           │
     │  X-Payment-Proof: <format>   │
     └───────────┬──────────────────┘
                 │
     ┌───────────▼────────────────────┐
     │  Agent parses 402 response     │
     │  Extracts payment requirements │
     │  - Amount: 0.5 USDC            │
     │  - Endpoint: x402-relay.sol    │
     │  - Proof format: tx_sig        │
     └───────────┬────────────────────┘
                 │
     ┌───────────▼────────────────────────┐
     │  Agent Vault: transfer to relay    │
     │  Vault Instr:                      │
     │  transfer_tokens                   │
     │  - to: x402-relay PDA              │
     │  - amount: 0.5 USDC                │
     │  - context: request_id             │
     └───────────┬────────────────────────┘
                 │
     ┌───────────▼────────────────────┐
     │  Receipt generated:            │
     │  ✓ TX signature                │
     │  ✓ Payment proof (on-chain)     │
     │  ✓ Access token                │
     │  ✓ Expiry (e.g., 1 hour)       │
     └───────────┬────────────────────┘
                 │
     ┌───────────▼────────────────────┐
     │  x402 Relay verifies payment   │
     │  - Check vault exists          │
     │  - Verify transfer executed    │
     │  - Generate time-bound token   │
     └───────────┬────────────────────┘
                 │
     ┌───────────▼──────────────────┐
     │  Client includes token:      │
     │  GET /data                   │
     │  Authorization: Bearer <tok> │
     └───────────┬──────────────────┘
                 │
     ┌───────────▼──────────────────┐
     │  ✓ Access Granted            │
     │  ✓ Data returned             │
     └──────────────────────────────┘
```

---

## 5. Security Model

### Vault Policy Enforcement

The **Agent Vault** enforces multiple layers of spending control:

1. **Daily Spending Limits**: Hard cap on total tokens spent per 24-hour period
   - Prevents runaway spending from bugs or exploits
   - Configurable per-agent based on use case
   - Resets automatically at UTC midnight

2. **Per-Transaction Limits**: Maximum amount in any single transaction
   - Prevents large unauthorized transfers
   - Example: Agent can spend 100 USDC/day but max 10 USDC per transaction
   - Stops accidental double-spends

3. **Allowlist Enforcement**: Only specific tokens and programs can be used
   - Vault explicitly lists approved SPL mints
   - Vault explicitly lists approved Solana programs it can call
   - Rejects any instruction not matching allowlist
   - Example: Agent only accepts USDC and USDT, only calls Marinade and Jupiter

4. **Atomic Audit Trail**: Every action logged to blockchain
   - Each transfer/call creates AuditEntry PDA
   - Immutable record: timestamp, slot, signature, amount, target
   - Enables forensic analysis of spending patterns
   - Can be queried off-chain for compliance

### Human Override Mechanism

Even fully autonomous agents need human oversight:

1. **Pause Authority**: Agent owner can pause vault immediately
   - Instruction: `pause_vault` signed by authority
   - Blocks all outgoing transfers and program calls
   - Useful for emergencies or investigation
   - Can be resumed by owner

2. **Config Updates**: Authority can update spending policies
   - Adjust daily_limit, per_tx_limit
   - Add/remove tokens or programs
   - Changes take effect immediately
   - Updates emit ConfigChanged event for indexing

3. **Emergency Shutdown**: Complete account closure
   - Drain remaining tokens to owner
   - Mark vault as inactive
   - Irreversible (new vault must be created)
   - Prevents future autonomous spending

### Escrow Safety

The **Settlement Protocol** protects both agents from fraud:

1. **Atomic Locking**: Funds locked from moment task created
   - Client transfers full amount to TaskEscrow PDA
   - Funds cannot be reclaimed until task resolved
   - Provider cannot access funds until milestone completed
   - Prevents either party from disappearing with funds

2. **Milestone-Based Release**: Funds released in tranches
   - No lump-sum payments (reduces risk)
   - Each milestone completion verified before release
   - Evidence hashes stored on-chain (can reference IPFS)
   - Provider incentivized to complete early stages

3. **Dispute Resolution**: Third-party arbitration
   - Optional dispute_resolver field (oracle, DAO, court)
   - If neither party agrees task completed, dispute opened
   - Resolver examines evidence and determines payout
   - Can award partial funds or full refund
   - Prevents deadlock between disagreeing agents

4. **Deadline Enforcement**: Time limits prevent indefinite holds
   - Deadline timestamp checked on completion
   - Late completions can be rejected (provider loses claim)
   - Motivates timely work
   - Provides exit path if provider goes offline

### Reputation Staking (Future Enhancement)

Future versions may implement **collateral-based reputation**:

1. **Stake Requirement**: Agents post SOL collateral to open vault
   - Amount based on daily_limit (e.g., 1 SOL per 100 USDC limit)
   - Held in separate staking account
   - Cannot be withdrawn while vault is active

2. **Slashing on Disputes**: Lost tasks reduce reputation exponentially
   - First disputes: reputation hit
   - Repeated failures: collateral partially slashed
   - Extreme violations: account frozen
   - Incentivizes honest behavior and quality work

3. **Reputation Bonding**: Agents can "stake" reputation
   - Higher reputation = more trust for higher-value tasks
   - Task value multiplier based on reputation score
   - New agents start with 0 reputation, must build gradually
   - Prevents sybil attacks (cheap to create fake agents)

---

## 6. Design Decisions

### Why PDAs for All Accounts?

**Program-Derived Accounts (PDAs)** are the architectural backbone of AEP:

**Deterministic Addressing**
- Vault address is always `["vault", authority]` — no random address generation
- Client can compute vault address offline without RPC call
- MCP server can sign transactions without live on-chain data
- Agents can coordinate without needing to share addresses

**Composability**
- Other programs can invoke AEP instructions without storing addresses
- Nested PDAs (`["audit_entry", vault, index]`) enable hierarchical account structures
- Settlement program references vault by seed, not address
- Reduces account dependency issues and improves modularity

**Authority-Scoped Namespacing**
- Each agent gets unique vault because seed includes `authority`
- No naming conflicts or collisions
- Registry can derive expected profile address from authority
- Eliminates need for separate account registry

### Why Events for Indexing (Not Accounts)?

AEP emits **Solana events** (e.g., using Anchor emit macros) rather than creating accounts for audit/discovery:

**Cost Efficiency**
- AuditEntry accounts cost rent (5000 lamports base + data size)
- Events cost only gas (negligible)
- Hundreds of transactions would create thousands of accounts
- Running cost: ~1 SOL/year per thousand transactions vs. zero with events

**Scalability**
- Account-based audit: `2^16` entries per vault → rent explosion
- Event-based audit: unlimited entries, indexed by off-chain RPC listeners
- Program doesn't need to store every transaction
- Historical queries handled by indexer (Metaplex Digital Asset, Helius, custom)

**Off-Chain Indexing**
- Events streamed to Postgres, Elasticsearch, etc.
- Rich queries: "all tasks completed by Agent X in April"
- Events filterable by program discriminator
- Off-chain indexer owns query performance, not on-chain storage

**Compliance & Auditing**
- Immutable event logs on Solana ledger
- No risk of account modification
- Full history available via RPC node
- Third-party auditors can reconstruct all actions

### Why MCP as the Agent Interface?

The **Model Context Protocol** is the bridge between AI and blockchain:

**Protocol Agnostic**
- Works with Claude, ChatGPT, Llama, Grok, etc.
- No vendor lock-in to OpenAI or Anthropic
- Any LLM framework can implement MCP
- Future models supported automatically

**Standardized Tool Interface**
- Agents call tools like any other MCP server (GitHub, Slack, Postgres, etc.)
- Familiar abstraction for agent developers
- High-level operations (create_task) hide low-level Solana details
- Reduces cognitive load on LLM decision-making

**State Management**
- MCP server handles keypair management (private key never leaves)
- Server manages transaction staging, signing, confirmation
- Agents see high-level responses ("task created"), not raw tx data
- Natural language descriptions of actions

**Extensibility**
- MCP servers are composable (chain multiple servers)
- AEP + Marinade + Jupiter in one agent context
- Easy to add new capabilities (DeFi, NFTs, DAOs)
- Standard tool discovery mechanism

**Example MCP Tool**:
```json
{
  "name": "create_task",
  "description": "Create a task for another agent to complete",
  "inputSchema": {
    "type": "object",
    "properties": {
      "agent_address": { "type": "string", "description": "Solana address of provider agent" },
      "description": { "type": "string", "description": "Task description" },
      "amount_usdc": { "type": "number", "description": "Payment in USDC" },
      "milestones": { "type": "array", "description": "Completion milestones (percentages)" },
      "deadline_days": { "type": "number", "description": "Days until deadline" }
    }
  }
}
```

### Why Stablecoins (USDC) as Default Settlement?

AEP settles tasks in **USDC** (or other SPL stablecoins) by design:

**Economic Certainty**
- SOL is volatile (100 USDC ≠ constant SOL amount)
- Agents care about purchasing power, not token quantity
- USDC maintains ~$1 purchasing power
- Makes task pricing predictable and fair

**Enterprise Compatibility**
- Accounting teams understand stablecoin value (= currency)
- SOL volatility creates accounting nightmares (daily revaluation)
- Tax treatment clearer for stablecoins
- Enterprise adoption easier with stablecoins

**Payment Flexibility**
- Agent can request USDC, USDT, USDP (allowed_tokens list)
- Escrow mints can differ from vault holdings
- Provider can swap USDC for SOL via Jupiter in settlement callback
- Clients can pay in SOL and have relay convert to USDC

**Arbitrage Safety**
- If SOL crashes, vault value doesn't evaporate
- Reputation collateral stays stable
- Task payments don't become "too small" due to volatility
- Prevents cascading failures during market downturns

---

## 7. Future Roadmap

1. **Reputation Staking**: Collateral-backed agent credibility
2. **Dispute Arbitration**: DAO-based or oracle-based resolution
3. **Multi-Token Settlement**: Wrapped tokens, bridged assets
4. **Agent Sharding**: Horizontal scaling via Saga/Firedancer
5. **Privacy Extensions**: Zero-knowledge proofs for sensitive tasks
6. **Interchain Bridges**: Move agent identities to other blockchains

---

## References

- [Solana Program Library (SPL)](https://spl.solana.com/)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [ElizaOS Documentation](https://github.com/ai16z/eliza)
- [Solana Agent Kit](https://github.com/solana-labs/solana-agent-kit)

# API Reference

All 28 MCP tools exposed by the AEP MCP server. Each tool maps directly to a Solana program instruction (or, for Surface 2 tools, to an off-chain payment relay).

## Vault Tools (9)

### create_vault

Create a new agent vault with spending policies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentIdentity` | string | Yes | Agent public key |
| `dailyLimitSol` | number | Yes | Maximum SOL per day |
| `perTxLimitSol` | number | Yes | Maximum SOL per transaction |
| `maxTxsPerHour` | number | Yes | Maximum transactions per hour |

**Example response:**
```json
{
  "vaultAddress": "5xYz...",
  "signature": "3kLm...",
  "message": "Vault created with daily limit 10 SOL"
}
```

### get_vault_info

Get vault balance, policies, and status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vaultAddress` | string | No | Vault public key (uses default if omitted) |

**Example response:**
```json
{
  "address": "5xYz...",
  "balanceSol": 4.5,
  "dailyLimit": 10,
  "perTxLimit": 1,
  "maxTxsPerHour": 20,
  "isPaused": false,
  "todaySpent": 1.2
}
```

### vault_transfer

Transfer SOL from vault to recipient within policy limits.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `recipientAddress` | string | Yes | Recipient public key |
| `amountSol` | number | Yes | Amount in SOL |

**Example response:**
```json
{
  "signature": "4nBq...",
  "amountSol": 0.5,
  "recipient": "7aRt..."
}
```

### update_vault_policy

Update vault spending policies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dailyLimitSol` | number | Yes | New daily limit |
| `perTxLimitSol` | number | Yes | New per-transaction limit |
| `maxTxsPerHour` | number | Yes | New rate limit |

**Example response:**
```json
{
  "signature": "2mKp...",
  "message": "Policy updated"
}
```

### rotate_agent_identity

Rotate the vault's `agent_identity` hot key (ADR-069 / AUD-015). `agent_identity` is the off-chain agent runtime's signing key, distinct from the human-custodied `authority`; rotate it on suspected compromise of the agent runtime or on a routine cadence (suggested: 90 days). Rotation is a pure key-swap — balances, policies, daily-spend counters, and rate-limit counters are preserved. Only the vault `authority` (verified via `has_one` on the on-chain context) can rotate.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `newAgentIdentity` | string | Yes | Base58-encoded Solana public key of the new agent_identity hot key |

**Example response:**
```json
{
  "success": true,
  "vaultAddress": "5xYz...",
  "authority": "Au7h...",
  "oldAgentIdentity": "OldId...",
  "newAgentIdentity": "NewId...",
  "transactionSignature": "9pQr..."
}
```

### pause_vault

Pause vault, blocking all transfers.

No parameters required.

**Example response:**
```json
{
  "signature": "6qWe...",
  "message": "Vault paused"
}
```

### resume_vault

Resume a paused vault.

No parameters required.

**Example response:**
```json
{
  "signature": "8rTy...",
  "message": "Vault resumed"
}
```

### manage_allowlist

Add or remove tokens or programs from vault allowlist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `add_token`, `remove_token`, `add_program`, `remove_program` |
| `address` | string | Yes | Token mint or program public key |

**Example response:**
```json
{
  "signature": "9uIo...",
  "action": "add_token",
  "address": "EPjF..."
}
```

## Registry Tools (4)

### register_agent

Register an agent in the on-chain registry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Agent name |
| `description` | string | Yes | Agent description |
| `category` | string | Yes | Primary category |
| `capabilities` | string[] | Yes | Capability tags |
| `pricingModel` | string | Yes | `perTask`, `perHour`, or `perToken` |
| `pricingAmountSol` | number | Yes | Price in SOL |
| `acceptedTokens` | string[] | Yes | Accepted token mints |
| `vaultAddress` | string | Yes | Associated vault address |

**Example response:**
```json
{
  "agentProfileAddress": "3cDe...",
  "signature": "7hJk...",
  "message": "Agent registered"
}
```

### get_agent_profile

Get agent profile and reputation data.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentAddress` | string | No | Agent authority public key |

**Example response:**
```json
{
  "name": "DataBot",
  "description": "Data analysis agent",
  "category": "analytics",
  "capabilities": ["data-cleaning", "visualization"],
  "reputation": 85,
  "tasksCompleted": 42,
  "totalEarnings": 12.5,
  "status": "Active"
}
```

### update_agent_profile

Update agent profile fields.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | New name |
| `description` | string | No | New description |
| `category` | string | No | New category |
| `capabilities` | string[] | No | New capabilities |
| `pricingModel` | string | No | New pricing model |
| `pricingAmountSol` | number | No | New price |

**Example response:**
```json
{
  "signature": "5fGh...",
  "message": "Profile updated"
}
```

### discover_agents

Search registry for agents by capability or reputation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `capability` | string | No | Filter by capability |
| `category` | string | No | Filter by category |
| `minReputation` | number | No | Minimum reputation score |
| `limit` | number | No | Max results (default 10) |

**Example response:**
```json
{
  "agents": [
    {
      "address": "3cDe...",
      "name": "DataBot",
      "category": "analytics",
      "reputation": 85,
      "pricingModel": "perTask",
      "pricingAmountSol": 0.01
    }
  ],
  "total": 1
}
```

## Settlement Tools (10)

### create_escrow

Create a task escrow with milestones.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `providerAddress` | string | Yes | Provider agent public key |
| `providerVaultAddress` | string | Yes | Provider vault |
| `tokenMintAddress` | string | Yes | Payment token mint |
| `taskId` | number | Yes | Unique task ID |
| `totalAmountTokens` | number | Yes | Total payment in base units |
| `taskDescription` | string | Yes | Task description |
| `deadlineUnix` | number | Yes | Deadline Unix timestamp |

**Example response:**
```json
{
  "escrowAddress": "9pQr...",
  "signature": "1aSd...",
  "message": "Escrow created with 1000000 tokens locked"
}
```

### accept_task

Accept a task as provider.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |

**Example response:**
```json
{
  "signature": "2bFg...",
  "message": "Task accepted"
}
```

### submit_milestone

Submit a milestone for review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |
| `milestoneIndex` | number | Yes | Milestone index (0-based) |

**Example response:**
```json
{
  "signature": "3cHj...",
  "message": "Milestone 0 submitted"
}
```

### approve_milestone

Approve a milestone and release payment.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |
| `milestoneIndex` | number | Yes | Milestone index |
| `providerTokenAccount` | string | Yes | Provider token account |

**Example response:**
```json
{
  "signature": "4dKl...",
  "amountReleased": 500000,
  "message": "Milestone 0 approved, payment released"
}
```

### reject_milestone

Reject a submitted milestone, sending it back for rework.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |
| `milestoneIndex` | number | Yes | Milestone index |

**Example response:**
```json
{
  "signature": "5eMn...",
  "message": "Milestone 0 rejected"
}
```

### get_escrow_status

Get escrow status and milestone details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |

**Example response:**
```json
{
  "status": "Active",
  "client": "7gPq...",
  "provider": "8hRs...",
  "totalAmount": 1000000,
  "milestones": [
    { "index": 0, "status": "Approved", "amount": 500000 },
    { "index": 1, "status": "Pending", "amount": 500000 }
  ],
  "deadline": 1750000000
}
```

### cancel_escrow

Cancel escrow and refund client (only before provider accepts).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |

**Example response:**
```json
{
  "signature": "6fOp...",
  "message": "Escrow cancelled, funds refunded"
}
```

### raise_dispute

Raise a dispute on an active escrow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |

**Example response:**
```json
{
  "signature": "7gQr...",
  "message": "Dispute raised"
}
```

### resolve_dispute

Resolve dispute by splitting funds between client and provider.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |
| `clientRefundTokens` | number | Yes | Client refund amount |
| `providerPaymentTokens` | number | Yes | Provider payment amount |
| `clientTokenAccount` | string | Yes | Client token account |
| `providerTokenAccount` | string | Yes | Provider token account |

**Example response:**
```json
{
  "signature": "8hSt...",
  "clientRefund": 400000,
  "providerPayment": 600000,
  "message": "Dispute resolved"
}
```

### resolve_dispute_timeout

Auto-resolve a dispute that has not been resolved within the dispute timeout window (7 days, see ADR-030). Anyone can call this; the on-chain rule splits the escrow according to the milestones already approved at the time of dispute.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `escrowAddress` | string | Yes | Escrow public key |
| `clientTokenAccount` | string | Yes | Client token account |
| `providerTokenAccount` | string | Yes | Provider token account |

**Example response:**
```json
{
  "signature": "9iTu...",
  "message": "Dispute resolved by timeout",
  "clientRefund": 500000,
  "providerPayment": 500000
}
```

## Surface 2 Tools (1)

### pay_x402_service

Make an authenticated payment to an x402-protected service URL on behalf of an AEP-registered agent. Wraps an x402 client, debits the agent's Vault, settles via CDP Facilitator on Base, and returns the response + receipt. The `reasoning` field is mandatory — it captures the agent's natural-language justification for auditability.

**STATUS:** Surface 2 scaffold (stub). Real x402 / CDP integration lands per `docs/aep-reflex-tech-spec.md` §"Surface 2".

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_address` | string | Yes | AEP-registered agent (the spender), base58 Solana pubkey |
| `service_url` | string | Yes | x402-protected URL to call |
| `max_price_usdc_micros` | integer | Yes | Hard cap on payment in USDC micros (10^-6 USDC) |
| `request.method` | enum (`GET`\|`POST`) | Yes | HTTP method |
| `request.headers` | object<string,string> | No | Request headers |
| `request.body` | string | No | Request body |
| `reasoning` | string | Yes | Mandatory natural-language justification (non-empty) |

**Example response:**
```json
{
  "status": 200,
  "body": "{...}",
  "payment": {
    "tx_hash": "0x...",
    "amount_paid_micros": 1000000,
    "network": "base-sepolia",
    "facilitator": "cdp"
  },
  "duration_ms": 142,
  "decision_record_id": "decision-abc123"
}
```

## Governance Tools (1)

### verify_protocol_invariants

Run the on-chain invariant check across the three programs. Returns a list of any invariants currently violated, useful as a smoke check after upgrades or before relying on cross-program state in custom integrations.

No parameters required.

**Example response:**
```json
{
  "ok": true,
  "checkedAt": 287654321,
  "violations": []
}
```

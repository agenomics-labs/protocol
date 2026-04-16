import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * AEAP MCP Server Tool Definitions
 *
 * 20 tools organized into three categories matching the on-chain programs:
 * 1. Vault Tools (7) - Agent wallet management with spending policies
 * 2. Registry Tools (4) - Agent discovery and reputation
 * 3. Settlement Tools (9) - Escrow lifecycle and milestone-based payments
 *
 * All tool schemas are designed to be AI-agent-friendly:
 * - Amounts in SOL (converted to lamports internally)
 * - Addresses as base58 strings
 * - Human-readable descriptions
 */

// ==================== VAULT TOOLS ====================

export const createVaultTool: Tool = {
  name: "create_vault",
  description:
    "Create a new agent vault with spending policies. The vault is a programmable wallet that enforces daily limits, per-transaction limits, and rate limits. Returns the vault address.",
  inputSchema: {
    type: "object",
    properties: {
      agentIdentity: {
        type: "string",
        description:
          "Public key of the agent identity linked to this vault (usually the agent's own address)",
      },
      dailyLimitSol: {
        type: "number",
        description: "Maximum SOL that can be spent per day",
      },
      perTxLimitSol: {
        type: "number",
        description: "Maximum SOL per single transaction",
      },
      maxTxsPerHour: {
        type: "number",
        description: "Maximum number of transactions allowed per hour",
      },
    },
    required: [
      "agentIdentity",
      "dailyLimitSol",
      "perTxLimitSol",
      "maxTxsPerHour",
    ],
  },
};

export const getVaultInfoTool: Tool = {
  name: "get_vault_info",
  description:
    "Get vault balance, spending policies, daily spend tracking, and pause status. Pass a vault address or omit to use the default vault for this agent.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description:
          "Public key (base58) of the vault. If omitted, derives from the agent's wallet.",
      },
    },
  },
};

export const vaultTransferTool: Tool = {
  name: "vault_transfer",
  description:
    "Transfer SOL from the vault to a recipient. Enforces per-tx limit, daily limit, and rate limit. The agent (wallet) must be the vault authority.",
  inputSchema: {
    type: "object",
    properties: {
      recipientAddress: {
        type: "string",
        description: "Public key of the recipient",
      },
      amountSol: {
        type: "number",
        description: "Amount to transfer in SOL",
      },
    },
    required: ["recipientAddress", "amountSol"],
  },
};

export const updateVaultPolicyTool: Tool = {
  name: "update_vault_policy",
  description:
    "Update the vault's spending policy: daily limit, per-tx limit, and rate limit. Only the vault authority can call this.",
  inputSchema: {
    type: "object",
    properties: {
      dailyLimitSol: {
        type: "number",
        description: "New daily spending limit in SOL",
      },
      perTxLimitSol: {
        type: "number",
        description: "New per-transaction limit in SOL",
      },
      maxTxsPerHour: {
        type: "number",
        description: "New max transactions per hour",
      },
    },
    required: ["dailyLimitSol", "perTxLimitSol", "maxTxsPerHour"],
  },
};

export const pauseVaultTool: Tool = {
  name: "pause_vault",
  description:
    "Pause the vault. No transfers or program calls can be executed while paused. Only the vault authority can pause.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const resumeVaultTool: Tool = {
  name: "resume_vault",
  description:
    "Resume a paused vault. Re-enables transfers and program calls. Only the vault authority can resume.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const manageAllowlistTool: Tool = {
  name: "manage_allowlist",
  description:
    "Add or remove a token mint or program from the vault's allowlist. Tokens in the allowlist can be transferred; programs in the allowlist can be invoked.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "add_token",
          "remove_token",
          "add_program",
          "remove_program",
        ],
        description: "The allowlist operation to perform",
      },
      address: {
        type: "string",
        description:
          "Public key of the token mint or program to add/remove",
      },
    },
    required: ["action", "address"],
  },
};

// ==================== REGISTRY TOOLS ====================

export const registerAgentTool: Tool = {
  name: "register_agent",
  description:
    "Register this agent in the on-chain registry with a name, capabilities, pricing, and vault address. Enables discovery by other agents.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Agent display name (max 64 characters)",
      },
      description: {
        type: "string",
        description: "Description of the agent's capabilities (max 256 chars)",
      },
      category: {
        type: "string",
        description:
          "Primary category (e.g., 'data-analysis', 'trading', 'content-generation')",
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "List of capability tags (1-10 tags)",
      },
      pricingModel: {
        type: "string",
        enum: ["perTask", "perHour", "perToken"],
        description: "How the agent charges for work",
      },
      pricingAmountSol: {
        type: "number",
        description: "Price amount in SOL according to the pricing model",
      },
      acceptedTokens: {
        type: "array",
        items: { type: "string" },
        description:
          "Mint addresses of accepted payment tokens (1-5 tokens)",
      },
      vaultAddress: {
        type: "string",
        description: "Public key of the agent's vault for receiving payments",
      },
    },
    required: [
      "name",
      "description",
      "category",
      "capabilities",
      "pricingModel",
      "pricingAmountSol",
      "acceptedTokens",
      "vaultAddress",
    ],
  },
};

export const getAgentProfileTool: Tool = {
  name: "get_agent_profile",
  description:
    "Get detailed profile for a specific agent including reputation, pricing, capabilities, and task history.",
  inputSchema: {
    type: "object",
    properties: {
      agentAddress: {
        type: "string",
        description:
          "Public key (authority) of the agent to look up. If omitted, returns this agent's profile.",
      },
    },
  },
};

export const updateAgentProfileTool: Tool = {
  name: "update_agent_profile",
  description:
    "Update this agent's profile. All fields are optional — only provided fields are updated.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "New agent name" },
      description: { type: "string", description: "New description" },
      category: { type: "string", description: "New primary category" },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: "New capability tags",
      },
      pricingModel: {
        type: "string",
        enum: ["perTask", "perHour", "perToken"],
        description: "New pricing model",
      },
      pricingAmountSol: {
        type: "number",
        description: "New pricing amount in SOL",
      },
      acceptedTokens: {
        type: "array",
        items: { type: "string" },
        description: "New accepted token mint addresses",
      },
      vaultAddress: {
        type: "string",
        description: "New vault address",
      },
    },
  },
};

export const discoverAgentsTool: Tool = {
  name: "discover_agents",
  description:
    "Search the on-chain registry for agents. Optionally filter by capability or minimum reputation. Returns a list of matching agent profiles.",
  inputSchema: {
    type: "object",
    properties: {
      capability: {
        type: "string",
        description: "Filter by capability tag (partial match)",
      },
      category: {
        type: "string",
        description: "Filter by category (exact match)",
      },
      minReputation: {
        type: "number",
        description: "Minimum reputation score",
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 20)",
      },
    },
  },
};

// ==================== SETTLEMENT TOOLS ====================

export const createEscrowTool: Tool = {
  name: "create_escrow",
  description:
    "Create a task escrow: lock payment in escrow for a provider agent. Defines milestones with amounts that must sum to total. Payment is released per milestone on approval.",
  inputSchema: {
    type: "object",
    properties: {
      providerAddress: {
        type: "string",
        description: "Public key of the provider agent",
      },
      providerVaultAddress: {
        type: "string",
        description: "Public key of the provider's vault",
      },
      tokenMintAddress: {
        type: "string",
        description: "SPL token mint for payment",
      },
      taskId: {
        type: "number",
        description: "Unique numeric task ID",
      },
      totalAmountTokens: {
        type: "number",
        description:
          "Total payment in token base units (e.g., 1000000 for 1 USDC)",
      },
      taskDescription: {
        type: "string",
        description: "Human-readable task description (hashed on-chain)",
      },
      deadlineUnix: {
        type: "number",
        description: "Unix timestamp deadline for task completion",
      },
      milestones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: {
              type: "string",
              description: "Milestone description",
            },
            amount: {
              type: "number",
              description: "Payment amount for this milestone in token base units",
            },
          },
          required: ["description", "amount"],
        },
        description:
          "1-5 milestones. Amounts must sum to totalAmountTokens.",
      },
      disputeResolverAddress: {
        type: "string",
        description:
          "Optional: public key of a third-party dispute resolver",
      },
    },
    required: [
      "providerAddress",
      "providerVaultAddress",
      "tokenMintAddress",
      "taskId",
      "totalAmountTokens",
      "taskDescription",
      "deadlineUnix",
      "milestones",
    ],
  },
};

export const acceptTaskTool: Tool = {
  name: "accept_task",
  description:
    "Accept a task as the provider agent. Changes escrow status from Created to Active.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
    },
    required: ["escrowAddress"],
  },
};

export const submitMilestoneTool: Tool = {
  name: "submit_milestone",
  description:
    "Submit a milestone as the provider. Marks the milestone as ready for client review.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
      milestoneIndex: {
        type: "number",
        description: "Zero-based index of the milestone to submit",
      },
    },
    required: ["escrowAddress", "milestoneIndex"],
  },
};

export const approveMilestoneTool: Tool = {
  name: "approve_milestone",
  description:
    "Approve a submitted milestone as the client. Releases the milestone payment to the provider's token account.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
      milestoneIndex: {
        type: "number",
        description: "Zero-based index of the milestone to approve",
      },
      providerTokenAccount: {
        type: "string",
        description:
          "Provider's token account to receive the milestone payment",
      },
    },
    required: ["escrowAddress", "milestoneIndex", "providerTokenAccount"],
  },
};

export const rejectMilestoneTool: Tool = {
  name: "reject_milestone",
  description:
    "Reject a submitted milestone as the client. Sends it back to pending state for re-submission.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
      milestoneIndex: {
        type: "number",
        description: "Zero-based index of the milestone to reject",
      },
    },
    required: ["escrowAddress", "milestoneIndex"],
  },
};

export const getEscrowStatusTool: Tool = {
  name: "get_escrow_status",
  description:
    "Get the current status of an escrow: milestones, amounts, timeline, and dispute state.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
    },
    required: ["escrowAddress"],
  },
};

export const cancelEscrowTool: Tool = {
  name: "cancel_escrow",
  description:
    "Cancel an escrow (client only). Returns escrowed funds to the client. Only works if escrow is in Created status.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
    },
    required: ["escrowAddress"],
  },
};

export const raiseDisputeTool: Tool = {
  name: "raise_dispute",
  description:
    "Raise a dispute on an active escrow. Either client or provider can raise a dispute.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
    },
    required: ["escrowAddress"],
  },
};

export const resolveDisputeTool: Tool = {
  name: "resolve_dispute",
  description:
    "Resolve a disputed escrow by splitting funds between client and provider. Only the designated dispute resolver (or client if none set) can resolve.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account",
      },
      clientRefundTokens: {
        type: "number",
        description: "Amount to refund to client in token base units",
      },
      providerPaymentTokens: {
        type: "number",
        description: "Amount to pay provider in token base units",
      },
      clientTokenAccount: {
        type: "string",
        description: "Client's token account for the refund",
      },
      providerTokenAccount: {
        type: "string",
        description: "Provider's token account for the payment",
      },
    },
    required: [
      "escrowAddress",
      "clientRefundTokens",
      "providerPaymentTokens",
      "clientTokenAccount",
      "providerTokenAccount",
    ],
  },
};

// ==================== EXPORTS ====================

export const allTools: Tool[] = [
  // Vault
  createVaultTool,
  getVaultInfoTool,
  vaultTransferTool,
  updateVaultPolicyTool,
  pauseVaultTool,
  resumeVaultTool,
  manageAllowlistTool,
  // Registry
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  // Settlement
  createEscrowTool,
  acceptTaskTool,
  submitMilestoneTool,
  approveMilestoneTool,
  rejectMilestoneTool,
  getEscrowStatusTool,
  cancelEscrowTool,
  raiseDisputeTool,
  resolveDisputeTool,
];

export type ToolName =
  | "create_vault"
  | "get_vault_info"
  | "vault_transfer"
  | "update_vault_policy"
  | "pause_vault"
  | "resume_vault"
  | "manage_allowlist"
  | "register_agent"
  | "get_agent_profile"
  | "update_agent_profile"
  | "discover_agents"
  | "create_escrow"
  | "accept_task"
  | "submit_milestone"
  | "approve_milestone"
  | "reject_milestone"
  | "get_escrow_status"
  | "cancel_escrow"
  | "raise_dispute"
  | "resolve_dispute";

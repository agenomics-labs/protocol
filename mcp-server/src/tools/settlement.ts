import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * Settlement Tools (9) - Escrow lifecycle and milestone-based payments
 */

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

export const resolveDisputeTimeoutTool: Tool = {
  name: "resolve_dispute_timeout",
  description:
    "Auto-resolve an expired dispute. If the escrow deadline has passed and the dispute has not been resolved, anyone can call this to release funds according to the default timeout resolution policy.",
  inputSchema: {
    type: "object",
    properties: {
      escrowAddress: {
        type: "string",
        description: "Public key of the escrow account with an expired dispute",
      },
    },
    required: ["escrowAddress"],
  },
};

import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * Vault Tools (8) - Agent wallet management with spending policies
 */

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
    "Add or remove a token mint or program from the vault's allowlist. For action=add_token, per-mint per-tx and daily caps MUST be supplied in the mint's base units (findings #13/#14: e.g. 1_000_000 for 1 USDC at 6 decimals). Tokens without configured limits cannot be transferred. Programs in the allowlist can be invoked.",
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
      perTxLimit: {
        type: "number",
        description:
          "REQUIRED for add_token. Max per-tx amount in the mint's base units.",
      },
      dailyLimit: {
        type: "number",
        description:
          "REQUIRED for add_token. Max daily amount in the mint's base units. Must be >= perTxLimit.",
      },
    },
    required: ["action", "address"],
  },
};

export const vaultTokenTransferTool: Tool = {
  name: "vault_token_transfer",
  description:
    "Execute an SPL token transfer from the vault. The token mint must be on the vault's token allowlist. The agent (wallet) must be the vault authority.",
  inputSchema: {
    type: "object",
    properties: {
      tokenMintAddress: {
        type: "string",
        description: "Public key of the SPL token mint",
      },
      recipientTokenAccount: {
        type: "string",
        description:
          "Public key of the recipient's associated token account for the given mint",
      },
      amount: {
        type: "number",
        description: "Amount of tokens to transfer in base units (e.g., 1000000 for 1 USDC)",
      },
    },
    required: ["tokenMintAddress", "recipientTokenAccount", "amount"],
  },
};

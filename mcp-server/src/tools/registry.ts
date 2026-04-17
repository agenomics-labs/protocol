import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * Registry Tools (5) - Agent discovery and reputation
 */

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

export const stakeReputationTool: Tool = {
  name: "stake_reputation",
  description:
    "Stake SOL to back this agent's reputation. Staked SOL can be slashed for misbehaviour. Higher stake signals higher trustworthiness to other agents.",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "number",
        description: "Amount of SOL to stake for reputation",
      },
    },
    required: ["amount"],
  },
};

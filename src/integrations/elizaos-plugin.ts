/** AEP ElizaOS Plugin - wraps 20 MCP tools as ElizaOS actions */

interface ElizaAction {
  name: string;
  description: string;
  parameters: Record<string, ParameterDef>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface ParameterDef {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string };
}

interface ElizaPlugin {
  name: string;
  description: string;
  version: string;
  actions: ElizaAction[];
}

interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

let mcpClient: McpClient | null = null;

export function setMcpClient(client: McpClient): void {
  mcpClient = client;
}

async function callMcp(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  if (!mcpClient) throw new Error("MCP client not initialized. Call setMcpClient() first.");
  return mcpClient.callTool(toolName, params);
}

function createAction(
  name: string,
  description: string,
  parameters: Record<string, ParameterDef>,
  mcpToolName: string
): ElizaAction {
  return {
    name,
    description,
    parameters,
    handler: async (params: Record<string, unknown>) =>
      callMcp(mcpToolName, params),
  };
}

const vaultActions: ElizaAction[] = [
  createAction("aep_create_vault", "Create a new agent vault with spending policies", {
    agentIdentity: { type: "string", description: "Agent public key", required: true },
    dailyLimitSol: { type: "number", description: "Max SOL per day", required: true },
    perTxLimitSol: { type: "number", description: "Max SOL per transaction", required: true },
    maxTxsPerHour: { type: "number", description: "Max transactions per hour", required: true },
  }, "create_vault"),

  createAction("aep_get_vault_info", "Get vault balance, policies, and status", {
    vaultAddress: { type: "string", description: "Vault public key (optional)" },
  }, "get_vault_info"),

  createAction("aep_vault_transfer", "Transfer SOL from vault to recipient", {
    recipientAddress: { type: "string", description: "Recipient public key", required: true },
    amountSol: { type: "number", description: "Amount in SOL", required: true },
  }, "vault_transfer"),

  createAction("aep_update_vault_policy", "Update vault spending policies", {
    dailyLimitSol: { type: "number", description: "New daily limit", required: true },
    perTxLimitSol: { type: "number", description: "New per-tx limit", required: true },
    maxTxsPerHour: { type: "number", description: "New rate limit", required: true },
  }, "update_vault_policy"),

  createAction("aep_pause_vault", "Pause vault (block all transfers)", {}, "pause_vault"),

  createAction("aep_resume_vault", "Resume a paused vault", {}, "resume_vault"),

  createAction("aep_manage_allowlist", "Add/remove tokens or programs from vault allowlist", {
    action: { type: "string", description: "Operation", required: true, enum: ["add_token", "remove_token", "add_program", "remove_program"] },
    address: { type: "string", description: "Token mint or program public key", required: true },
  }, "manage_allowlist"),
];

const registryActions: ElizaAction[] = [
  createAction("aep_register_agent", "Register agent in on-chain registry", {
    name: { type: "string", description: "Agent name", required: true },
    description: { type: "string", description: "Agent description", required: true },
    category: { type: "string", description: "Primary category", required: true },
    capabilities: { type: "array", description: "Capability tags", required: true, items: { type: "string" } },
    pricingModel: { type: "string", description: "Pricing model", required: true, enum: ["perTask", "perHour", "perToken"] },
    pricingAmountSol: { type: "number", description: "Price in SOL", required: true },
    acceptedTokens: { type: "array", description: "Accepted token mints", required: true, items: { type: "string" } },
    vaultAddress: { type: "string", description: "Vault address", required: true },
  }, "register_agent"),

  createAction("aep_get_agent_profile", "Get agent profile and reputation", {
    agentAddress: { type: "string", description: "Agent authority public key" },
  }, "get_agent_profile"),

  createAction("aep_update_agent_profile", "Update agent profile fields", {
    name: { type: "string", description: "New name" },
    description: { type: "string", description: "New description" },
    category: { type: "string", description: "New category" },
    capabilities: { type: "array", description: "New capabilities", items: { type: "string" } },
    pricingModel: { type: "string", description: "New pricing model", enum: ["perTask", "perHour", "perToken"] },
    pricingAmountSol: { type: "number", description: "New price" },
  }, "update_agent_profile"),

  createAction("aep_discover_agents", "Search registry for agents by capability or reputation", {
    capability: { type: "string", description: "Filter by capability" },
    category: { type: "string", description: "Filter by category" },
    minReputation: { type: "number", description: "Minimum reputation score" },
    limit: { type: "number", description: "Max results" },
  }, "discover_agents"),
];

const settlementActions: ElizaAction[] = [
  createAction("aep_create_escrow", "Create task escrow with milestones", {
    providerAddress: { type: "string", description: "Provider agent public key", required: true },
    providerVaultAddress: { type: "string", description: "Provider vault", required: true },
    tokenMintAddress: { type: "string", description: "Payment token mint", required: true },
    taskId: { type: "number", description: "Unique task ID", required: true },
    totalAmountTokens: { type: "number", description: "Total payment in base units", required: true },
    taskDescription: { type: "string", description: "Task description", required: true },
    deadlineUnix: { type: "number", description: "Deadline timestamp", required: true },
  }, "create_escrow"),

  createAction("aep_accept_task", "Accept a task as provider", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
  }, "accept_task"),

  createAction("aep_submit_milestone", "Submit milestone for review", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
    milestoneIndex: { type: "number", description: "Milestone index", required: true },
  }, "submit_milestone"),

  createAction("aep_approve_milestone", "Approve milestone and release payment", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
    milestoneIndex: { type: "number", description: "Milestone index", required: true },
    providerTokenAccount: { type: "string", description: "Provider token account", required: true },
  }, "approve_milestone"),

  createAction("aep_reject_milestone", "Reject submitted milestone", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
    milestoneIndex: { type: "number", description: "Milestone index", required: true },
  }, "reject_milestone"),

  createAction("aep_get_escrow_status", "Get escrow status and milestone details", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
  }, "get_escrow_status"),

  createAction("aep_cancel_escrow", "Cancel escrow and refund client", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
  }, "cancel_escrow"),

  createAction("aep_raise_dispute", "Raise dispute on active escrow", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
  }, "raise_dispute"),

  createAction("aep_resolve_dispute", "Resolve dispute by splitting funds", {
    escrowAddress: { type: "string", description: "Escrow public key", required: true },
    clientRefundTokens: { type: "number", description: "Client refund amount", required: true },
    providerPaymentTokens: { type: "number", description: "Provider payment amount", required: true },
    clientTokenAccount: { type: "string", description: "Client token account", required: true },
    providerTokenAccount: { type: "string", description: "Provider token account", required: true },
  }, "resolve_dispute"),
];

export const aepPlugin: ElizaPlugin = {
  name: "aep",
  description: "Agenomics Protocol - vaults, discovery, and settlement for AI agents on Solana",
  version: "0.1.0",
  actions: [...vaultActions, ...registryActions, ...settlementActions],
};

export default aepPlugin;

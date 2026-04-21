/** AEP Solana Agent Kit Plugin - wraps MCP tools as SAK-compatible tools */

interface SakToolInput { name: string; type: string; description: string; required?: boolean; }
interface SakTool { name: string; description: string; inputs: SakToolInput[]; execute: (args: Record<string, unknown>) => Promise<unknown>; }
interface McpClient { callTool(name: string, args: Record<string, unknown>): Promise<unknown>; }

let mcpClient: McpClient | null = null;
export function setMcpClient(client: McpClient): void { mcpClient = client; }

function callMcp(tool: string, params: Record<string, unknown>): Promise<unknown> {
  if (!mcpClient) throw new Error("MCP client not initialized. Call setMcpClient() first.");
  return mcpClient.callTool(tool, params);
}

function t(name: string, desc: string, inputs: SakToolInput[], mcp: string): SakTool {
  return { name, description: desc, inputs, execute: (args) => callMcp(mcp, args) };
}
function i(name: string, type: string, desc: string, req = false): SakToolInput {
  return { name, type, description: desc, required: req };
}

export const aepTools: SakTool[] = [
  t("aep_create_vault", "Create agent vault with spending policies", [
    i("agentIdentity", "string", "Agent public key", true),
    i("dailyLimitSol", "number", "Max SOL per day", true),
    i("perTxLimitSol", "number", "Max SOL per tx", true),
    i("maxTxsPerHour", "number", "Max tx per hour", true),
  ], "create_vault"),
  t("aep_get_vault_info", "Get vault balance and policies", [i("vaultAddress", "string", "Vault key")], "get_vault_info"),
  t("aep_vault_transfer", "Transfer SOL from vault", [
    i("recipientAddress", "string", "Recipient key", true), i("amountSol", "number", "SOL amount", true),
  ], "vault_transfer"),
  t("aep_update_vault_policy", "Update vault spending limits", [
    i("dailyLimitSol", "number", "Daily limit", true), i("perTxLimitSol", "number", "Per-tx limit", true),
    i("maxTxsPerHour", "number", "Rate limit", true),
  ], "update_vault_policy"),
  t("aep_pause_vault", "Pause vault", [], "pause_vault"),
  t("aep_resume_vault", "Resume vault", [], "resume_vault"),
  t("aep_manage_allowlist", "Manage vault allowlist", [
    i("action", "string", "add_token|remove_token|add_program|remove_program", true),
    i("address", "string", "Token/program address", true),
  ], "manage_allowlist"),
  t("aep_register_agent", "Register agent in registry", [
    i("name", "string", "Name", true), i("description", "string", "Description", true),
    i("category", "string", "Category", true), i("pricingModel", "string", "perTask|perHour|perToken", true),
    i("pricingAmountSol", "number", "Price", true), i("vaultAddress", "string", "Vault", true),
  ], "register_agent"),
  t("aep_get_agent_profile", "Get agent profile", [i("agentAddress", "string", "Agent key")], "get_agent_profile"),
  t("aep_discover_agents", "Search for agents", [
    i("capability", "string", "Capability"), i("category", "string", "Category"),
    i("minReputation", "number", "Min reputation"), i("limit", "number", "Max results"),
  ], "discover_agents"),
  t("aep_update_agent_profile", "Update profile", [
    i("name", "string", "Name"), i("description", "string", "Description"), i("category", "string", "Category"),
  ], "update_agent_profile"),
  t("aep_create_escrow", "Create task escrow", [
    i("providerAddress", "string", "Provider key", true), i("providerVaultAddress", "string", "Provider vault", true),
    i("tokenMintAddress", "string", "Token mint", true), i("taskId", "number", "Task ID", true),
    i("totalAmountTokens", "number", "Total payment", true), i("taskDescription", "string", "Description", true),
    i("deadlineUnix", "number", "Deadline", true),
  ], "create_escrow"),
  t("aep_accept_task", "Accept task", [i("escrowAddress", "string", "Escrow key", true)], "accept_task"),
  t("aep_submit_milestone", "Submit milestone", [
    i("escrowAddress", "string", "Escrow key", true), i("milestoneIndex", "number", "Index", true),
  ], "submit_milestone"),
  t("aep_approve_milestone", "Approve milestone", [
    i("escrowAddress", "string", "Escrow key", true), i("milestoneIndex", "number", "Index", true),
    i("providerTokenAccount", "string", "Provider token acct", true),
  ], "approve_milestone"),
  t("aep_reject_milestone", "Reject milestone", [
    i("escrowAddress", "string", "Escrow key", true), i("milestoneIndex", "number", "Index", true),
  ], "reject_milestone"),
  t("aep_get_escrow_status", "Get escrow status", [i("escrowAddress", "string", "Escrow key", true)], "get_escrow_status"),
  t("aep_cancel_escrow", "Cancel escrow", [i("escrowAddress", "string", "Escrow key", true)], "cancel_escrow"),
  t("aep_raise_dispute", "Raise dispute", [i("escrowAddress", "string", "Escrow key", true)], "raise_dispute"),
  t("aep_resolve_dispute", "Resolve dispute", [
    i("escrowAddress", "string", "Escrow key", true), i("clientRefundTokens", "number", "Client refund", true),
    i("providerPaymentTokens", "number", "Provider payment", true),
    i("clientTokenAccount", "string", "Client acct", true), i("providerTokenAccount", "string", "Provider acct", true),
  ], "resolve_dispute"),
];

export default aepTools;

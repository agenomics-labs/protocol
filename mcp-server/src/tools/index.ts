import { Tool } from "@modelcontextprotocol/sdk/types";

// Re-export all vault tools
export {
  createVaultTool,
  getVaultInfoTool,
  vaultTransferTool,
  vaultTokenTransferTool,
  updateVaultPolicyTool,
  rotateAgentIdentityTool,
  pauseVaultTool,
  resumeVaultTool,
  manageAllowlistTool,
} from "./vault.js";

// Re-export all registry tools
export {
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
} from "./registry.js";

// Re-export all settlement tools
export {
  createEscrowTool,
  acceptTaskTool,
  submitMilestoneTool,
  approveMilestoneTool,
  rejectMilestoneTool,
  getEscrowStatusTool,
  cancelEscrowTool,
  raiseDisputeTool,
  resolveDisputeTool,
  resolveDisputeTimeoutTool,
} from "./settlement.js";

// Import for aggregation
import {
  createVaultTool,
  getVaultInfoTool,
  vaultTransferTool,
  vaultTokenTransferTool,
  updateVaultPolicyTool,
  rotateAgentIdentityTool,
  pauseVaultTool,
  resumeVaultTool,
  manageAllowlistTool,
} from "./vault.js";

import {
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
} from "./registry.js";

import {
  createEscrowTool,
  acceptTaskTool,
  submitMilestoneTool,
  approveMilestoneTool,
  rejectMilestoneTool,
  getEscrowStatusTool,
  cancelEscrowTool,
  raiseDisputeTool,
  resolveDisputeTool,
  resolveDisputeTimeoutTool,
} from "./settlement.js";

/**
 * All 25 Agenomics MCP tools organized by domain:
 * - Vault (9): Agent wallet management with spending policies
 *   (includes `rotate_agent_identity` per ADR-069 / AUD-015)
 * - Registry (5) + reputation snapshot (1): Agent discovery and reputation
 * - Settlement (10): Escrow lifecycle and milestone-based payments
 */
export const allTools: Tool[] = [
  // Vault
  createVaultTool,
  getVaultInfoTool,
  vaultTransferTool,
  vaultTokenTransferTool,
  updateVaultPolicyTool,
  rotateAgentIdentityTool,
  pauseVaultTool,
  resumeVaultTool,
  manageAllowlistTool,
  // Registry
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
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
  resolveDisputeTimeoutTool,
];

export type ToolName =
  | "create_vault"
  | "get_vault_info"
  | "vault_transfer"
  | "vault_token_transfer"
  | "update_vault_policy"
  | "rotate_agent_identity"
  | "pause_vault"
  | "resume_vault"
  | "manage_allowlist"
  | "register_agent"
  | "get_agent_profile"
  | "update_agent_profile"
  | "discover_agents"
  | "stake_reputation"
  | "get_agent_reputation"
  | "create_escrow"
  | "accept_task"
  | "submit_milestone"
  | "approve_milestone"
  | "reject_milestone"
  | "get_escrow_status"
  | "cancel_escrow"
  | "raise_dispute"
  | "resolve_dispute"
  | "resolve_dispute_timeout";

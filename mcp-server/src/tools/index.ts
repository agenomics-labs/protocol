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
  queryExecutionHistoryTool,
} from "./vault.js";

// Re-export all registry tools
export {
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
  findSimilarAgentsTool,
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

// Re-export all governance tools
export { verifyProtocolInvariantsTool } from "./governance.js";

// Re-export Surface 2 tool (pay_x402_service) — see
// docs/aep-reflex-tech-spec.md §"Surface 2".
export { payX402ServiceTool } from "./pay-x402-service.js";

// ADR-111: re-export delegation-grant tools.
export {
  createDelegationGrantTool,
  revokeDelegationGrantTool,
  updateDelegationGrantTool,
  executeGrantTransferTool,
  executeGrantTokenTransferTool,
  getDelegationGrantTool,
  listDelegationGrantsForVaultTool,
} from "./delegation.js";

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
  queryExecutionHistoryTool,
} from "./vault.js";

import {
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
  findSimilarAgentsTool,
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

import { verifyProtocolInvariantsTool } from "./governance.js";
import { payX402ServiceTool } from "./pay-x402-service.js";

// ADR-111: delegation-grant tools (7 tools)
import {
  createDelegationGrantTool,
  revokeDelegationGrantTool,
  updateDelegationGrantTool,
  executeGrantTransferTool,
  executeGrantTokenTransferTool,
  getDelegationGrantTool,
  listDelegationGrantsForVaultTool,
} from "./delegation.js";

/**
 * All 36 Agenomics MCP tools organized by domain:
 * - Vault (10): Agent wallet management with spending policies
 *   (includes `rotate_agent_identity` per ADR-069 / AUD-015 and the
 *   ADR-138 `query_execution_history` provenance surface)
 * - Delegation (7): ADR-111 bounded sub-authority grants on a vault —
 *   create / revoke / update / execute (SOL + SPL) / get / list.
 * - Registry (5) + reputation snapshot (1) + agent-memory (1): Agent
 *   discovery, reputation, and ADR-129 Phase 1 manifest similarity
 * - Settlement (10): Escrow lifecycle and milestone-based payments
 * - Governance (1): Protocol-wide invariant sweep (AUD-206 / roadmap §3 B2)
 * - Surface 2 (1): `pay_x402_service` — x402 payment relay (scaffold/stub;
 *   docs/aep-reflex-tech-spec.md §"Surface 2")
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
  queryExecutionHistoryTool,
  // Delegation (ADR-111)
  createDelegationGrantTool,
  revokeDelegationGrantTool,
  updateDelegationGrantTool,
  executeGrantTransferTool,
  executeGrantTokenTransferTool,
  getDelegationGrantTool,
  listDelegationGrantsForVaultTool,
  // Registry
  registerAgentTool,
  getAgentProfileTool,
  updateAgentProfileTool,
  discoverAgentsTool,
  stakeReputationTool,
  getAgentReputationTool,
  findSimilarAgentsTool,
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
  // Governance
  verifyProtocolInvariantsTool,
  // Surface 2 (scaffold/stub) — see docs/aep-reflex-tech-spec.md §"Surface 2"
  payX402ServiceTool,
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
  | "query_execution_history"
  // ADR-111 delegation grants
  | "create_delegation_grant"
  | "revoke_delegation_grant"
  | "update_delegation_grant"
  | "execute_grant_transfer"
  | "execute_grant_token_transfer"
  | "get_delegation_grant"
  | "list_delegation_grants_for_vault"
  | "register_agent"
  | "get_agent_profile"
  | "update_agent_profile"
  | "discover_agents"
  | "stake_reputation"
  | "get_agent_reputation"
  | "find_similar_agents"
  | "create_escrow"
  | "accept_task"
  | "submit_milestone"
  | "approve_milestone"
  | "reject_milestone"
  | "get_escrow_status"
  | "cancel_escrow"
  | "raise_dispute"
  | "resolve_dispute"
  | "resolve_dispute_timeout"
  | "verify_protocol_invariants"
  | "pay_x402_service";

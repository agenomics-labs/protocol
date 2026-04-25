// All 25 MCP Actions registered through the ADR-058 Action<I, O> shape.
// Legacy switch-case dispatch in src/index.ts is retired.
//
// AUD-015 / PR-U: `rotate_agent_identity` wraps the on-chain
// `update_agent_identity` ix (ADR-069) so off-chain operators can rotate
// the vault hot key through the standard MCP surface. Tool count 24 → 25.

import type { Action } from "../types/action.js";
import {
  createVaultAction,
  getVaultInfoAction,
  vaultTransferAction,
  vaultTokenTransferAction,
  updateVaultPolicyAction,
  rotateAgentIdentityAction,
  pauseVaultAction,
  resumeVaultAction,
  manageAllowlistAction,
} from "./vault.js";
import {
  registerAgentAction,
  getAgentProfileAction,
  updateAgentProfileAction,
  discoverAgentsAction,
  stakeReputationAction,
} from "./registry.js";
import { getAgentReputationAction } from "./reputation.js";
import {
  createEscrowAction,
  acceptTaskAction,
  submitMilestoneAction,
  approveMilestoneAction,
  rejectMilestoneAction,
  getEscrowStatusAction,
  cancelEscrowAction,
  raiseDisputeAction,
  resolveDisputeAction,
  resolveDisputeTimeoutAction,
} from "./settlement.js";

export const allActions: Action<any, any>[] = [
  // Vault (9)
  createVaultAction,
  getVaultInfoAction,
  vaultTransferAction,
  vaultTokenTransferAction,
  updateVaultPolicyAction,
  rotateAgentIdentityAction,
  pauseVaultAction,
  resumeVaultAction,
  manageAllowlistAction,
  // Registry (5) + reputation snapshot (1)
  registerAgentAction,
  getAgentProfileAction,
  updateAgentProfileAction,
  discoverAgentsAction,
  stakeReputationAction,
  getAgentReputationAction,
  // Settlement (10)
  createEscrowAction,
  acceptTaskAction,
  submitMilestoneAction,
  approveMilestoneAction,
  rejectMilestoneAction,
  getEscrowStatusAction,
  cancelEscrowAction,
  raiseDisputeAction,
  resolveDisputeAction,
  resolveDisputeTimeoutAction,
];

export const allActionNames = new Set(allActions.map((a) => a.name));

// Retained for backwards-compat with PR1's test imports.
export const pilotActions = allActions;
export const pilotActionNames = allActionNames;

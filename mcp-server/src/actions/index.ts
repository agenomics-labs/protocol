// All 23 MCP Actions registered through the ADR-058 Action<I, O> shape.
// Legacy switch-case dispatch in src/index.ts is retired.

import type { Action } from "../types/action.js";
import {
  createVaultAction,
  getVaultInfoAction,
  vaultTransferAction,
  vaultTokenTransferAction,
  updateVaultPolicyAction,
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
  // Vault (8)
  createVaultAction,
  getVaultInfoAction,
  vaultTransferAction,
  vaultTokenTransferAction,
  updateVaultPolicyAction,
  pauseVaultAction,
  resumeVaultAction,
  manageAllowlistAction,
  // Registry (5)
  registerAgentAction,
  getAgentProfileAction,
  updateAgentProfileAction,
  discoverAgentsAction,
  stakeReputationAction,
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

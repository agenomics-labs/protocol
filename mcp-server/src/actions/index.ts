// All 27 MCP Actions registered through the ADR-058 Action<I, O> shape.
// Legacy switch-case dispatch in src/index.ts is retired.
//
// AUD-015 / PR-U: `rotate_agent_identity` wraps the on-chain
// `update_agent_identity` ix (ADR-069) so off-chain operators can rotate
// the vault hot key through the standard MCP surface. Tool count 24 → 25.
//
// AUD-206 (cycle-3, roadmap §3 B2): `verify_protocol_invariants` wraps the
// Registry batch-sweep ix so the upgrade-authority / governance multisig
// can invoke it through the standard MCP surface. Tool count 25 → 26.
//
// ADR-129 Phase 1 (cycle-3): `find_similar_agents` adds an EVO L1 HNSW-
// backed manifest-similarity primitive, gated by `read:agent-memory`.
// Tool count 26 → 27.

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
  findSimilarAgentsAction,
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
import { verifyProtocolInvariantsAction } from "./governance.js";

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
  // Registry (5) + reputation snapshot (1) + agent-memory (1, ADR-129 Phase 1)
  registerAgentAction,
  getAgentProfileAction,
  updateAgentProfileAction,
  discoverAgentsAction,
  stakeReputationAction,
  getAgentReputationAction,
  findSimilarAgentsAction,
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
  // Governance (1) — AUD-206
  verifyProtocolInvariantsAction,
];

export const allActionNames = new Set(allActions.map((a) => a.name));

// Retained for backwards-compat with PR1's test imports.
export const pilotActions = allActions;
export const pilotActionNames = allActionNames;

// All 28 MCP Actions registered through the ADR-058 Action<I, O> shape.
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
//
// Surface 2 (scaffold): `pay_x402_service` adds an x402 payment relay
// that debits the agent's vault and settles via CDP Facilitator on Base.
// See docs/aep-reflex-tech-spec.md §"Surface 2" (lines 220–305) and IC-3
// (lines 109–137). Tool count 27 → 28. STUB only — real x402 / CDP
// integration is the Day 3–7 owner's job.
//
// ADR-138 (cycle-4): `query_execution_history` exposes the off-chain
// indexer's `execution_attestations` projection through the standard
// MCP surface. Tool count 28 → 29.

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
  queryExecutionHistoryAction,
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
import { payX402ServiceAction } from "./pay-x402-service.js";

export const allActions: Action<any, any>[] = [
  // Vault (10) — includes ADR-138 `query_execution_history`
  createVaultAction,
  getVaultInfoAction,
  vaultTransferAction,
  vaultTokenTransferAction,
  updateVaultPolicyAction,
  rotateAgentIdentityAction,
  pauseVaultAction,
  resumeVaultAction,
  manageAllowlistAction,
  queryExecutionHistoryAction,
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
  // Surface 2 (1, SCAFFOLD/STUB) — docs/aep-reflex-tech-spec.md §"Surface 2"
  payX402ServiceAction,
];

export const allActionNames = new Set(allActions.map((a) => a.name));

// Retained for backwards-compat with PR1's test imports.
export const pilotActions = allActions;
export const pilotActionNames = allActionNames;

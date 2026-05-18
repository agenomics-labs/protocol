// ADR-135 — Settlement MCP tool descriptors, DERIVED from the
// single-source Zod schemas in `actions/settlement.ts`.
//
// See `tools/render-schema.ts` for the rationale. Each `inputSchema` is
// `renderInputSchema(<action Zod shape>)`, so the advertised
// `tools/list` contract and the runtime-enforced router contract are
// projections of ONE schema and cannot drift. `description` strings are
// preserved verbatim from the pre-ADR-135 hand-written descriptors for
// wire stability.
//
// Drift fixed by this derivation: the pre-ADR-135 `create_escrow`
// descriptor advertised a REQUIRED `providerVaultAddress` that the
// handler stopped accepting (handlers/settlement.ts "Finding #21" — the
// provider vault PDA is derived from `providerAddress`). The router
// already ignored it; the derived schema now correctly omits it so the
// advertised contract matches the enforced one.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { renderInputSchema } from "./render-schema.js";
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
} from "../actions/settlement.js";

/**
 * Settlement Tools (10) — escrow lifecycle and milestone-based payments.
 * `inputSchema` derived from `actions/settlement.ts` (ADR-135 SSOT).
 */

export const createEscrowTool: Tool = {
  name: "create_escrow",
  description:
    "Create a task escrow: lock payment in escrow for a provider agent. Defines milestones with amounts that must sum to total. Payment is released per milestone on approval.",
  inputSchema: renderInputSchema(createEscrowAction.inputSchema),
};

export const acceptTaskTool: Tool = {
  name: "accept_task",
  description:
    "Accept a task as the provider agent. Changes escrow status from Created to Active.",
  inputSchema: renderInputSchema(acceptTaskAction.inputSchema),
};

export const submitMilestoneTool: Tool = {
  name: "submit_milestone",
  description:
    "Submit a milestone as the provider. Marks the milestone as ready for client review.",
  inputSchema: renderInputSchema(submitMilestoneAction.inputSchema),
};

export const approveMilestoneTool: Tool = {
  name: "approve_milestone",
  description:
    "Approve a submitted milestone as the client. Releases the milestone payment to the provider's token account. An optional `rating` (0..=5) is accepted for forward compatibility with a future on-chain rating instruction; AUD-007 (PR-Q) removed `avg_rating` from `AgentProfile`, so the value is currently validated and emitted in events but does not mutate any on-chain aggregate.",
  inputSchema: renderInputSchema(approveMilestoneAction.inputSchema),
};

export const rejectMilestoneTool: Tool = {
  name: "reject_milestone",
  description:
    "Reject a submitted milestone as the client. Sends it back to pending state for re-submission.",
  inputSchema: renderInputSchema(rejectMilestoneAction.inputSchema),
};

export const getEscrowStatusTool: Tool = {
  name: "get_escrow_status",
  description:
    "Get the current status of an escrow: milestones, amounts, timeline, and dispute state.",
  inputSchema: renderInputSchema(getEscrowStatusAction.inputSchema),
};

export const cancelEscrowTool: Tool = {
  name: "cancel_escrow",
  description:
    "Cancel an escrow (client only). Returns escrowed funds to the client. Only works if escrow is in Created status.",
  inputSchema: renderInputSchema(cancelEscrowAction.inputSchema),
};

export const raiseDisputeTool: Tool = {
  name: "raise_dispute",
  description:
    "Raise a dispute on an active escrow. Either client or provider can raise a dispute.",
  inputSchema: renderInputSchema(raiseDisputeAction.inputSchema),
};

export const resolveDisputeTool: Tool = {
  name: "resolve_dispute",
  description:
    "Resolve a disputed escrow by splitting funds between client and provider. Only the designated dispute resolver (or client if none set) can resolve.",
  inputSchema: renderInputSchema(resolveDisputeAction.inputSchema),
};

export const resolveDisputeTimeoutTool: Tool = {
  name: "resolve_dispute_timeout",
  description:
    "Auto-resolve an expired dispute. If the escrow deadline has passed and the dispute has not been resolved, anyone can call this to release funds according to the default timeout resolution policy.",
  inputSchema: renderInputSchema(resolveDisputeTimeoutAction.inputSchema),
};

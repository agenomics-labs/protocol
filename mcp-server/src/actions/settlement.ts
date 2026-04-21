// All 10 settlement Actions. Wraps existing handlers without logic change.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  handleCreateEscrow,
  handleAcceptTask,
  handleSubmitMilestone,
  handleApproveMilestone,
  handleRejectMilestone,
  handleGetEscrowStatus,
  handleCancelEscrow,
  handleRaiseDispute,
  handleResolveDispute,
  handleResolveDisputeTimeout,
} from "../handlers/settlement.js";

function wrap<I>(fn: (args: Record<string, unknown>) => Promise<any>) {
  return async (_ctx: any, input: I) => {
    try {
      return ok(await fn(input as unknown as Record<string, unknown>));
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

// ---------- create_escrow ----------

const createEscrowInput = {
  providerAddress: z.string(),
  tokenMintAddress: z.string(),
  taskId: z.number(),
  totalAmountTokens: z.number().positive(),
  taskDescription: z.string(),
  deadlineUnix: z.number(),
  milestones: z.array(
    z.object({ description: z.string(), amount: z.number() }),
  ).min(1).max(5),
  disputeResolverAddress: z.string().optional(),
} as const;

export const createEscrowAction: Action<
  z.infer<z.ZodObject<typeof createEscrowInput>>,
  unknown
> = {
  name: "create_escrow",
  title: "Create escrow",
  description:
    "Create a task escrow: lock payment in escrow for a provider agent. Defines milestones with amounts that must sum to total. Payment is released per milestone on approval.",
  inputSchema: createEscrowInput,
  outputSchema: z.unknown(),
  similes: ["fund escrow", "lock payment"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: wrap(handleCreateEscrow),
};

// ---------- accept_task ----------

const acceptTaskInput = { escrowAddress: z.string() } as const;

export const acceptTaskAction: Action<
  z.infer<z.ZodObject<typeof acceptTaskInput>>,
  unknown
> = {
  name: "accept_task",
  title: "Accept task",
  description: "Accept a task as the provider agent. Changes escrow status from Created to Active.",
  inputSchema: acceptTaskInput,
  outputSchema: z.unknown(),
  similes: ["start task", "accept escrow"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: wrap(handleAcceptTask),
};

// ---------- submit_milestone ----------

const submitMilestoneInput = {
  escrowAddress: z.string(),
  milestoneIndex: z.number().int().nonnegative(),
} as const;

export const submitMilestoneAction: Action<
  z.infer<z.ZodObject<typeof submitMilestoneInput>>,
  unknown
> = {
  name: "submit_milestone",
  title: "Submit milestone",
  description: "Submit a milestone as the provider. Marks the milestone as ready for client review.",
  inputSchema: submitMilestoneInput,
  outputSchema: z.unknown(),
  similes: ["submit work", "deliver milestone"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement", "sign:cross_program:settlement+registry"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) => `${i.escrowAddress}:${i.milestoneIndex}:submit`,
  handler: wrap(handleSubmitMilestone),
};

// ---------- approve_milestone ----------

const approveMilestoneInput = {
  escrowAddress: z.string(),
  milestoneIndex: z.number().int().nonnegative(),
  providerTokenAccount: z.string(),
  rating: z.number().min(0).max(5).optional(),
} as const;

export const approveMilestoneAction: Action<
  z.infer<z.ZodObject<typeof approveMilestoneInput>>,
  unknown
> = {
  name: "approve_milestone",
  title: "Approve milestone",
  description:
    "Approve a submitted milestone as the client. Releases the milestone payment to the provider's token account. An optional `rating` (0..=5) is folded into the provider's avg_rating in the registry when the final milestone is approved.",
  inputSchema: approveMilestoneInput,
  outputSchema: z.unknown(),
  similes: ["release payment", "approve milestone"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement", "sign:cross_program:settlement+registry"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) => `${i.escrowAddress}:${i.milestoneIndex}:approve`,
  handler: wrap(handleApproveMilestone),
};

// ---------- reject_milestone ----------

const rejectMilestoneInput = {
  escrowAddress: z.string(),
  milestoneIndex: z.number().int().nonnegative(),
} as const;

export const rejectMilestoneAction: Action<
  z.infer<z.ZodObject<typeof rejectMilestoneInput>>,
  unknown
> = {
  name: "reject_milestone",
  title: "Reject milestone",
  description: "Reject a submitted milestone as the client. Sends it back to pending state for re-submission.",
  inputSchema: rejectMilestoneInput,
  outputSchema: z.unknown(),
  similes: ["reject", "send back"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: wrap(handleRejectMilestone),
};

// ---------- get_escrow_status ----------

const getEscrowStatusInput = { escrowAddress: z.string() } as const;

export const getEscrowStatusAction: Action<
  z.infer<z.ZodObject<typeof getEscrowStatusInput>>,
  unknown
> = {
  name: "get_escrow_status",
  title: "Get escrow status",
  description:
    "Get the current status of an escrow: milestones, amounts, timeline, and dispute state.",
  inputSchema: getEscrowStatusInput,
  outputSchema: z.unknown(),
  similes: ["check escrow", "escrow details"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleGetEscrowStatus),
};

// ---------- cancel_escrow ----------

const cancelEscrowInput = { escrowAddress: z.string() } as const;

export const cancelEscrowAction: Action<
  z.infer<z.ZodObject<typeof cancelEscrowInput>>,
  unknown
> = {
  name: "cancel_escrow",
  title: "Cancel escrow",
  description: "Cancel an escrow (client only). Returns escrowed funds to the client. Only works if escrow is in Created status.",
  inputSchema: cancelEscrowInput,
  outputSchema: z.unknown(),
  similes: ["cancel", "abort task"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: wrap(handleCancelEscrow),
};

// ---------- raise_dispute ----------

const raiseDisputeInput = { escrowAddress: z.string() } as const;

export const raiseDisputeAction: Action<
  z.infer<z.ZodObject<typeof raiseDisputeInput>>,
  unknown
> = {
  name: "raise_dispute",
  title: "Raise dispute",
  description: "Raise a dispute on an active escrow. Either client or provider can raise a dispute.",
  inputSchema: raiseDisputeInput,
  outputSchema: z.unknown(),
  similes: ["dispute", "contest"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["dispute_window_open", "cluster_health"],
  preflightContext: (input) => ({ escrowAddress: input.escrowAddress }),
  requiresSigner: true,
  handler: wrap(handleRaiseDispute),
};

// ---------- resolve_dispute ----------

const resolveDisputeInput = {
  escrowAddress: z.string(),
  clientRefundTokens: z.number().nonnegative(),
  providerPaymentTokens: z.number().nonnegative(),
  clientTokenAccount: z.string(),
  providerTokenAccount: z.string(),
} as const;

export const resolveDisputeAction: Action<
  z.infer<z.ZodObject<typeof resolveDisputeInput>>,
  unknown
> = {
  name: "resolve_dispute",
  title: "Resolve dispute",
  description:
    "Resolve a disputed escrow by splitting funds between client and provider. Only the designated dispute resolver (or client if none set) can resolve.",
  inputSchema: resolveDisputeInput,
  outputSchema: z.unknown(),
  similes: ["adjudicate", "split funds"],
  examples: [],
  readOnly: false,
  capabilities: [
    "sign:settlement",
    "sign:cross_program:settlement+registry",
    "admin:settlement",
  ],
  preflight: ["cluster_health", "account_rent_exempt", "dispute_window_open"],
  preflightContext: (input) => ({ escrowAddress: input.escrowAddress }),
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) =>
    `${i.escrowAddress}:${i.clientRefundTokens}:${i.providerPaymentTokens}:resolve`,
  handler: wrap(handleResolveDispute),
};

// ---------- resolve_dispute_timeout ----------

const resolveDisputeTimeoutInput = { escrowAddress: z.string() } as const;

export const resolveDisputeTimeoutAction: Action<
  z.infer<z.ZodObject<typeof resolveDisputeTimeoutInput>>,
  unknown
> = {
  name: "resolve_dispute_timeout",
  title: "Resolve dispute timeout",
  description:
    "Auto-resolve an expired dispute. If the escrow deadline has passed and the dispute has not been resolved, anyone can call this to release funds according to the default timeout resolution policy.",
  inputSchema: resolveDisputeTimeoutInput,
  outputSchema: z.unknown(),
  similes: ["timeout resolve", "expire dispute"],
  examples: [],
  readOnly: false,
  capabilities: [
    "sign:settlement",
    "sign:cross_program:settlement+registry",
    "admin:settlement",
  ],
  preflight: ["cluster_health", "account_rent_exempt", "dispute_window_open"],
  preflightContext: (input) => ({ escrowAddress: input.escrowAddress }),
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) => `${i.escrowAddress}:timeout`,
  handler: wrap(handleResolveDisputeTimeout),
};

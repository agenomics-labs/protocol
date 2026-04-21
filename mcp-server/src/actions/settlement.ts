// Pilot Actions for ADR-058. Wraps the existing handlers in handlers/settlement.ts
// WITHOUT changing their logic — this file is the new Action<I, O> surface only.
// Capability + idempotency metadata per Agent 3's mapping table (ADR audit notes).

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  handleCreateEscrow,
  handleApproveMilestone,
  handleCancelEscrow,
  handleResolveDispute,
} from "../handlers/settlement.js";

// ---------- create_escrow ----------

const createEscrowInput = {
  providerAddress: z.string(),
  tokenMintAddress: z.string(),
  taskId: z.number(),
  totalAmountTokens: z.number().positive(),
  taskDescription: z.string(),
  deadlineUnix: z.number(),
  milestones: z.array(
    z.object({
      description: z.string(),
      amount: z.number(),
    }),
  ).min(1).max(5),
  disputeResolverAddress: z.string().optional(),
} as const;

type CreateEscrowInput = z.infer<z.ZodObject<typeof createEscrowInput>>;

export const createEscrowAction: Action<CreateEscrowInput, unknown> = {
  name: "create_escrow",
  title: "Create escrow",
  description:
    "Create a task escrow: lock payment in escrow for a provider agent. Defines milestones with amounts that must sum to total. Payment is released per milestone on approval.",
  inputSchema: createEscrowInput,
  outputSchema: z.unknown(),
  similes: ["fund escrow", "lock payment", "start task"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: async (_ctx, input) => {
    try {
      const result = await handleCreateEscrow(input as unknown as Record<string, unknown>);
      return ok(result);
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// ---------- approve_milestone ----------

const approveMilestoneInput = {
  escrowAddress: z.string(),
  milestoneIndex: z.number().int().nonnegative(),
  providerTokenAccount: z.string(),
  rating: z.number().min(0).max(5).optional(),
} as const;

type ApproveMilestoneInput = z.infer<z.ZodObject<typeof approveMilestoneInput>>;

export const approveMilestoneAction: Action<ApproveMilestoneInput, unknown> = {
  name: "approve_milestone",
  title: "Approve milestone",
  description:
    "Approve a submitted milestone as the client. Releases the milestone payment to the provider's token account. An optional `rating` (0..=5) is folded into the provider's avg_rating in the registry when the final milestone is approved.",
  inputSchema: approveMilestoneInput,
  outputSchema: z.unknown(),
  similes: ["release payment", "approve milestone", "pay provider"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement", "sign:cross_program:settlement+registry"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) => `${i.escrowAddress}:${i.milestoneIndex}:approve`,
  handler: async (_ctx, input) => {
    try {
      const result = await handleApproveMilestone(input as unknown as Record<string, unknown>);
      return ok(result);
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// ---------- cancel_escrow ----------

const cancelEscrowInput = {
  escrowAddress: z.string(),
} as const;

type CancelEscrowInput = z.infer<z.ZodObject<typeof cancelEscrowInput>>;

export const cancelEscrowAction: Action<CancelEscrowInput, unknown> = {
  name: "cancel_escrow",
  title: "Cancel escrow",
  description:
    "Cancel an escrow (client only). Returns escrowed funds to the client. Only works if escrow is in Created status.",
  inputSchema: cancelEscrowInput,
  outputSchema: z.unknown(),
  similes: ["cancel escrow", "refund client", "abort task"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:settlement"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: async (_ctx, input) => {
    try {
      const result = await handleCancelEscrow(input as unknown as Record<string, unknown>);
      return ok(result);
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// ---------- resolve_dispute ----------

const resolveDisputeInput = {
  escrowAddress: z.string(),
  clientRefundTokens: z.number().nonnegative(),
  providerPaymentTokens: z.number().nonnegative(),
  clientTokenAccount: z.string(),
  providerTokenAccount: z.string(),
} as const;

type ResolveDisputeInput = z.infer<z.ZodObject<typeof resolveDisputeInput>>;

export const resolveDisputeAction: Action<ResolveDisputeInput, unknown> = {
  name: "resolve_dispute",
  title: "Resolve dispute",
  description:
    "Resolve a disputed escrow by splitting funds between client and provider. Only the designated dispute resolver (or client if none set) can resolve.",
  inputSchema: resolveDisputeInput,
  outputSchema: z.unknown(),
  similes: ["resolve dispute", "split funds", "adjudicate"],
  examples: [],
  readOnly: false,
  capabilities: [
    "sign:settlement",
    "sign:cross_program:settlement+registry",
    "admin:settlement",
  ],
  preflight: ["cluster_health", "account_rent_exempt", "dispute_window_open"],
  requiresSigner: true,
  idempotent: true,
  idempotencyKey: (i) =>
    `${i.escrowAddress}:${i.clientRefundTokens}:${i.providerPaymentTokens}:resolve`,
  handler: async (_ctx, input) => {
    try {
      const result = await handleResolveDispute(input as unknown as Record<string, unknown>);
      return ok(result);
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

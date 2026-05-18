// All 10 settlement Actions. Wraps existing handlers without logic change.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
// CC-5: shared base58-pubkey schema — replaces bare z.string() on every
// address/mint/token-account field (boundary-validation parity).
import { solanaAddress } from "../schema/solana-address.js";
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

// ADR-135: `.describe()` carries the MCP-client-visible field docs that
// pre-ADR-135 lived only in the hand-written tools/settlement.ts JSON
// Schema. NOTE the pre-ADR-135 tools/settlement.ts also advertised a
// required `providerVaultAddress` field; the handler stopped accepting
// it (handlers/settlement.ts "Finding #21" — the provider vault PDA is
// derived from `providerAddress`), so it was stale drift the router
// already ignored. ADR-135 makes the Zod schema authoritative, so the
// derived schema correctly drops it (advertise the truthful contract).
const createEscrowInput = {
  providerAddress: solanaAddress.describe("Public key of the provider agent"),
  tokenMintAddress: solanaAddress.describe("SPL token mint for payment"),
  taskId: z.number().describe("Unique numeric task ID"),
  totalAmountTokens: z
    .number()
    .positive()
    .describe("Total payment in token base units (e.g., 1000000 for 1 USDC)"),
  taskDescription: z
    .string()
    .describe("Human-readable task description (hashed on-chain)"),
  deadlineUnix: z
    .number()
    .describe("Unix timestamp deadline for task completion"),
  milestones: z
    .array(
      z.object({
        description: z.string().describe("Milestone description"),
        amount: z
          .number()
          .describe("Payment amount for this milestone in token base units"),
      }),
    )
    .min(1)
    .max(5)
    .describe("1-5 milestones. Amounts must sum to totalAmountTokens."),
  disputeResolverAddress: solanaAddress
    .optional()
    .describe("Optional: public key of a third-party dispute resolver"),
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

const acceptTaskInput = {
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
} as const;

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
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
  milestoneIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based index of the milestone to submit"),
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
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
  milestoneIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based index of the milestone to approve"),
  providerTokenAccount: solanaAddress.describe(
    "Provider's token account to receive the milestone payment",
  ),
  rating: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe(
      "Optional 0..=5 star rating. 0 means no rating (default). AUD-007 (PR-Q): `avg_rating` was removed from on-chain `AgentProfile`; the value is accepted for forward-compat (future rating ix) and currently has no on-chain effect.",
    ),
} as const;

export const approveMilestoneAction: Action<
  z.infer<z.ZodObject<typeof approveMilestoneInput>>,
  unknown
> = {
  name: "approve_milestone",
  title: "Approve milestone",
  description:
    "Approve a submitted milestone as the client. Releases the milestone payment to the provider's token account. An optional `rating` (0..=5) is accepted for forward compatibility with a future on-chain rating instruction; AUD-007 (PR-Q) removed `avg_rating` from `AgentProfile`, so the value is currently validated and emitted in events but does not mutate any on-chain aggregate.",
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
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
  milestoneIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("Zero-based index of the milestone to reject"),
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

const getEscrowStatusInput = {
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
} as const;

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

const cancelEscrowInput = {
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
} as const;

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

const raiseDisputeInput = {
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
} as const;

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
  escrowAddress: solanaAddress.describe("Public key of the escrow account"),
  clientRefundTokens: z
    .number()
    .nonnegative()
    .describe("Amount to refund to client in token base units"),
  providerPaymentTokens: z
    .number()
    .nonnegative()
    .describe("Amount to pay provider in token base units"),
  clientTokenAccount: solanaAddress.describe(
    "Client's token account for the refund",
  ),
  providerTokenAccount: solanaAddress.describe(
    "Provider's token account for the payment",
  ),
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

const resolveDisputeTimeoutInput = {
  escrowAddress: solanaAddress.describe(
    "Public key of the escrow account with an expired dispute",
  ),
} as const;

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

// All 8 vault Actions. Wraps existing handlers without logic change.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  handleCreateVault,
  handleGetVaultInfo,
  handleVaultTransfer,
  handleVaultTokenTransfer,
  handleUpdateVaultPolicy,
  handlePauseVault,
  handleResumeVault,
  handleManageAllowlist,
} from "../handlers/vault.js";

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

// ---------- create_vault ----------

const createVaultInput = {
  agentIdentity: z.string(),
  dailyLimitSol: z.number().nonnegative(),
  perTxLimitSol: z.number().nonnegative(),
  maxTxsPerHour: z.number().int().nonnegative(),
} as const;

export const createVaultAction: Action<
  z.infer<z.ZodObject<typeof createVaultInput>>,
  unknown
> = {
  name: "create_vault",
  title: "Create vault",
  description:
    "Create a new agent vault with spending policies. The vault is a programmable wallet that enforces daily limits, per-transaction limits, and rate limits. Returns the vault address.",
  inputSchema: createVaultInput,
  outputSchema: z.unknown(),
  similes: ["new vault", "create wallet"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health", "account_rent_exempt"],
  requiresSigner: true,
  handler: wrap(handleCreateVault),
};

// ---------- get_vault_info ----------

const getVaultInfoInput = {
  vaultAddress: z.string().optional(),
} as const;

export const getVaultInfoAction: Action<
  z.infer<z.ZodObject<typeof getVaultInfoInput>>,
  unknown
> = {
  name: "get_vault_info",
  title: "Get vault info",
  description:
    "Get vault balance, spending policies, daily spend tracking, and pause status. Pass a vault address or omit to use the default vault for this agent.",
  inputSchema: getVaultInfoInput,
  outputSchema: z.unknown(),
  similes: ["vault status", "check vault"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleGetVaultInfo),
};

// ---------- vault_transfer ----------

const vaultTransferInput = {
  recipientAddress: z.string(),
  amountSol: z.number().positive(),
} as const;

export const vaultTransferAction: Action<
  z.infer<z.ZodObject<typeof vaultTransferInput>>,
  unknown
> = {
  name: "vault_transfer",
  title: "Vault SOL transfer",
  description:
    "Transfer SOL from the vault to a recipient. Enforces per-tx limit, daily limit, and rate limit. The agent (wallet) must be the vault authority.",
  inputSchema: vaultTransferInput,
  outputSchema: z.unknown(),
  similes: ["send sol", "vault payout", "transfer from vault"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health", "account_rent_exempt", "daily_cap_not_exhausted"],
  requiresSigner: true,
  handler: wrap(handleVaultTransfer),
};

// ---------- vault_token_transfer ----------

const vaultTokenTransferInput = {
  tokenMintAddress: z.string(),
  recipientTokenAccount: z.string(),
  amount: z.number().positive(),
} as const;

export const vaultTokenTransferAction: Action<
  z.infer<z.ZodObject<typeof vaultTokenTransferInput>>,
  unknown
> = {
  name: "vault_token_transfer",
  title: "Vault SPL transfer",
  description:
    "Execute an SPL token transfer from the vault. The token mint must be on the vault's token allowlist. The agent (wallet) must be the vault authority.",
  inputSchema: vaultTokenTransferInput,
  outputSchema: z.unknown(),
  similes: ["send token", "spl transfer", "vault token payout"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health", "account_rent_exempt", "daily_cap_not_exhausted"],
  requiresSigner: true,
  handler: wrap(handleVaultTokenTransfer),
};

// ---------- update_vault_policy ----------

const updateVaultPolicyInput = {
  dailyLimitSol: z.number().nonnegative(),
  perTxLimitSol: z.number().nonnegative(),
  maxTxsPerHour: z.number().int().nonnegative(),
} as const;

export const updateVaultPolicyAction: Action<
  z.infer<z.ZodObject<typeof updateVaultPolicyInput>>,
  unknown
> = {
  name: "update_vault_policy",
  title: "Update vault policy",
  description:
    "Update the vault's spending policy: daily limit, per-tx limit, and rate limit. Only the vault authority can call this.",
  inputSchema: updateVaultPolicyInput,
  outputSchema: z.unknown(),
  similes: ["change limits", "reconfigure vault"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: wrap(handleUpdateVaultPolicy),
};

// ---------- pause_vault / resume_vault ----------

export const pauseVaultAction: Action<Record<string, never>, unknown> = {
  name: "pause_vault",
  title: "Pause vault",
  description:
    "Pause the vault. No transfers or program calls can be executed while paused. Only the vault authority can pause.",
  inputSchema: {},
  outputSchema: z.unknown(),
  similes: ["freeze vault", "halt vault"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  requiresSigner: true,
  handler: async (_ctx, _input) => {
    try {
      return ok(await handlePauseVault());
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const resumeVaultAction: Action<Record<string, never>, unknown> = {
  name: "resume_vault",
  title: "Resume vault",
  description:
    "Resume a paused vault. Re-enables transfers and program calls. Only the vault authority can resume.",
  inputSchema: {},
  outputSchema: z.unknown(),
  similes: ["unfreeze vault", "unpause vault"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  requiresSigner: true,
  handler: async (_ctx, _input) => {
    try {
      return ok(await handleResumeVault());
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// ---------- manage_allowlist ----------

const manageAllowlistInput = {
  action: z.enum(["add_token", "remove_token", "add_program", "remove_program"]),
  address: z.string(),
  perTxLimit: z.number().optional(),
  dailyLimit: z.number().optional(),
} as const;

export const manageAllowlistAction: Action<
  z.infer<z.ZodObject<typeof manageAllowlistInput>>,
  unknown
> = {
  name: "manage_allowlist",
  title: "Manage vault allowlist",
  description:
    "Add or remove a token mint or program from the vault's allowlist. For action=add_token, per-mint per-tx and daily caps MUST be supplied in the mint's base units. Tokens without configured limits cannot be transferred. Programs in the allowlist can be invoked.",
  inputSchema: manageAllowlistInput,
  outputSchema: z.unknown(),
  similes: ["allowlist", "whitelist token"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  requiresSigner: true,
  handler: wrap(handleManageAllowlist),
};

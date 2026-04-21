// Pilot vault Actions for ADR-058. Wraps existing handlers without logic change.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import { handleVaultTransfer } from "../handlers/vault.js";

const vaultTransferInput = {
  recipientAddress: z.string(),
  amountSol: z.number().positive(),
} as const;

type VaultTransferInput = z.infer<z.ZodObject<typeof vaultTransferInput>>;

export const vaultTransferAction: Action<VaultTransferInput, unknown> = {
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
  handler: async (_ctx, input) => {
    try {
      const result = await handleVaultTransfer(input as unknown as Record<string, unknown>);
      return ok(result);
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

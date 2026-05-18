// All 8 vault Actions. Wraps existing handlers without logic change.
//
// PR7 / ADR-012: `vault_transfer` gains an env-gated v2 (Kit-native) path.
// Set `AEP_USE_V2_VAULT_TRANSFER=1` to route to `handleVaultTransferV2`
// instead of the Anchor v1 handler. Default remains v1 until devnet tests
// prove parity. See `handlers-v2/vault.ts` for the v2 implementation.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  handleCreateVault,
  handleGetVaultInfo,
  handleVaultTransfer,
  handleVaultTokenTransfer,
  handleUpdateVaultPolicy,
  handleRotateAgentIdentity,
  handlePauseVault,
  handleResumeVault,
  handleManageAllowlist,
  handleQueryExecutionHistory,
} from "../handlers/vault.js";
import { handleVaultTransferV2 } from "../handlers-v2/vault.js";
import { deriveVaultPDA, getWalletPublicKey, isValidPublicKey } from "../solana.js";
// CC-5: shared base58-pubkey schema for address/mint/token-account fields.
import { solanaAddress } from "../schema/solana-address.js";
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ action: "vault_transfer" });

// Emit the v2 warning at most once per process, even if the action fires
// multiple times.
let _v2WarningEmitted = false;
function warnV2Enabled(): void {
  if (_v2WarningEmitted) return;
  _v2WarningEmitted = true;
  log.warn(
    { adr: "ADR-012", pr: "PR7", flag: "AEP_USE_V2_VAULT_TRANSFER" },
    "vault_transfer routing through Kit v2 pipeline — devnet parity test required",
  );
}

/**
 * Resolve the default wallet-vault PDA for this process. Used by the
 * `daily_cap_not_exhausted` preflight gate on vault-spend actions to tell
 * the gate which on-chain vault account to read. Matches the derivation
 * the underlying handlers use (see handlers/vault.ts).
 *
 * Wrapped in try/catch because `getWalletPublicKey()` loads the wallet
 * keypair eagerly and will throw in environments without one configured —
 * the gate handles a `vaultAddress: undefined` as a loud PREFLIGHT_FAILED,
 * which is the right surface for "no wallet, therefore no vault to check."
 */
function defaultVaultAddressOrUndefined(): string | undefined {
  try {
    const [pda] = deriveVaultPDA(getWalletPublicKey());
    return pda.toBase58();
  } catch {
    return undefined;
  }
}

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

// ADR-124 (AUD-116 path-a): `agentIdentitySecretKey` accepts EITHER a
// base58-encoded 64-byte Solana secret key OR a JSON-style `number[64]`.
// The handler decodes both shapes; the zod schema accepts both via a
// union and rejects malformed inputs (wrong length, non-base58 string,
// non-numeric array entries) at the boundary.
const agentIdentitySecretKeySchema = z
  .union([
    z
      .string()
      .min(80, {
        message:
          "agentIdentitySecretKey base58 string is too short for a 64-byte secret",
      })
      .max(96, {
        message:
          "agentIdentitySecretKey base58 string is too long for a 64-byte secret",
      })
      .describe(
        "Base58-encoded 64-byte Solana secret key for the agent_identity hot key. Required if agentIdentity != wallet.publicKey.",
      ),
    z
      .array(z.number().int().min(0).max(255))
      .length(64, {
        message:
          "agentIdentitySecretKey array must contain exactly 64 byte values (0..255)",
      })
      .describe(
        "JSON-style 64-byte secret key array for the agent_identity hot key.",
      ),
  ])
  .optional()
  // ADR-135: `.describe()` carries the MCP-client-visible field doc that
  // pre-ADR-135 lived only in the hand-written tools/vault.ts JSON Schema.
  .describe(
    "ADR-124 (AUD-116 path-a) — OPTIONAL. The agent_identity's secret key, used locally to produce the proof-of-control signature. Never leaves the process. Omit for self-bind (wallet == agent_identity).",
  );

const createVaultInput = {
  agentIdentity: solanaAddress.describe(
    "Public key of the agent identity linked to this vault (usually the agent's own address). Must match either `wallet.publicKey` (self-bind mode) or the pubkey derived from `agentIdentitySecretKey` (operator-managed mode).",
  ),
  dailyLimitSol: z
    .number()
    .nonnegative()
    .describe("Maximum SOL that can be spent per day"),
  perTxLimitSol: z
    .number()
    .nonnegative()
    .describe("Maximum SOL per single transaction"),
  maxTxsPerHour: z
    .number()
    .int()
    .nonnegative()
    .describe("Maximum number of transactions allowed per hour"),
  // ADR-124 (AUD-116 path-a): optional. When omitted, the handler self-binds
  // (agent_identity == wallet pubkey). When supplied, the handler uses the
  // secret key to produce the bind signature locally; the secret never
  // leaves the process. See `handleCreateVault` for the full flow.
  agentIdentitySecretKey: agentIdentitySecretKeySchema,
} as const;

export const createVaultAction: Action<
  z.infer<z.ZodObject<typeof createVaultInput>>,
  unknown
> = {
  name: "create_vault",
  title: "Create vault",
  description:
    "Create a new agent vault with spending policies. The vault is a programmable wallet that enforces daily limits, per-transaction limits, and rate limits. Returns the vault address. " +
    "ADR-124 (AUD-116 path-a): the on-chain handler now requires an Ed25519 proof-of-control signature from the holder of `agentIdentity`'s private key. Pass `agentIdentitySecretKey` (base58 or number[64]) to bind a distinct hot key, or omit it to self-bind to the wallet pubkey (agentIdentity must equal wallet.publicKey in that mode).",
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
  vaultAddress: solanaAddress
    .optional()
    .describe(
      "Public key (base58) of the vault. If omitted, derives from the agent's wallet.",
    ),
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
  recipientAddress: solanaAddress.describe("Public key of the recipient"),
  amountSol: z.number().positive().describe("Amount to transfer in SOL"),
} as const;

/**
 * `vault_transfer` handler. Branches on `AEP_USE_V2_VAULT_TRANSFER`:
 *   - unset / "0"  → v1 Anchor path (`handleVaultTransfer`, PRESERVED)
 *   - "1"          → v2 Kit path (`handleVaultTransferV2`)
 *
 * The v1 handler stays intact and is the default; the v2 flag is opt-in
 * until devnet parity is proven (see PR7 PR description).
 */
async function vaultTransferDispatcher(
  _ctx: unknown,
  input: z.infer<z.ZodObject<typeof vaultTransferInput>>,
) {
  if (process.env.AEP_USE_V2_VAULT_TRANSFER === "1") {
    warnV2Enabled();
    // v2 handler already returns a typed Result<T>.
    return handleVaultTransferV2(input);
  }
  // v1 fall-through preserves the existing behavior exactly.
  try {
    return ok(await handleVaultTransfer(input as unknown as Record<string, unknown>));
  } catch (e) {
    return err({
      code: "PROGRAM_ERROR",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

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
  preflightContext: (input) => ({
    vaultAddress: defaultVaultAddressOrUndefined(),
    // input.amountSol may be fractional — scale through BigInt safely by
    // going via the lamports integer representation. Math.round guards
    // against JS float drift on exactly-representable decimals.
    amountLamports:
      BigInt(Math.round(input.amountSol * 1e9)),
  }),
  requiresSigner: true,
  handler: vaultTransferDispatcher,
};

/**
 * Alternative v2-only action export. Not registered in the router by
 * default — exists so tests / ops tooling can invoke the v2 path directly
 * without flipping the process-wide env flag.
 */
export const vaultTransferV2Action: Action<
  z.infer<z.ZodObject<typeof vaultTransferInput>>,
  unknown
> = {
  name: "vault_transfer_v2",
  title: "Vault SOL transfer (Kit v2)",
  description:
    "Transfer SOL from the vault to a recipient via the Kit v2 pipeline. " +
    "Opt-in alternative to vault_transfer; used for PR7 devnet parity testing.",
  inputSchema: vaultTransferInput,
  outputSchema: z.unknown(),
  similes: ["send sol v2", "vault payout v2", "transfer from vault v2"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health", "account_rent_exempt", "daily_cap_not_exhausted"],
  requiresSigner: true,
  handler: async (_ctx, input) => handleVaultTransferV2(input),
};

// ---------- vault_token_transfer ----------

const vaultTokenTransferInput = {
  tokenMintAddress: solanaAddress.describe("Public key of the SPL token mint"),
  recipientTokenAccount: solanaAddress.describe(
    "Public key of the recipient's associated token account for the given mint",
  ),
  amount: z
    .number()
    .positive()
    .describe(
      "Amount of tokens to transfer in base units (e.g., 1000000 for 1 USDC)",
    ),
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
  preflight: [
    "cluster_health",
    "account_rent_exempt",
    "token_daily_cap_not_exhausted",
  ],
  // Per-mint daily cap gate (ADR-058 §2.1 / ADR-059 §6). The SOL-flavored
  // `daily_cap_not_exhausted` would read `daily_limit_lamports`, which is
  // the wrong comparand for SPL transfers (different decimal semantics). The
  // `token_daily_cap_not_exhausted` gate selects the right
  // `TokenSpendRecord` from `Vault.token_spend_records[mint]` and checks
  // both `daily_limit` and `per_tx_limit` in the mint's base units.
  preflightContext: (input) => ({
    vaultAddress: defaultVaultAddressOrUndefined(),
    tokenMint: input.tokenMintAddress,
    tokenAmountBaseUnits: BigInt(Math.round(input.amount)),
  }),
  requiresSigner: true,
  handler: wrap(handleVaultTokenTransfer),
};

// ---------- update_vault_policy ----------

const updateVaultPolicyInput = {
  dailyLimitSol: z
    .number()
    .nonnegative()
    .describe("New daily spending limit in SOL"),
  perTxLimitSol: z
    .number()
    .nonnegative()
    .describe("New per-transaction limit in SOL"),
  maxTxsPerHour: z
    .number()
    .int()
    .nonnegative()
    .describe("New max transactions per hour"),
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

// ---------- rotate_agent_identity ----------

/**
 * ADR-069 / AUD-015: zod refinement that validates a string is a syntactically
 * valid base58 Solana public key. Reuses the same `PublicKey`-construction
 * check the rest of the surface uses (`isValidPublicKey`), so the schema gate
 * matches the handler-level parse contract exactly.
 */
const zPubkey = z
  .string()
  .min(32, { message: "expected base58-encoded Solana public key" })
  .refine(isValidPublicKey, {
    message: "expected base58-encoded Solana public key",
  });

// AUD-200 / ADR-124 (path-a, symmetric closure of init): the on-chain
// `update_agent_identity` now requires an Ed25519 proof-of-control over the
// new `agent_identity`. The optional `newAgentIdentitySecretKey` field
// accepts the same union-of-shapes the init flow accepts (base58 string or
// number[64]); the schema reuses the validator the create-vault action uses
// so the boundary contract stays in lockstep across the two surfaces.
const newAgentIdentitySecretKeySchema = z
  .union([
    z
      .string()
      .min(80, {
        message:
          "newAgentIdentitySecretKey base58 string is too short for a 64-byte secret",
      })
      .max(96, {
        message:
          "newAgentIdentitySecretKey base58 string is too long for a 64-byte secret",
      })
      .describe(
        "Base58-encoded 64-byte Solana secret key for the new agent_identity. Decoded server-side and used to sign the bind message; never sent on-chain.",
      ),
    z
      .array(z.number().int().min(0).max(255))
      .length(64, {
        message:
          "newAgentIdentitySecretKey array must contain exactly 64 byte values (0..255)",
      })
      .describe(
        "JSON-style number[64] secret key for the new agent_identity. Same usage as the base58 form.",
      ),
  ])
  .optional()
  // ADR-135: MCP-client-visible field doc, formerly only in tools/vault.ts.
  .describe(
    "AUD-200 / ADR-124: optional. Base58 string or number[64] secret key for the new agent_identity. Required when `newAgentIdentity` differs from the wallet pubkey (operator-managed flow). Omit for self-bind (wallet IS the new agent_identity).",
  );

const rotateAgentIdentityInput = {
  newAgentIdentity: zPubkey.describe(
    "Base58-encoded Solana public key of the new agent_identity hot key. Must be a valid pubkey; on-chain requires an Ed25519 proof-of-control signature over `vault_identity_bind_message(authority, newAgentIdentity)` (see `newAgentIdentitySecretKey`).",
  ),
  // AUD-200 / ADR-124: optional. When omitted, the handler self-binds (new
  // agent_identity == wallet pubkey). When supplied, the handler uses the
  // secret key to produce the bind signature locally; the secret never
  // leaves the process. See `handleRotateAgentIdentity` for the full flow.
  newAgentIdentitySecretKey: newAgentIdentitySecretKeySchema,
} as const;

export const rotateAgentIdentityAction: Action<
  z.infer<z.ZodObject<typeof rotateAgentIdentityInput>>,
  unknown
> = {
  name: "rotate_agent_identity",
  title: "Rotate vault agent identity",
  description:
    "Rotate the vault's `agent_identity` hot key (ADR-069). `agent_identity` is " +
    "the off-chain agent runtime's signing key, distinct from the human-custodied " +
    "`authority`; it should be rotated on suspected compromise of the agent " +
    "runtime or on a routine cadence (suggested: 90 days). Rotation is a pure " +
    "key-swap — balances, policies, daily-spend counters, and rate-limit " +
    "counters are preserved. Only the vault `authority` (verified via `has_one` " +
    "on the on-chain context) can rotate. " +
    "AUD-200 / ADR-124 (cycle-3): the on-chain handler now requires an Ed25519 " +
    "proof-of-control signature from the holder of `newAgentIdentity`'s private " +
    "key (symmetric closure of the init-leg fix). Pass `newAgentIdentitySecretKey` " +
    "(base58 or number[64]) to bind a distinct hot key, or omit it to self-bind " +
    "to the wallet pubkey (newAgentIdentity must equal wallet.publicKey in that mode).",
  inputSchema: rotateAgentIdentityInput,
  outputSchema: z.unknown(),
  similes: ["rotate hot key", "rotate agent key", "rotate agent identity"],
  examples: [],
  readOnly: false,
  capabilities: ["sign:vault"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: wrap(handleRotateAgentIdentity),
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
  action: z
    .enum(["add_token", "remove_token", "add_program", "remove_program"])
    .describe("The allowlist operation to perform"),
  address: solanaAddress.describe(
    "Public key of the token mint or program to add/remove",
  ),
  perTxLimit: z
    .number()
    .optional()
    .describe(
      "REQUIRED for add_token. Max per-tx amount in the mint's base units.",
    ),
  dailyLimit: z
    .number()
    .optional()
    .describe(
      "REQUIRED for add_token. Max daily amount in the mint's base units. Must be >= perTxLimit.",
    ),
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

// ---------- query_execution_history (ADR-138) ----------

const queryExecutionHistoryInput = {
  agentIdentity: solanaAddress
    .optional()
    .describe(
      "Base58 agent_identity hot-key pubkey. Mutually exclusive with `vault`.",
    ),
  vault: solanaAddress
    .optional()
    .describe(
      "Base58 vault PDA. Mutually exclusive with `agentIdentity`.",
    ),
  actionKind: z
    .enum([
      "Transfer",
      "TokenTransfer",
      "PolicyUpdate",
      "AllowlistManage",
      "IdentityRotation",
      "PauseToggle",
      "GrantTransfer",
      "GrantTokenTransfer",
    ])
    .optional()
    .describe("Optional filter — limit to this action kind only."),
  toolId: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, {
      message: "toolId must be a 64-char hex SHA-256 digest",
    })
    .optional()
    .describe(
      "Optional 64-char hex SHA-256 tool_id. See `toolIdHash(name)` in `@agenomics/client`.",
    ),
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Optional lower-bound slot. Pass the previous response's `next_cursor.before_slot` to walk further into the past.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Page size (1..500, default 50)."),
} as const;

export const queryExecutionHistoryAction: Action<
  z.infer<z.ZodObject<typeof queryExecutionHistoryInput>>,
  unknown
> = {
  name: "query_execution_history",
  title: "Query execution provenance",
  description:
    "ADR-138: query the off-chain indexer for execution-provenance attestations bound to a given agent_identity or vault. Each row pins (agent_identity, authority, tool_id, manifest_hash, policy_version, action_kind, slot, amount, mint, recipient).",
  inputSchema: queryExecutionHistoryInput,
  outputSchema: z.unknown(),
  similes: ["audit log", "execution history", "provenance trail"],
  examples: [],
  readOnly: true,
  capabilities: [],
  handler: wrap(handleQueryExecutionHistory),
};

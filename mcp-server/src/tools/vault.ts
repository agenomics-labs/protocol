// ADR-135 — Vault MCP tool descriptors, DERIVED from the single-source
// Zod schemas in `actions/vault.ts`.
//
// Pre-ADR-135 this file hand-wrote a JSON Schema literal per tool that
// had to be kept in sync by hand with the Zod schema the router
// actually enforces (`actions/vault.ts`). That triple-maintenance is
// the exact drift class ADR-135 eliminates: every `inputSchema` below
// is now `renderInputSchema(<the action's Zod shape>)`, so the
// advertised contract and the runtime-enforced contract are two
// projections of ONE schema and cannot diverge.
//
// `description` strings are preserved verbatim from the pre-ADR-135
// hand-written descriptors so the `tools/list` wire response (which MCP
// clients introspect) is byte-stable; only `inputSchema` changes its
// derivation source, and the frozen snapshot in
// `test/tools/schema-snapshot.test.ts` proves the rendered schema.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { renderInputSchema } from "./render-schema.js";
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
} from "../actions/vault.js";

/**
 * Vault Tools (10) — agent wallet management with spending policies.
 * Each descriptor's `inputSchema` is derived from the corresponding
 * `actions/vault.ts` Zod schema (ADR-135 single source of truth). The
 * `description` is the pre-ADR-135 MCP-advertised text, preserved
 * verbatim for wire stability.
 */

export const createVaultTool: Tool = {
  name: "create_vault",
  description:
    "Create a new agent vault with spending policies. The vault is a programmable wallet that enforces daily limits, per-transaction limits, and rate limits. Returns the vault address. " +
    "ADR-124 (AUD-116 path-a): the on-chain handler requires an Ed25519 proof-of-control signature from the holder of `agentIdentity`'s private key over a domain-tagged message; the wrapper builds the precompile ix automatically. Pass `agentIdentitySecretKey` (base58 64-byte secret OR number[64]) to bind a distinct hot key; omit it to self-bind (agentIdentity == wallet pubkey).",
  inputSchema: renderInputSchema(createVaultAction.inputSchema),
};

export const getVaultInfoTool: Tool = {
  name: "get_vault_info",
  description:
    "Get vault balance, spending policies, daily spend tracking, and pause status. Pass a vault address or omit to use the default vault for this agent.",
  inputSchema: renderInputSchema(getVaultInfoAction.inputSchema),
};

export const vaultTransferTool: Tool = {
  name: "vault_transfer",
  description:
    "Transfer SOL from the vault to a recipient. Enforces per-tx limit, daily limit, and rate limit. The agent (wallet) must be the vault authority.",
  inputSchema: renderInputSchema(vaultTransferAction.inputSchema),
};

export const updateVaultPolicyTool: Tool = {
  name: "update_vault_policy",
  description:
    "Update the vault's spending policy: daily limit, per-tx limit, and rate limit. Only the vault authority can call this.",
  inputSchema: renderInputSchema(updateVaultPolicyAction.inputSchema),
};

export const rotateAgentIdentityTool: Tool = {
  name: "rotate_agent_identity",
  description:
    "Rotate the vault's `agent_identity` hot key (ADR-069 / AUD-015). `agent_identity` is the off-chain agent runtime's signing key, distinct from the human-custodied `authority`; it should be rotated on suspected compromise of the agent runtime or on a routine cadence (suggested: 90 days). Rotation is a pure key-swap — balances, policies, daily-spend counters, and rate-limit counters are preserved. Only the vault `authority` (verified via `has_one` on the on-chain context) can rotate. AUD-200 / ADR-124 (cycle-3, symmetric closure of init): the on-chain handler now requires an Ed25519 proof-of-control signature from the holder of `newAgentIdentity`'s private key. Pass `newAgentIdentitySecretKey` (base58 or number[64]) to bind a distinct hot key, or omit it to self-bind to the wallet pubkey (newAgentIdentity must equal wallet.publicKey in that mode).",
  inputSchema: renderInputSchema(rotateAgentIdentityAction.inputSchema),
};

export const pauseVaultTool: Tool = {
  name: "pause_vault",
  description:
    "Pause the vault. No transfers or program calls can be executed while paused. Only the vault authority can pause.",
  inputSchema: renderInputSchema(pauseVaultAction.inputSchema),
};

export const resumeVaultTool: Tool = {
  name: "resume_vault",
  description:
    "Resume a paused vault. Re-enables transfers and program calls. Only the vault authority can resume.",
  inputSchema: renderInputSchema(resumeVaultAction.inputSchema),
};

export const manageAllowlistTool: Tool = {
  name: "manage_allowlist",
  description:
    "Add or remove a token mint or program from the vault's allowlist. For action=add_token, per-mint per-tx and daily caps MUST be supplied in the mint's base units (findings #13/#14: e.g. 1_000_000 for 1 USDC at 6 decimals). Tokens without configured limits cannot be transferred. Programs in the allowlist can be invoked.",
  inputSchema: renderInputSchema(manageAllowlistAction.inputSchema),
};

export const queryExecutionHistoryTool: Tool = {
  name: "query_execution_history",
  description:
    "ADR-138: query the off-chain indexer for execution-provenance attestations bound to a given agent_identity or vault. Each row pins (agent_identity, authority, tool_id, manifest_hash, policy_version, action_kind, slot, amount, mint, recipient) — a cryptographically-verifiable record of every value-moving or authority-changing vault action. Cursor pagination via `since`; downward-walking (most-recent first).",
  inputSchema: renderInputSchema(queryExecutionHistoryAction.inputSchema),
};

export const vaultTokenTransferTool: Tool = {
  name: "vault_token_transfer",
  description:
    "Execute an SPL token transfer from the vault. The token mint must be on the vault's token allowlist. The agent (wallet) must be the vault authority.",
  inputSchema: renderInputSchema(vaultTokenTransferAction.inputSchema),
};

import { Tool } from "@modelcontextprotocol/sdk/types";

/**
 * ADR-111: Delegation Grant Tools.
 *
 * Surfaces the `agent-vault` program's delegation-grant instruction set
 * as MCP tools. A delegation grant is a bounded, auditable, time-limited
 * slice of a vault's spending authority — see the on-chain
 * `DelegationGrant` PDA in `programs/agent-vault/src/state.rs`.
 *
 * Schema-level invariants pinned across all five tools:
 *   - `nonce` is a u8 (0-255). A single (vault, grantee) pair can hold
 *     up to 256 historical grants over time; nonce reuse against an
 *     open PDA is rejected by Anchor's `init` constraint, so callers
 *     can pick any never-used value.
 *   - `allowedActions` is a bitmask: 1 = EXECUTE_TRANSFER, 2 =
 *     EXECUTE_TOKEN_TRANSFER, 0 = read-only sentinel. Composing via
 *     bitwise-OR is the supported pattern.
 *   - `expiresAtUnix` is in Unix seconds; `0` is the "no expiry"
 *     sentinel. Updates are tighten-only — see
 *     `update_delegation_grant`.
 *   - `spendCapLamports` and per-mint `cap` values MUST NOT exceed
 *     the parent vault's per-tx caps; the on-chain handler rejects
 *     with `InvalidGrantParameters` if they do.
 *   - Either the vault authority OR the grantee can revoke; updates
 *     are vault-authority-only and may only TIGHTEN scope.
 *
 * MCP wrappers MUST forward errors verbatim — the on-chain error code
 * is the canonical signal for the caller's retry logic.
 */

export const createDelegationGrantTool: Tool = {
  name: "create_delegation_grant",
  description:
    "ADR-111: Issue a delegation grant binding a sub-authority (`grantee`) to a bounded, auditable, time-limited slice of the vault's spending authority. Only the vault authority may call. The grant scope is capped by `allowedActions` (bitflags: 1=SOL transfer, 2=SPL transfer, OR them together), per-mint and SOL spend caps, an optional `allowedRecipients` list, and an `expiresAtUnix` window. The on-chain handler validates that (a) the vault is not paused, (b) the agent is not suspended (ADR-095), (c) `activeGrantCount < 32`, (d) all bounded-vec lengths fit, (e) the proposed lamport / token caps do not exceed the vault's per-tx caps, and (f) `expiresAtUnix` is either 0 or strictly in the future.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description:
          "Base58 vault PDA address. If omitted, derives from the agent's wallet pubkey.",
      },
      grantee: {
        type: "string",
        description:
          "Base58 public key of the grantee hot key. The grantee will sign `execute_grant_*` transactions; their key need not have any on-chain account.",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
        description:
          "u8 nonce — third PDA seed. Pick any value not currently bound to an open grant for this (vault, grantee) pair.",
      },
      allowedActions: {
        type: "integer",
        minimum: 0,
        maximum: 3,
        description:
          "Bitmask of authorized actions. 1 = EXECUTE_TRANSFER (SOL), 2 = EXECUTE_TOKEN_TRANSFER (SPL), 3 = both, 0 = read-only sentinel (no transfers).",
      },
      spendCapLamports: {
        type: "number",
        description:
          "Lifetime SOL spend cap, in lamports. Must be <= vault per-tx limit. Set to 0 to disable SOL grants on this grant (useful with action=2 token-only).",
      },
      tokenCaps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            mint: { type: "string", description: "Base58 SPL mint address." },
            cap: {
              type: "number",
              description:
                "Lifetime cap in the mint's base units. Must be <= vault per-tx limit for the same mint.",
            },
          },
          required: ["mint", "cap"],
        },
        description:
          "Per-mint lifetime spend caps. Empty array = no SPL transfers via this grant. Each mint MUST already be in the vault's token allowlist with configured per-tx limits.",
      },
      allowedRecipients: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional base58 recipient pubkeys. Empty array = any recipient subject to the vault's own recipient/program gates. Non-empty = grantee may ONLY transfer to a listed recipient. Bounded at 8 entries.",
      },
      expiresAtUnix: {
        type: "number",
        description:
          "Unix-seconds expiry timestamp. 0 = no expiry. Otherwise must be strictly in the future at create time.",
      },
    },
    required: [
      "grantee",
      "nonce",
      "allowedActions",
      "spendCapLamports",
      "tokenCaps",
      "allowedRecipients",
      "expiresAtUnix",
    ],
  },
};

export const revokeDelegationGrantTool: Tool = {
  name: "revoke_delegation_grant",
  description:
    "ADR-111: Revoke a delegation grant. Either the original grantor (vault authority) or the grantee may call. Idempotent — revoking an already-revoked grant succeeds without state change so off-chain clients can retry safely. Does NOT close the account; the audit-trail invariant in ADR-111 §\"revoke_delegation\" preserves the row on-chain until the future `close_delegation_grant` instruction (ADR-111b) archives expired+revoked rows ≥ 30 days old.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description:
          "Base58 vault PDA address. If omitted, derives from the agent's wallet pubkey.",
      },
      grantee: {
        type: "string",
        description:
          "Base58 public key of the grantee whose grant is being revoked.",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
        description:
          "The grant nonce supplied at create time. Required to derive the grant PDA.",
      },
    },
    required: ["grantee", "nonce"],
  },
};

export const updateDelegationGrantTool: Tool = {
  name: "update_delegation_grant",
  description:
    "ADR-111: Tighten the scope of an existing delegation grant. Vault authority only. The handler enforces a TIGHTEN-ONLY invariant: caps may only shrink (and never below the already-spent floor); action bits may only be dropped (subset of stored mask); recipient lists may only narrow; expiry may only shorten (cannot be lifted to no-expiry). Loosening attempts reject with `GrantUpdateCannotLoosen`.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description:
          "Base58 vault PDA address. If omitted, derives from the agent's wallet pubkey.",
      },
      grantee: {
        type: "string",
        description: "Base58 public key of the grantee whose grant is being updated.",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
        description: "Grant nonce — required for PDA derivation.",
      },
      newAllowedActions: {
        type: "integer",
        minimum: 0,
        maximum: 3,
        description:
          "Updated action bitmask. MUST be a subset of the stored mask; adding a bit rejects.",
      },
      newSpendCapLamports: {
        type: "number",
        description:
          "Updated lifetime SOL cap. MUST be <= stored cap AND >= already-spent.",
      },
      newTokenCaps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            mint: { type: "string" },
            cap: { type: "number" },
          },
          required: ["mint", "cap"],
        },
        description:
          "Updated per-mint caps. Each entry's mint MUST already exist in the stored token caps (no new mints), and each cap MUST tighten (<= stored AND >= per-mint spent).",
      },
      newAllowedRecipients: {
        type: "array",
        items: { type: "string" },
        description:
          "Updated recipient list. Every entry MUST already be in the stored list (no new recipients). If the stored list is non-empty, the new list MUST also be non-empty (can't widen to wildcard).",
      },
      newExpiresAtUnix: {
        type: "number",
        description:
          "Updated expiry. If the stored expiry is 0 (no-expiry), any value is a tightening. If the stored expiry is non-zero, this MUST be non-zero AND <= stored.",
      },
    },
    required: [
      "grantee",
      "nonce",
      "newAllowedActions",
      "newSpendCapLamports",
      "newTokenCaps",
      "newAllowedRecipients",
      "newExpiresAtUnix",
    ],
  },
};

export const executeGrantTransferTool: Tool = {
  name: "execute_grant_transfer",
  description:
    "ADR-111: SOL transfer signed by a delegation grantee. Applies BOTH the grant's bounded scope (spend cap, recipient set, expiry, action bit) AND the parent vault's policy (per-tx limit, daily limit, rate limit, pause flag, ADR-095 suspension gate). Grant caps are ADDITIONAL to vault caps, never a replacement — a transfer accepted by the grant but blocked by the vault's per-tx cap still rejects. The wallet signing this MCP call MUST be the grantee.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description: "Base58 vault PDA address.",
      },
      grantee: {
        type: "string",
        description:
          "Base58 public key of the grantee. Defaults to the wallet pubkey (the signer of the MCP-issued tx).",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
        description: "Grant nonce — required for PDA derivation.",
      },
      recipientAddress: {
        type: "string",
        description:
          "Base58 SOL recipient. Must satisfy `grant.allowed_recipients` (empty list = wildcard).",
      },
      amountLamports: {
        type: "number",
        description: "Transfer amount in lamports. Must be > 0.",
      },
    },
    required: ["vaultAddress", "nonce", "recipientAddress", "amountLamports"],
  },
};

export const executeGrantTokenTransferTool: Tool = {
  name: "execute_grant_token_transfer",
  description:
    "ADR-111: SPL transfer signed by a delegation grantee. Same dual-gating shape as `execute_grant_transfer` but against per-mint caps (`GrantTokenCap`) and the vault's `token_spend_records`. The vault PDA signs the CPI to the token program; the grantee signs the outer transaction.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: { type: "string", description: "Base58 vault PDA address." },
      grantee: {
        type: "string",
        description:
          "Base58 grantee pubkey. Defaults to the wallet pubkey.",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
      },
      tokenMintAddress: {
        type: "string",
        description:
          "Base58 SPL mint address. Must be in BOTH the vault's token allowlist AND the grant's `token_spend_caps`.",
      },
      recipientTokenAccount: {
        type: "string",
        description: "Base58 recipient associated token account.",
      },
      amount: {
        type: "number",
        description: "Transfer amount in the mint's base units.",
      },
    },
    required: [
      "vaultAddress",
      "nonce",
      "tokenMintAddress",
      "recipientTokenAccount",
      "amount",
    ],
  },
};

export const getDelegationGrantTool: Tool = {
  name: "get_delegation_grant",
  description:
    "ADR-111: Fetch and decode a `DelegationGrant` PDA. Returns the full account projection — vault, grantor, grantee, allowed_actions, spend_cap_lamports, spent_lamports, token_spend_caps, allowed_recipients, expires_at, revoked, created_at, nonce. Useful for off-chain validators / dashboards verifying a grant's outstanding remaining cap before issuing an `execute_grant_*` call.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description: "Base58 vault PDA address.",
      },
      grantee: {
        type: "string",
        description: "Base58 grantee pubkey.",
      },
      nonce: {
        type: "integer",
        minimum: 0,
        maximum: 255,
      },
    },
    required: ["vaultAddress", "grantee", "nonce"],
  },
};

export const listDelegationGrantsForVaultTool: Tool = {
  name: "list_delegation_grants_for_vault",
  description:
    "ADR-111: Enumerate every `DelegationGrant` PDA bound to a vault, including revoked ones (revoked grants stay on-chain for audit-trail per ADR-111 §\"revoke_delegation\"). Uses an Anchor `memcmp` filter against the grant's `vault` field at byte offset 8.",
  inputSchema: {
    type: "object",
    properties: {
      vaultAddress: {
        type: "string",
        description: "Base58 vault PDA address.",
      },
      includeRevoked: {
        type: "boolean",
        description:
          "If true (default), include revoked grants in the result for audit-trail visibility. If false, filter them out client-side.",
      },
    },
    required: ["vaultAddress"],
  },
};

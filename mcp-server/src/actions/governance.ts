// Governance Actions — protocol-wide instructions whose signer is the
// upgrade-authority / multisig rather than a domain-scoped admin.
//
// AUD-206 (cycle-3, roadmap §3 B2): typed MCP-tool wrapper for
// `verify_protocol_invariants` (Registry program). The on-chain ix sweeps
// a batch of `AgentProfile` accounts and re-runs `assert_valid_profile`
// over each; any violation panic-reverts the transaction. Today operators
// can only call it via raw Anchor RPC; this action exposes it through the
// standard MCP surface so the upgrade authority (and the multisig once
// roadmap §2 A2 lands) can invoke it from agent tooling.
//
// Bounded by the AUD-106 batch cap (MAX_INVARIANT_BATCH = 16). The cap is
// enforced TWICE — at the zod schema layer (this file) and at the on-chain
// `require!` (programs/agent-registry/src/lib.rs). The schema-layer check
// is load-bearing: a >16-account batch never reaches the RPC, so we don't
// burn a tx slot on a guaranteed revert.

import { z } from "zod";
import type { Action } from "../types/action.js";
import { ok, err } from "../types/action.js";
import {
  loadWallet,
  getRegistryProgram,
  deriveProtocolConfigPDA,
  parsePublicKey,
  isValidPublicKey,
} from "../solana.js";

// ---------- shared schema fragments ----------

/**
 * AUD-206 / AUD-015: zod refinement for a syntactically valid base58 Solana
 * pubkey. Mirrors `actions/vault.ts#zPubkey` so the schema gate matches
 * the handler-level parse contract exactly.
 */
const zPubkey = z
  .string()
  .min(32, { message: "expected base58-encoded Solana public key" })
  .refine(isValidPublicKey, {
    message: "expected base58-encoded Solana public key",
  });

/**
 * AUD-106 (cycle-2): per-call cap on the number of `AgentProfile` accounts
 * passed to `verify_protocol_invariants`. Mirrors `MAX_INVARIANT_BATCH` in
 * `programs/agent-registry/src/lib.rs`. If this constant ever changes
 * on-chain, the schema below must be bumped in lockstep and the
 * `governance.test.ts` boundary cases retuned.
 */
export const MAX_INVARIANT_BATCH = 16 as const;

// ---------- verify_protocol_invariants ----------

/**
 * AUD-206 / AUD-106: the `accounts` array is the batch of `AgentProfile`
 * PDAs to sweep. The batch cap is enforced HERE at the schema level (zod
 * `.max(16)`) so an oversized batch is rejected as INVALID_INPUT before
 * any RPC is attempted — the on-chain `MAX_INVARIANT_BATCH` check is the
 * second wall (defence-in-depth). `.min(1)` is an MCP-layer convenience:
 * the on-chain ix is a no-op for an empty `remaining_accounts` slice but
 * spending a transaction on zero work is always an operator error.
 */
const verifyProtocolInvariantsInput = {
  // ADR-135: `.describe()` carries the MCP-client-visible field docs
  // that pre-ADR-135 lived only in the hand-written tools/governance.ts
  // JSON Schema. The min/max bounds were already router-enforced here.
  accounts: z
    .array(zPubkey.describe("Base58-encoded `AgentProfile` PDA pubkey"))
    .min(1, {
      message: "verify_protocol_invariants requires at least 1 profile account",
    })
    .max(MAX_INVARIANT_BATCH, {
      message: `verify_protocol_invariants batch must not exceed MAX_INVARIANT_BATCH (${MAX_INVARIANT_BATCH}); slice into smaller calls (AUD-106)`,
    })
    .describe(
      `Batch of agent-profile PDAs to sweep (1-${MAX_INVARIANT_BATCH}). ` +
        "AUD-106: the on-chain handler enforces the same upper bound.",
    ),
} as const;

type VerifyProtocolInvariantsInput = z.infer<
  z.ZodObject<typeof verifyProtocolInvariantsInput>
>;

/**
 * Build and submit the `verify_protocol_invariants` ix. The signer is
 * sourced from the upgrade-authority-bearing wallet wired into the MCP
 * server (`loadWallet()` — same singleton every other registry handler
 * uses; for AUD-206 deployment the operator MUST configure
 * `ANCHOR_WALLET` / `SOLANA_KEYPAIR_PATH` to point at the
 * `ProtocolConfig.authority` keypair, otherwise the on-chain
 * `Unauthorized` check will fire).
 *
 * The protocol_config PDA is derived from the Settlement program (per the
 * Anchor context's `seeds::program = SETTLEMENT_PROGRAM_ID`); the helper
 * lives in `solana.ts#deriveProtocolConfigPDA`.
 *
 * Each profile pubkey is appended via `.remainingAccounts([...])` with
 * `isSigner=false, isWritable=false` — the on-chain handler only reads
 * each account (Borsh deserialise + invariant assertion). Marking them
 * non-writable also keeps the tx fee minimal and reduces lock contention
 * on the simulated bank.
 */
async function buildAndSendVerifyProtocolInvariants(
  input: VerifyProtocolInvariantsInput,
): Promise<{
  success: true;
  protocolConfigAddress: string;
  authority: string;
  batchSize: number;
  accounts: string[];
  transactionSignature: string;
}> {
  const wallet = loadWallet();
  const program = getRegistryProgram();
  const [protocolConfigPDA] = deriveProtocolConfigPDA();

  // Schema already validated each entry as base58; `parsePublicKey` is a
  // belt-and-braces re-parse so the on-the-wire `PublicKey` instances
  // come from the same code path the rest of the surface uses.
  const remaining = input.accounts.map((addr) => ({
    pubkey: parsePublicKey(addr),
    isSigner: false,
    isWritable: false,
  }));

  const sig = await program.methods
    .verifyProtocolInvariants()
    .accountsPartial({
      authority: wallet.publicKey,
      protocolConfig: protocolConfigPDA,
    })
    .remainingAccounts(remaining)
    .signers([wallet])
    .rpc();

  return {
    success: true,
    protocolConfigAddress: protocolConfigPDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    batchSize: input.accounts.length,
    accounts: input.accounts,
    transactionSignature: sig,
  };
}

export const verifyProtocolInvariantsAction: Action<
  VerifyProtocolInvariantsInput,
  unknown
> = {
  name: "verify_protocol_invariants",
  title: "Verify protocol invariants (batch sweep)",
  description:
    "Run the post-migration / governance invariant sweep over a batch of " +
    `agent-profile accounts. Re-deserialises each profile and runs ` +
    "`assert_valid_profile` on-chain; any violation reverts the transaction " +
    "(making the failure loud and the offending account index visible in " +
    "program logs). The batch is hard-capped at " +
    `${MAX_INVARIANT_BATCH} accounts per call (AUD-106) — slice large ` +
    "sweeps into multiple calls. On-chain authorization is " +
    "`ProtocolConfig.authority` (Settlement program); the MCP-layer claim " +
    "`gov:invariant:check` is the default-deny wall (ADR-058 §4).",
  inputSchema: verifyProtocolInvariantsInput,
  outputSchema: z.unknown(),
  similes: ["sweep invariants", "post-migration check", "governance audit"],
  examples: [],
  readOnly: false,
  capabilities: ["gov:invariant:check"],
  preflight: ["cluster_health"],
  requiresSigner: true,
  handler: async (_ctx, input) => {
    try {
      return ok(await buildAndSendVerifyProtocolInvariants(input));
    } catch (e) {
      return err({
        code: "PROGRAM_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

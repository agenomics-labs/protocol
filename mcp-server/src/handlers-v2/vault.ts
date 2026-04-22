/**
 * ADR-012 / ADR-033 / PR7 — v2 (Kit-native) vault_transfer handler.
 *
 * This proves the end-to-end v2 path for ONE action so we can validate the
 * full pipeline (Kit RPC → compute-budget → signer → send+confirm) before
 * migrating the rest of the surface. The v1 handler in
 * `src/handlers/vault.ts:handleVaultTransfer` is untouched; operators opt in
 * via `AEP_USE_V2_VAULT_TRANSFER=1` (see `src/actions/vault.ts`).
 *
 * On-chain target: `execute_transfer(amount_lamports: u64)` on the
 * `agent_vault` program (id `4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN`).
 * Account layout (from `programs/agent-vault/src/contexts.rs::ExecuteTransfer`):
 *   0. vault          — WRITABLE  (PDA, seeds=["vault", authority])
 *   1. agent          — READONLY_SIGNER  (authority keypair)
 *   2. recipient      — WRITABLE  (system-owned recipient)
 *   3. system_program — READONLY
 *
 * Note on Anchor discriminator:
 *   The Rust function name is `execute_transfer` (see
 *   `programs/agent-vault/src/lib.rs`). Anchor derives its ix discriminator
 *   from the snake_case function name as `sha256("global:execute_transfer")[..8]`.
 *   The MCP-facing action is called `vault_transfer` — that is the
 *   user-facing action name, not the discriminator input. We document both
 *   to avoid any confusion.
 */

import {
  createTransactionMessage,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  compileTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  AccountRole,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import * as crypto from "crypto";

import {
  deriveVaultPDA,
  loadWallet,
  parsePublicKey,
  publicKeyToAddress,
  solToLamports,
} from "../solana.js";
import {
  createRpc,
  createRpcSubscriptions,
  VAULT_PROGRAM_ADDRESS,
} from "../solana-v2.js";
import {
  getComputeBudgetInstructions,
  setTransactionMessageComputeUnitPrice,
  type ComputeBudgetRpc,
  type SimulateForCuThunk,
} from "../pipeline/compute-budget.js";
import {
  sendAndConfirmWithBlockhashExpiry,
  type SignedTransactionLike,
} from "../pipeline/confirm.js";
import { createKeypairSignerFromV1Keypair } from "./keypair-signer.js";
import type { Result } from "../types/action.js";
import { ok, err } from "../types/action.js";

// ==================== CONSTANTS ====================

/**
 * System Program Address (v2-brand). Equal to v1
 * `SystemProgram.programId.toBase58()`.
 */
export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

// ==================== ANCHOR INSTRUCTION ENCODING ====================

/**
 * Compute the Anchor 8-byte ix discriminator for a namespaced name.
 *
 * Anchor uses `sha256("global:" + fn_name)[..8]` where `fn_name` is the
 * snake_case Rust function name. For this handler that is `execute_transfer`.
 */
export function anchorDiscriminator(namespaced: string): Uint8Array {
  const hash = crypto.createHash("sha256").update(namespaced).digest();
  return new Uint8Array(hash.slice(0, 8));
}

/**
 * Encode a u64 little-endian into a Uint8Array (8 bytes).
 */
export function encodeU64Le(value: bigint | number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), true);
  return buf;
}

/**
 * Build the raw ix data for `execute_transfer(amount_lamports: u64)`.
 *   layout: [disc(8) || amount_lamports(u64 LE)]
 */
export function encodeExecuteTransferData(amountLamports: bigint): Uint8Array {
  const disc = anchorDiscriminator("global:execute_transfer");
  const amt = encodeU64Le(amountLamports);
  const out = new Uint8Array(disc.length + amt.length);
  out.set(disc, 0);
  out.set(amt, disc.length);
  return out;
}

// ==================== INPUT ====================

export interface VaultTransferV2Input {
  readonly recipientAddress: string;
  readonly amountSol: number;
}

export interface VaultTransferV2Output {
  readonly success: true;
  readonly vaultAddress: string;
  readonly recipient: string;
  readonly amountSol: number;
  readonly transactionSignature: string;
  readonly computeUnitLimit: number;
  readonly simulatedUnitsConsumed: number;
  readonly priorityMicroLamports: string; // bigint serialized
  readonly v2: true;
}

// ==================== INJECTABLE DEPENDENCIES (TEST SEAM) ====================

/**
 * Minimal RPC surface required by this handler. Kept narrow so tests can
 * supply a hand-built stub without faking every Kit method.
 *
 * The real Kit RPC (`createRpc()` from `solana-v2.ts`) is assignable to this
 * shape — the shape is a structural subset.
 */
export interface VaultTransferV2Rpc extends ComputeBudgetRpc {
  getLatestBlockhash(): { send(): Promise<{ value: { blockhash: string; lastValidBlockHeight: bigint } }> };
  simulateTransaction(
    base64Wire: string,
    config: { encoding: "base64"; sigVerify: false; replaceRecentBlockhash?: false },
  ): { send(): Promise<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: bigint } }> };
}

/**
 * Send-and-confirm callback injected by the caller. In production this is
 * wired to `sendAndConfirmTransactionFactory` from Kit. In tests it is a
 * stub that records the wire bytes and returns.
 */
export type SendAndConfirm = (signed: SignedTransactionLike) => Promise<void>;

export interface VaultTransferV2Deps {
  readonly rpc: VaultTransferV2Rpc;
  readonly signer: ReturnType<typeof createKeypairSignerFromV1Keypair>;
  readonly authorityAddress: Address;
  readonly vaultAddress: Address;
  /** Send-and-confirm function; receives the signed wire tx. */
  readonly sendAndConfirm: SendAndConfirm;
  /** Optional: override max retries for the confirm loop (default 2). */
  readonly maxRetries?: number;
}

// ==================== PUBLIC HANDLER ====================

/**
 * v2 handler for `vault_transfer` (maps to on-chain `execute_transfer`).
 *
 * The default-deps overload reads from `loadWallet()` + `createRpc()`. The
 * overload that takes `deps` is used by tests and by any call site that
 * needs to inject a different wallet / mocked RPC.
 *
 * Returns a `Result` conforming to ADR-058 §7 — all error paths are typed.
 */
export async function handleVaultTransferV2(
  input: VaultTransferV2Input,
  depsOverride?: Partial<VaultTransferV2Deps>,
): Promise<Result<VaultTransferV2Output>> {
  try {
    // ---- Input validation -----------------------------------------------
    if (
      typeof input.recipientAddress !== "string" ||
      input.recipientAddress.length === 0
    ) {
      return err({ code: "INVALID_INPUT", message: "recipientAddress required" });
    }
    if (typeof input.amountSol !== "number" || !(input.amountSol > 0)) {
      return err({
        code: "INVALID_INPUT",
        message: "amountSol must be a positive number",
      });
    }

    // Parse recipient via v1 helper — validates base58 + curve position.
    const recipientPk = parsePublicKey(input.recipientAddress);
    const recipientAddr = publicKeyToAddress(recipientPk);
    const amountLamports = BigInt(solToLamports(input.amountSol));

    // ---- Resolve deps ---------------------------------------------------
    const deps = resolveDeps(depsOverride);

    // ---- Build the vault_transfer (execute_transfer) instruction -------
    const ixData = encodeExecuteTransferData(amountLamports);
    const executeTransferIx: Instruction = {
      programAddress: VAULT_PROGRAM_ADDRESS,
      accounts: [
        { address: deps.vaultAddress, role: AccountRole.WRITABLE },
        { address: deps.authorityAddress, role: AccountRole.READONLY_SIGNER },
        { address: recipientAddr, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ],
      data: ixData,
    };

    // ---- Fetch blockhash ------------------------------------------------
    const { value: bh } = await deps.rpc.getLatestBlockhash().send();
    const blockhashLifetime = {
      blockhash: bh.blockhash as Blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
    } as const;

    // ---- Compose message (sans compute-budget) --------------------------
    // We build the message twice:
    //   1. First with ONLY execute_transfer, so we can simulate it and size
    //      the compute-budget.
    //   2. Then we prepend the compute-budget IXs and finalize.
    //
    // This mirrors the canonical Kit pipe pattern in @solana/kit's doc
    // examples.
    const baseMessage = (() => {
      let m: ReturnType<typeof createTransactionMessage> =
        createTransactionMessage({ version: 0 });
      m = setTransactionMessageFeePayerSigner(
        deps.signer as unknown as Parameters<typeof setTransactionMessageFeePayerSigner>[0],
        m,
      ) as any;
      m = setTransactionMessageLifetimeUsingBlockhash(blockhashLifetime, m) as any;
      m = appendTransactionMessageInstruction(executeTransferIx, m) as any;
      return m;
    })();

    // ---- Compute-budget: simulate-then-size + priority fee --------------
    const simulate: SimulateForCuThunk = async () => {
      // Compile (unsigned) + base64-encode for sigVerify-off simulation.
      const compiled = compileTransaction(baseMessage as any);
      const wire = getBase64EncodedWireTransaction(compiled as any);
      const sim = await deps.rpc
        .simulateTransaction(wire, { encoding: "base64", sigVerify: false })
        .send();
      return { unitsConsumed: sim.value.unitsConsumed ?? 0n };
    };

    const cb = await getComputeBudgetInstructions({
      rpc: deps.rpc,
      simulate,
      writableAccounts: [deps.vaultAddress, recipientAddr],
      tier: "mid",
    });

    // ---- Finalize message with compute-budget prepended -----------------
    // NOTE: `appendTransactionMessageInstructions` here effectively puts the
    // CU ixs in FRONT of execute_transfer because we rebuild from an empty
    // message. ADR-059 §2 requires CU budget before the program ix.
    let finalMessage: any = createTransactionMessage({ version: 0 });
    finalMessage = setTransactionMessageFeePayerSigner(
      deps.signer as unknown as Parameters<typeof setTransactionMessageFeePayerSigner>[0],
      finalMessage,
    );
    finalMessage = setTransactionMessageLifetimeUsingBlockhash(
      blockhashLifetime,
      finalMessage,
    );
    finalMessage = appendTransactionMessageInstructions(
      [cb.setComputeUnitLimit, executeTransferIx],
      finalMessage,
    );
    // Apply the compute-unit price using Kit's message helper (fee is
    // expressed in micro-lamports per CU and is applied as a dedicated ix).
    if (cb.priorityMicroLamports > 0n) {
      finalMessage = setTransactionMessageComputeUnitPrice(
        cb.priorityMicroLamports,
        finalMessage,
      );
    }

    // ---- Sign + send + confirm -----------------------------------------
    const buildAndSign = async (): Promise<SignedTransactionLike> => {
      const signed = await signTransactionMessageWithSigners(finalMessage);
      return signed as unknown as SignedTransactionLike;
    };

    const confirmResult = await sendAndConfirmWithBlockhashExpiry(
      buildAndSign,
      {
        maxRetries: deps.maxRetries ?? 2,
        sendAndConfirm: deps.sendAndConfirm,
      },
    );

    if (!confirmResult.ok) return confirmResult as Result<VaultTransferV2Output>;

    // ---- Shape output ---------------------------------------------------
    return ok<VaultTransferV2Output>({
      success: true,
      vaultAddress: deps.vaultAddress.toString(),
      recipient: recipientAddr.toString(),
      amountSol: input.amountSol,
      transactionSignature: confirmResult.data,
      computeUnitLimit: cb.computedUnitLimit,
      simulatedUnitsConsumed: cb.simulatedUnitsConsumed,
      priorityMicroLamports: cb.priorityMicroLamports.toString(),
      v2: true,
    });
  } catch (e) {
    return err({
      code: "PROGRAM_ERROR",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ==================== INTERNAL: default deps wiring ====================

/**
 * Build the production `SendAndConfirm` callable backed by Kit's
 * `sendAndConfirmTransactionFactory`. Construction is deferred to the first
 * invocation so:
 *
 *   (a) the WS client (and any env-lookup errors) are materialized lazily —
 *       tests that pass their own `sendAndConfirm` never touch the network;
 *   (b) a synchronous factory-construction failure is caught inside the
 *       confirm pipeline and surfaced as a typed `RPC_ERROR` through
 *       `sendAndConfirmWithBlockhashExpiry` rather than as a generic
 *       `PROGRAM_ERROR` from the outer handler try/catch.
 *
 * The factory's own `SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED` expiry error is
 * detected upstream by `isBlockHeightExceeded` and drives the retry loop.
 *
 * NOTE: Kit 6.8 signature (verified against
 *   mcp-server/node_modules/@solana/kit/dist/types/send-and-confirm-transaction.d.ts):
 *     sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })
 *       → (transaction, { commitment, ... }) => Promise<void>
 */
export function buildDefaultSendAndConfirm(
  rpc: VaultTransferV2Rpc,
): SendAndConfirm {
  let cached: ((tx: unknown, cfg: unknown) => Promise<void>) | null = null;
  return async (signed: SignedTransactionLike): Promise<void> => {
    if (!cached) {
      cached = sendAndConfirmTransactionFactory({
        // The structural VaultTransferV2Rpc subset is a proper narrowing of
        // Kit's full RPC; the factory only reaches for GetSignatureStatusesApi +
        // SendTransactionApi + GetEpochInfoApi at call time.
        rpc: rpc as unknown as Parameters<typeof sendAndConfirmTransactionFactory>[0]["rpc"],
        rpcSubscriptions: createRpcSubscriptions() as unknown as Parameters<
          typeof sendAndConfirmTransactionFactory
        >[0]["rpcSubscriptions"],
      }) as unknown as (tx: unknown, cfg: unknown) => Promise<void>;
    }
    // `signed` is a `FullySignedTransaction & TransactionWithLastValidBlockHeight`
    // produced by `signTransactionMessageWithSigners` over a message that
    // already had its blockhash lifetime set. The factory consumes it verbatim.
    return cached(signed, { commitment: "confirmed" });
  };
}

function resolveDeps(override?: Partial<VaultTransferV2Deps>): VaultTransferV2Deps {
  // Default wallet / signer / PDAs derived from the existing v1 path so
  // there is NO duplicate keypair / PDA logic. This is the seam ADR-012
  // calls for.
  const wallet = override?.signer || override?.authorityAddress
    ? null
    : loadWallet();

  const signer =
    override?.signer ??
    createKeypairSignerFromV1Keypair(wallet!);

  const authorityAddress =
    override?.authorityAddress ??
    publicKeyToAddress(wallet!.publicKey);

  const vaultAddress =
    override?.vaultAddress ??
    (() => {
      const [pda] = deriveVaultPDA(wallet!.publicKey);
      return publicKeyToAddress(pda);
    })();

  const rpc = override?.rpc ?? (createRpc() as unknown as VaultTransferV2Rpc);

  const sendAndConfirm =
    override?.sendAndConfirm ?? buildDefaultSendAndConfirm(rpc);

  return {
    rpc,
    signer,
    authorityAddress,
    vaultAddress,
    sendAndConfirm,
    maxRetries: override?.maxRetries,
  };
}

/**
 * Convenience: expose the internal instruction-building path so the action
 * wrapper (or tests) can assemble the ix without going through the full
 * send pipeline.
 */
export function buildExecuteTransferInstruction(
  vaultAddress: Address,
  authorityAddress: Address,
  recipientAddress: Address,
  amountLamports: bigint,
): Instruction {
  return {
    programAddress: VAULT_PROGRAM_ADDRESS,
    accounts: [
      { address: vaultAddress, role: AccountRole.WRITABLE },
      { address: authorityAddress, role: AccountRole.READONLY_SIGNER },
      { address: recipientAddress, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: encodeExecuteTransferData(amountLamports),
  };
}

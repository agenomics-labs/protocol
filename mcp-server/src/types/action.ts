// Core type abstractions per ADR-058. Changes here require updating ADR-058 §2 / §2.1 first.

import type { z, ZodRawShape, ZodType } from "zod";
import type { PublicKey } from "@solana/web3.js";
import type { TransactionSigner } from "@solana/kit";
import type { Capability, PreflightGate } from "./capability.js";
import type { PreflightInputContext } from "../pipeline/preflight-types.js";

export type SigningMode = "signed" | "passthrough";

export interface CapabilityBearingWallet {
  publicKey: PublicKey;
  capabilities: Set<Capability>;
}

/**
 * ADR-012 / PR2: `signer` is now typed against the @solana/kit surface.
 *
 * We union with `unknown` so existing call sites that still pass `{}` or
 * `null` (from PR1) keep type-checking until PR3 wires
 * `@solana/keychain-core` signers through the MCP context. Once every
 * call site constructs a real `TransactionSigner`, drop the `| unknown`.
 */
export type SolanaSigner = TransactionSigner;

export interface ActionContext {
  mode: SigningMode;
  wallet: CapabilityBearingWallet;
  signer: SolanaSigner | unknown | null;
}

export type AepErrorCode =
  | "CAPABILITY_MISSING"
  | "SIGNER_UNAVAILABLE"
  | "PREFLIGHT_FAILED"
  | "INVALID_INPUT"
  | "RPC_ERROR"
  | "PROGRAM_ERROR"
  | "IDEMPOTENCY_VIOLATION"
  | "UNKNOWN";

export interface AepError {
  code: AepErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T, E = AepError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(error: AepError): Result<T> => ({ ok: false, error });

export interface Example {
  description: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface Action<I = unknown, O = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema: ZodType<O>;

  similes: string[];
  examples: Example[];

  readOnly: boolean;
  capabilities: Capability[];
  preflight?: PreflightGate[];
  /**
   * Optional per-input preflight context provider. Called at dispatch time
   * to extract the narrow subset of state-lookup inputs each gate requires
   * (e.g. `vaultAddress` + `amountLamports` for `daily_cap_not_exhausted`,
   * `escrowAddress` for `dispute_window_open`). See
   * `pipeline/preflight.ts#PreflightInputContext` for the supported fields.
   *
   * If a declared gate requires a field and `preflightContext` is missing
   * or returns an object without it, the gate fails with PREFLIGHT_FAILED —
   * that's a programmer error (action declares a gate but doesn't plumb
   * its inputs) and we surface it loudly rather than silently bypass.
   */
  preflightContext?: (input: I) => PreflightInputContext;

  idempotent?: boolean;
  idempotencyKey?: (input: I) => string;

  requiresSigner?: boolean;

  handler: (ctx: ActionContext, input: I) => Promise<Result<O>>;
}

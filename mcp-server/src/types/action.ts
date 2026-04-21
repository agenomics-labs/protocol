// Core type abstractions per ADR-058. Changes here require updating ADR-058 §2 / §2.1 first.

import type { z, ZodRawShape, ZodType } from "zod";
import type { PublicKey } from "@solana/web3.js";
import type { Capability, PreflightGate } from "./capability.js";

export type SigningMode = "signed" | "passthrough";

export interface CapabilityBearingWallet {
  publicKey: PublicKey;
  capabilities: Set<Capability>;
}

export interface ActionContext {
  mode: SigningMode;
  wallet: CapabilityBearingWallet;
  signer: unknown | null;
}

export type AeapErrorCode =
  | "CAPABILITY_MISSING"
  | "SIGNER_UNAVAILABLE"
  | "PREFLIGHT_FAILED"
  | "INVALID_INPUT"
  | "RPC_ERROR"
  | "PROGRAM_ERROR"
  | "IDEMPOTENCY_VIOLATION"
  | "UNKNOWN";

export interface AeapError {
  code: AeapErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type Result<T, E = AeapError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = <T = never>(error: AeapError): Result<T> => ({ ok: false, error });

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

  idempotent?: boolean;
  idempotencyKey?: (input: I) => string;

  requiresSigner?: boolean;

  handler: (ctx: ActionContext, input: I) => Promise<Result<O>>;
}

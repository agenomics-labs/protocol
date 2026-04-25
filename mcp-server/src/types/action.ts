// Core type abstractions per ADR-058. Changes here require updating ADR-058 §2 / §2.1 first.
//
// ADR-103 (PR-T, AUD-013): the canonical `Result<T, E>` shape, plus the
// `ok`/`err` constructors, are sourced from `@agenomics/action-runtime`.
// Field name is `value` (not `data`); error type defaults to `Error`. The
// `AepError` interface declared below is preserved as a structural error
// type — every `{ code, message, details? }` POJO continues to satisfy
// it, including those reconstructed by JSON deserialization in the
// idempotency-redis path. The action-runtime `err<E>(error: E)` helper
// is fully generic, so passing an `AepError` literal binds `E = AepError`
// without further plumbing.

import type { z, ZodRawShape, ZodType } from "zod";
import type { PublicKey } from "@solana/web3.js";
import type { TransactionSigner } from "@solana/kit";
import type { Capability, PreflightGate } from "./capability.js";
import type { PreflightInputContext } from "../pipeline/preflight-types.js";

// Canonical Result shape + helpers — ADR-103. Re-exported here so existing
// callsites (`import { ok, err } from "../types/action.js"`) keep working.
//
// `ok` is re-exported directly from `@agenomics/action-runtime`. For the
// type, we narrow the default error parameter to `AepError` so existing
// `Result<O>` annotations (which omit the error type) continue to bind
// `E = AepError`. The underlying union shape is identical to action-
// runtime's canonical `{ ok: true; value: T } | { ok: false; error: E }`.
//
// `err` is wrapped with an `AepError` type bound so the 40+ existing
// call sites that pass `{ code, message, details }` literals continue to
// type-check (TypeScript otherwise widens the literal's `code` field to
// `string`, losing the `AepErrorCode` constraint that the canonical
// generic `err<E>(error: E)` would happily accept). Callers that want a
// different error type can call the runtime helper directly via
// `import { err as errRaw } from "@agenomics/action-runtime"`.
export { ok } from "@agenomics/action-runtime";
import { err as _errRuntime } from "@agenomics/action-runtime";
import type { Result as CanonicalResult } from "@agenomics/action-runtime";

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

/**
 * Structured error contract for AEP actions. Preserved across the
 * ADR-103 unification (PR-T) so that `error.code` / `error.message` /
 * `error.details` consumers — and the JSON wire format used by
 * `pipeline/idempotency-redis.ts` — keep working.
 *
 * `AepError` is intentionally a structural interface (POJO shape), not
 * a class extending `Error`: the redis idempotency layer round-trips
 * results via `JSON.stringify` / `JSON.parse`, which would strip
 * non-enumerable `Error` properties on a class form. Use the action-
 * runtime `err()` helper to construct: `err<AepError>({ code, message })`.
 */
export interface AepError {
  code: AepErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * `Result<T, E>` — re-export of the canonical `@agenomics/action-runtime`
 * Result with the default error parameter narrowed to `AepError` to
 * match this package's historical convention. Use `Result<T, Error>`
 * (or any other `E`) explicitly when interoperating with callers that
 * surface plain `Error` instances.
 */
export type Result<T, E = AepError> = CanonicalResult<T, E>;

/**
 * `err()` — failure constructor with the error type bound to `AepError`.
 * Callers pass an `AepError` literal `{ code, message, details? }` and
 * receive a `Result<never, AepError>` that fits any `Result<T, AepError>`
 * (including `Result<T>` thanks to the default above). Delegates to the
 * canonical `@agenomics/action-runtime` runtime helper.
 */
export const err = (error: AepError): Result<never, AepError> =>
  _errRuntime<AepError>(error);

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

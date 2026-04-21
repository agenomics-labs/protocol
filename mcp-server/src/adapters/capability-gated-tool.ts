// Wraps an Action<I, O> with default-deny capability check (ADR-058 §4),
// signer-mode assertion (ADR-058 §5), preflight gate execution
// (ADR-059 §6), and idempotency mutex (ADR-059 §5).

import type { Action } from "../types/action.js";
import { err } from "../types/action.js";
import type { Result } from "../types/action.js";
import {
  executePreflight,
  type PreflightDeps,
} from "../pipeline/preflight.js";
import {
  getIdempotencyStore,
  type IdempotencyStore,
} from "../pipeline/idempotency.js";

/**
 * Optional wiring knobs — primarily for tests. Production call sites use
 * the defaults (module-level singleton idempotency store; empty preflight
 * deps since gate RPCs are opt-in and stub gates PASS).
 */
export interface CapabilityGatedOptions {
  preflightDeps?: PreflightDeps;
  idempotencyStore?: IdempotencyStore;
}

export function capabilityGated<I, O>(
  action: Action<I, O>,
  options: CapabilityGatedOptions = {},
): Action<I, O> {
  // Registration-time validation (ADR-058 §3 default-deny + ADR-059 §5 idempotency spec)
  if (!action.readOnly && action.capabilities.length === 0) {
    throw new Error(
      `action '${action.name}': default-deny requires non-empty capabilities[] when readOnly:false (ADR-058 §3)`,
    );
  }
  if (action.idempotent === true && typeof action.idempotencyKey !== "function") {
    throw new Error(
      `action '${action.name}': idempotent:true requires idempotencyKey function (ADR-059 §5)`,
    );
  }

  const innerHandler = action.handler;

  return {
    ...action,
    handler: async (ctx, input) => {
      // ADR-058 §5 — signer-mode assertion
      if (action.requiresSigner === true && ctx.mode !== "signed") {
        return err({
          code: "SIGNER_UNAVAILABLE",
          message: `action '${action.name}' requires mode:'signed'; got '${ctx.mode}'`,
        });
      }

      // ADR-058 §4 — capability gate
      if (!action.readOnly) {
        const missing = action.capabilities.filter(
          (c) => !ctx.wallet.capabilities.has(c),
        );
        if (missing.length > 0) {
          return err({
            code: "CAPABILITY_MISSING",
            message: `action '${action.name}' missing required capabilities`,
            details: { missing, required: action.capabilities },
          });
        }
      }

      // ADR-059 §6 — preflight gates. Runs BEFORE the handler so a failing
      // gate short-circuits without any side effect.
      if (action.preflight && action.preflight.length > 0) {
        const preflightResult = await executePreflight(
          action.preflight,
          ctx,
          options.preflightDeps ?? {},
        );
        if (!preflightResult.ok) {
          return preflightResult as Result<O>;
        }
      }

      // ADR-059 §5 — idempotency mutex. Only applies to actions that
      // declare `idempotent:true`. Registration-time validation above
      // guarantees `idempotencyKey` is callable whenever we reach here.
      if (action.idempotent === true && action.idempotencyKey) {
        const key = action.idempotencyKey(input);
        const store = options.idempotencyStore ?? getIdempotencyStore();
        return store.acquire<O>(key, () => innerHandler(ctx, input));
      }

      return innerHandler(ctx, input);
    },
  };
}

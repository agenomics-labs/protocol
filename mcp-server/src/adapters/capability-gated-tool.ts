// Wraps an Action<I, O> with default-deny capability check (ADR-058 §4)
// and signer-mode assertion (ADR-058 §5). Preflight execution and
// idempotency mutex land in PR3 (ADR-059 §5/§6) — PR1 validates shape + gating.

import type { Action } from "../types/action.js";
import { err } from "../types/action.js";

export function capabilityGated<I, O>(action: Action<I, O>): Action<I, O> {
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

      return innerHandler(ctx, input);
    },
  };
}

// CC-5 / C4-MCPEVO-002 — shared Solana-address zod helper.
//
// Settlement/vault action input schemas previously typed every
// address/mint/token-account field as a bare `z.string()`, deferring all
// validation to `parsePublicKey` deep in the handler. That is a
// defense-in-depth gap and a boundary-validation invariant violation
// (CLAUDE.md: validate input at system boundaries) — and a footgun for
// the next handler author who consumes an address field WITHOUT routing
// it through `parsePublicKey` (logging, idempotency-key derivation, …).
//
// This helper is the single shared base58-pubkey schema; use it for
// every address/mint/token-account field so the boundary validates
// consistently and the drift cannot recur. Mirrors the
// `findSimilarAgentsInput.agent_id` refinement (registry.ts).

import { z } from "zod";
import { isValidPublicKey } from "../solana.js";

/**
 * Zod schema for a base58-encoded Solana public key (account address,
 * mint, or token account). Rejects non-base58 / wrong-length strings at
 * the schema boundary with a clear message.
 */
export const solanaAddress = z
  .string()
  .refine((s) => isValidPublicKey(s), {
    message: "must be a base58-encoded Solana public key",
  });

/**
 * On-curve variant — use when the field MUST be a wallet/authority
 * (a signer-derived account), never a program-derived address.
 */
export const solanaWalletAddress = z
  .string()
  .refine((s) => isValidPublicKey(s, { requireOnCurve: true }), {
    message:
      "must be a base58-encoded on-curve Solana public key (wallet/authority)",
  });

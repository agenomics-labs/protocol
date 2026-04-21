// ADR-059 §4 — Blockhash-expiry-aware confirmation.
//
// Kit 6.8 already ships `sendAndConfirmTransactionFactory()` +
// `waitForRecentTransactionConfirmation()` which race signature status
// against `lastValidBlockHeight` and throw a typed SolanaError on expiry.
// What Kit does NOT ship is automatic rebroadcast after expiry — the
// caller catches, re-signs with a fresh blockhash, and retries. This
// module is that catch-refresh-retry loop and the typed AeapError wrapper.

import { isSolanaError, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED } from "@solana/kit";
import type { Result } from "../types/action.js";
import { ok, err } from "../types/action.js";

export interface SendAndConfirmOptions {
  maxRetries: number;
  /**
   * The caller-supplied send-and-confirm thunk. It receives the signed
   * transaction and returns a Promise that resolves on landed confirmation
   * and rejects with a `SolanaError` (or equivalent) on
   * blockhash expiry. We do not couple this module to Kit's exact
   * factory shape so that tests can inject a stub.
   */
  sendAndConfirm: (signed: SignedTransactionLike) => Promise<void>;
}

/**
 * A minimal structural type representing "a signed transaction from which
 * we can extract the first signature". Kit's `FullySignedTransaction` and
 * similar shapes conform. We intentionally keep this narrow so callers
 * aren't tied to any one Kit shape.
 */
export interface SignedTransactionLike {
  readonly signatures: Readonly<Record<string, Uint8Array | null>> | readonly (Uint8Array | string)[];
}

export type Signature = string;

/**
 * Wrap a Kit-style `sendAndConfirm` with catch-refresh-retry semantics.
 *
 * On each attempt we call `buildAndSign()` (which SHOULD fetch a fresh
 * blockhash every call), submit, and await confirmation. If the confirm
 * throws `SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED` we burn a retry. Any other
 * error is terminal and returned as a typed `RPC_ERROR`.
 */
export async function sendAndConfirmWithBlockhashExpiry(
  buildAndSign: () => Promise<SignedTransactionLike>,
  opts: SendAndConfirmOptions,
): Promise<Result<Signature>> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    let signed: SignedTransactionLike;
    try {
      signed = await buildAndSign();
    } catch (e) {
      return err({
        code: "RPC_ERROR",
        message: `buildAndSign failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    try {
      await opts.sendAndConfirm(signed);
      const sig = extractFirstSignature(signed);
      if (sig === null) {
        return err({
          code: "RPC_ERROR",
          message: "confirmed transaction has no signature",
        });
      }
      return ok(sig);
    } catch (e) {
      lastError = e;
      if (isBlockHeightExceeded(e) && attempt < opts.maxRetries) {
        // Retry with fresh blockhash via caller thunk
        continue;
      }
      return err({
        code: "RPC_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return err({
    code: "RPC_ERROR",
    message: `max retries (${opts.maxRetries}) exceeded${
      lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""
    }`,
  });
}

/**
 * Detect the Kit-typed blockhash-expiry error. Falls back to a substring
 * match on the message for cases where the error is wrapped or stringified
 * by an intermediate layer (documented in ADR-059 Blocker Policy).
 */
export function isBlockHeightExceeded(e: unknown): boolean {
  if (isSolanaError(e, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) return true;
  // Fallback string-match (ADR-059 blocker-policy): some Kit paths re-throw
  // the error wrapped, and some tests/stubs use plain Errors.
  if (e instanceof Error) {
    if (e.message.includes("BLOCK_HEIGHT_EXCEEDED")) return true;
    if (/blockhash (?:not found|expired|exceeded)/i.test(e.message)) return true;
  }
  return false;
}

function extractFirstSignature(tx: SignedTransactionLike): Signature | null {
  const sigs = tx.signatures as unknown;
  if (!sigs) return null;
  // Kit's signed-transaction shape stores sigs as a { [address]: bytes }
  // map. Legacy / test shapes may use an array.
  if (Array.isArray(sigs)) {
    const first = sigs[0];
    if (first instanceof Uint8Array) return bytesToBase58(first);
    if (typeof first === "string") return first;
    return null;
  }
  if (typeof sigs === "object") {
    const firstValue = Object.values(sigs as Record<string, unknown>)[0];
    if (firstValue instanceof Uint8Array) return bytesToBase58(firstValue);
    if (typeof firstValue === "string") return firstValue;
  }
  return null;
}

// --------------------------------------------------------------------------
// base58 (local, avoids pulling bs58 into a hot path we rarely traverse).
// --------------------------------------------------------------------------

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bytesToBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  // count leading zeros
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading++;

  // base58 conversion via successive division
  const digits: number[] = [0];
  for (let i = leading; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let k = 0; k < leading; k++) out += "1";
  for (let k = digits.length - 1; k >= 0; k--) out += BASE58_ALPHABET[digits[k]];
  return out;
}

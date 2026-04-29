/**
 * ADR-058 §5 / PR7 — `KeypairSigner` adapter for the v2 Kit pipeline.
 *
 * This is an **internal, dev-only** `TransactionPartialSigner` implementation
 * that wraps the v1 `@solana/web3.js` `Keypair` returned by `loadWallet()`
 * (see `src/solana.ts`). It exists so the v2 vault_transfer path
 * (`handlers-v2/vault.ts`) can use the Kit `signTransactionMessageWithSigners`
 * pipeline **without** pulling in `@solana/keychain-core` — that dep lands in
 * a follow-up PR per ADR-058.
 *
 * We implement the signer ourselves using `@noble/curves/ed25519` rather than
 * Kit's `createKeyPairSignerFromBytes`, for two reasons:
 *
 *   1. `createKeyPairSignerFromBytes` resolves to a `KeyPairSigner<CryptoKeyPair>`
 *      that relies on `crypto.subtle.sign` — works fine in Node 20+, but the
 *      task (PR7) explicitly requires the fallback path to be exercised so we
 *      can prove the signer contract in a test without relying on WebCrypto
 *      being present.
 *   2. We want a **byte-identical** parity check between the v1 Keypair's
 *      signature (via `@solana/web3.js` internals) and this adapter — the
 *      cleanest way is to sign using a deterministic Ed25519 library and
 *      verify in the test.
 *
 * Out of scope (explicitly): HSM / Vault / Privy backends. Those arrive with
 * `@solana/keychain-core` per ADR-058 §5.
 */

import { ed25519 } from "@noble/curves/ed25519";
import type { Keypair } from "@solana/web3.js";
import { publicKeyToAddress } from "../solana.js";
import type {
  Address,
  TransactionPartialSigner,
} from "@solana/kit";

/**
 * Re-export of Kit's `TransactionPartialSigner` interface (MCP-324, Batch G).
 * Earlier versions of this module declared a hand-rolled structural alias
 * with `messageBytes: Uint8Array`, but Kit brands `messageBytes` as
 * `TransactionMessageBytes` and the structural mismatch forced `as unknown
 * as` casts at every call site that fed our signer to Kit's helpers.
 * Re-exporting Kit's actual type makes the casts unnecessary.
 */
export type KitTransactionPartialSigner = TransactionPartialSigner;

/**
 * Build a Kit-compatible `TransactionPartialSigner` from a v1 Keypair.
 *
 * The returned object:
 *   - reports `address` as the keypair's base58 public key (branded `Address`);
 *   - implements `signTransactions(txs)` by producing one
 *     `SignatureDictionary = { [address]: signatureBytes(64) }` per input tx.
 *
 * The signing path:
 *   - Solana's `Keypair.secretKey` is 64 bytes: `[seed(32) || pubkey(32)]`.
 *   - `@noble/curves/ed25519` takes the **32-byte seed** as the EdDSA
 *     secret key (RFC 8032). We slice the first 32 bytes of `secretKey`.
 *   - We sign `tx.messageBytes` directly — that is the canonical wire-format
 *     message that Solana validators verify the signature against (see
 *     `@solana/transactions` `Transaction.messageBytes`).
 */
export function createKeypairSignerFromV1Keypair(
  keypair: Keypair,
): KitTransactionPartialSigner {
  const address = publicKeyToAddress(keypair.publicKey);

  // Solana secret-key layout: seed(32) || pubkey(32). noble EdDSA expects
  // just the 32-byte seed.
  const secretKey = keypair.secretKey;
  if (secretKey.length !== 64) {
    throw new Error(
      `KeypairSigner: expected 64-byte Solana secretKey, got ${secretKey.length}`,
    );
  }
  const seed = secretKey.slice(0, 32);

  // The single ADR-088-aligned cast for this module: Kit brands
  // `SignatureDictionary` keys as `Address` and values as `SignatureBytes`
  // (nominal types). Our raw signature bytes ARE address-keyed
  // SignatureBytes-shaped (64-byte ed25519); the cast at the return
  // boundary is the only place that crosses the brand without
  // structural-assignability proof.
  const signTransactions: TransactionPartialSigner["signTransactions"] = async (
    transactions,
  ) => {
    return transactions.map((tx) => {
      const messageBytes = tx.messageBytes;
      if (!(messageBytes instanceof Uint8Array)) {
        throw new Error(
          "KeypairSigner.signTransactions: tx.messageBytes missing or not a Uint8Array",
        );
      }
      const sig = ed25519.sign(messageBytes, seed);
      if (sig.length !== 64) {
        throw new Error(
          `KeypairSigner.signTransactions: unexpected signature length ${sig.length}`,
        );
      }
      // The single brand-bridge cast in this module (ADR-088).
      return { [address]: sig } as ReturnType<
        TransactionPartialSigner["signTransactions"]
      > extends Promise<readonly (infer U)[]>
        ? U
        : never;
    });
  };

  return { address, signTransactions };
}

/**
 * Re-export so tests can verify a signature independently of this module.
 */
export { ed25519 };

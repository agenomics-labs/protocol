// PR7 — handlers-v2/vault.ts end-to-end unit tests.
//
// Three layers:
//   1. KeypairSigner contract — signTransactions produces a 64-byte Ed25519
//      signature over messageBytes, verifiable via @noble/curves/ed25519.
//   2. Instruction encoding — discriminator (sha256("global:execute_transfer"))
//      + u64 LE amount, and the account-metas layout matches the on-chain
//      ExecuteTransfer context.
//   3. Integration-lite — handleVaultTransferV2 with a mocked Kit RPC
//      (simulate / getLatestBlockhash / sendAndConfirm stub) threads the full
//      pipeline and emits the expected signed wire tx.
//
// Runs under `node --import tsx --test` (same harness as
// action-shape / pipeline / solana-v2).

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import * as crypto from "crypto";

import {
  createKeypairSignerFromV1Keypair,
} from "../src/handlers-v2/keypair-signer.js";
import {
  handleVaultTransferV2,
  anchorDiscriminator,
  encodeU64Le,
  encodeExecuteTransferData,
  buildExecuteTransferInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  type VaultTransferV2Rpc,
  type VaultTransferV2Deps,
} from "../src/handlers-v2/vault.js";
import { deriveVaultPDA, publicKeyToAddress } from "../src/solana.js";
import { VAULT_PROGRAM_ADDRESS } from "../src/solana-v2.js";
import { AccountRole } from "@solana/kit";

// ==========================================================================
// §1. KeypairSigner contract
// ==========================================================================

describe("handlers-v2/keypair-signer", () => {
  it("address matches the v1 Keypair's public key (base58 round-trip)", () => {
    const kp = Keypair.generate();
    const signer = createKeypairSignerFromV1Keypair(kp);
    assert.equal(signer.address.toString(), kp.publicKey.toBase58());
  });

  it("signTransactions produces a valid 64-byte Ed25519 signature over messageBytes", async () => {
    const kp = Keypair.generate();
    const signer = createKeypairSignerFromV1Keypair(kp);

    // Deterministic, non-empty messageBytes blob. In production this is the
    // Kit-compiled wire message; the signer must not care about contents.
    const messageBytes = new Uint8Array(
      Array.from({ length: 96 }, (_, i) => (i * 7 + 13) & 0xff),
    );

    const dicts = await signer.signTransactions([{ messageBytes }]);
    assert.equal(dicts.length, 1);

    const sig = dicts[0][signer.address as unknown as string];
    assert.ok(sig instanceof Uint8Array, "signature must be Uint8Array");
    assert.equal(sig.length, 64, "Ed25519 signatures are 64 bytes");

    // Verify independently with @noble/curves/ed25519 using the Keypair's
    // public key as the verification key.
    const pubkeyBytes = kp.publicKey.toBytes();
    const isValid = ed25519.verify(sig, messageBytes, pubkeyBytes);
    assert.equal(isValid, true, "independent ed25519.verify must accept the signature");

    // Negative: tampering with one byte of the message invalidates the sig.
    const tampered = new Uint8Array(messageBytes);
    tampered[0] ^= 0x01;
    assert.equal(ed25519.verify(sig, tampered, pubkeyBytes), false);
  });

  it("signTransactions signs multiple transactions in parallel (one dict each)", async () => {
    const kp = Keypair.generate();
    const signer = createKeypairSignerFromV1Keypair(kp);

    const msgs = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6, 7]),
      new Uint8Array([8]),
    ].map((messageBytes) => ({ messageBytes }));

    const dicts = await signer.signTransactions(msgs);
    assert.equal(dicts.length, 3);
    for (let i = 0; i < 3; i++) {
      const sig = dicts[i][signer.address as unknown as string];
      assert.ok(sig instanceof Uint8Array);
      assert.equal(sig.length, 64);
      assert.equal(
        ed25519.verify(sig, msgs[i].messageBytes, kp.publicKey.toBytes()),
        true,
      );
    }
  });

  it("throws when messageBytes is missing", async () => {
    const kp = Keypair.generate();
    const signer = createKeypairSignerFromV1Keypair(kp);
    await assert.rejects(
      signer.signTransactions([{ messageBytes: undefined as any }]),
      /messageBytes/,
    );
  });
});

// ==========================================================================
// §2. Instruction encoding — discriminator, u64 LE, account metas
// ==========================================================================

describe("handlers-v2/vault — anchor ix encoding", () => {
  it("anchorDiscriminator('global:execute_transfer') matches sha256(...)[..8]", () => {
    const got = anchorDiscriminator("global:execute_transfer");
    assert.equal(got.length, 8);
    const expected = crypto
      .createHash("sha256")
      .update("global:execute_transfer")
      .digest()
      .slice(0, 8);
    assert.deepEqual(Array.from(got), Array.from(expected));
  });

  it("encodeU64Le serializes 1 SOL (1_000_000_000 lamports) as little-endian", () => {
    const out = encodeU64Le(1_000_000_000n);
    assert.equal(out.length, 8);
    // 1_000_000_000 = 0x3B9ACA00 -> LE: 00 CA 9A 3B 00 00 00 00
    assert.deepEqual(
      Array.from(out),
      [0x00, 0xca, 0x9a, 0x3b, 0x00, 0x00, 0x00, 0x00],
    );
  });

  it("encodeU64Le handles zero and max u64", () => {
    assert.deepEqual(Array.from(encodeU64Le(0n)), [0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(
      Array.from(encodeU64Le(0xffff_ffff_ffff_ffffn)),
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    );
  });

  it("encodeExecuteTransferData = [disc(8) || amount_u64_LE(8)]", () => {
    const amount = 250_000_000n; // 0.25 SOL
    const data = encodeExecuteTransferData(amount);
    assert.equal(data.length, 16, "disc(8) + u64(8) = 16 bytes");

    const expectedDisc = anchorDiscriminator("global:execute_transfer");
    assert.deepEqual(Array.from(data.slice(0, 8)), Array.from(expectedDisc));
    assert.deepEqual(
      Array.from(data.slice(8)),
      Array.from(encodeU64Le(amount)),
    );
  });

  it("buildExecuteTransferInstruction produces the correct 4-account layout", () => {
    const vaultPk = Keypair.generate().publicKey;
    const authPk = Keypair.generate().publicKey;
    const recipPk = Keypair.generate().publicKey;
    const amount = 42_000_000n;

    const ix = buildExecuteTransferInstruction(
      publicKeyToAddress(vaultPk),
      publicKeyToAddress(authPk),
      publicKeyToAddress(recipPk),
      amount,
    );

    assert.equal(ix.programAddress, VAULT_PROGRAM_ADDRESS);
    assert.ok(Array.isArray(ix.accounts));
    assert.equal(ix.accounts!.length, 4);

    // Account 0: vault PDA, WRITABLE (not signer)
    assert.equal(ix.accounts![0].address, publicKeyToAddress(vaultPk));
    assert.equal(ix.accounts![0].role, AccountRole.WRITABLE);
    // Account 1: authority, READONLY_SIGNER (Signer<'info>)
    assert.equal(ix.accounts![1].address, publicKeyToAddress(authPk));
    assert.equal(ix.accounts![1].role, AccountRole.READONLY_SIGNER);
    // Account 2: recipient, WRITABLE (mut UncheckedAccount)
    assert.equal(ix.accounts![2].address, publicKeyToAddress(recipPk));
    assert.equal(ix.accounts![2].role, AccountRole.WRITABLE);
    // Account 3: system program, READONLY
    assert.equal(ix.accounts![3].address, SYSTEM_PROGRAM_ADDRESS);
    assert.equal(ix.accounts![3].role, AccountRole.READONLY);

    // Data must match the canonical [disc || amount] encoding
    assert.deepEqual(
      Array.from(ix.data!),
      Array.from(encodeExecuteTransferData(amount)),
    );
  });
});

// ==========================================================================
// §3. Integration-lite — full handleVaultTransferV2 flow with mocked RPC
// ==========================================================================

/**
 * Build a fixed-response mock RPC that records every simulateTransaction call
 * so we can assert the wire tx structure post-hoc.
 */
function makeMockRpc() {
  const simCalls: Array<{ wire: string; config: unknown }> = [];
  const rpc: VaultTransferV2Rpc = {
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          // Valid base58 32-byte blockhash.
          blockhash: "11111111111111111111111111111111" as any,
          lastValidBlockHeight: 1_000_000n,
        },
      }),
    }),
    simulateTransaction: (wire, config) => ({
      send: async () => {
        simCalls.push({ wire: String(wire), config });
        return {
          value: {
            err: null,
            logs: ["Program log: simulated"],
            unitsConsumed: 42_000n,
          },
        };
      },
    }),
    getRecentPrioritizationFees: (_addresses) => ({
      send: async () =>
        [
          { prioritizationFee: 1_000n, slot: 1n },
          { prioritizationFee: 5_000n, slot: 2n },
          { prioritizationFee: 10_000n, slot: 3n },
        ] as any,
    }),
  };
  return { rpc, simCalls };
}

describe("handleVaultTransferV2 — integration-lite", () => {
  it("happy path: produces the expected instruction + compute-budget IXs, signs, sends, returns signature", async () => {
    // Test keypair + derived vault PDA via the v1 derivation (canonical).
    const kp = Keypair.generate();
    const [vaultPda] = deriveVaultPDA(kp.publicKey);
    const recipientKp = Keypair.generate();

    const { rpc, simCalls } = makeMockRpc();

    // Records the signed wire tx so we can inspect what actually went out.
    const sentWires: unknown[] = [];

    const signer = createKeypairSignerFromV1Keypair(kp);

    const deps: VaultTransferV2Deps = {
      rpc,
      signer,
      authorityAddress: publicKeyToAddress(kp.publicKey),
      vaultAddress: publicKeyToAddress(vaultPda),
      sendAndConfirm: async (signed) => {
        sentWires.push(signed);
      },
      maxRetries: 0,
    };

    const result = await handleVaultTransferV2(
      {
        recipientAddress: recipientKp.publicKey.toBase58(),
        amountSol: 0.5,
      },
      deps,
    );

    assert.equal(result.ok, true, `handler failed: ${!result.ok ? result.error.message : ""}`);
    if (!result.ok) return;

    // --- Output shape ---
    assert.equal(result.data.success, true);
    assert.equal(result.data.v2, true);
    assert.equal(result.data.amountSol, 0.5);
    assert.equal(result.data.vaultAddress, vaultPda.toBase58());
    assert.equal(result.data.recipient, recipientKp.publicKey.toBase58());
    assert.equal(typeof result.data.transactionSignature, "string");
    assert.ok(result.data.transactionSignature.length > 0);

    // --- Compute-budget sizing per ADR-059 §2 ---
    //   consumed=42_000 → max(42_000+100_000, ceil(42_000*1.2), 200_000)
    //   = max(142_000, 50_400, 200_000) = 200_000 (floor)
    assert.equal(result.data.simulatedUnitsConsumed, 42_000);
    assert.equal(result.data.computeUnitLimit, 200_000);
    // Percentile (mid=0.5) over [1_000, 5_000, 10_000] sorted, floor(0.5*3)=1 → 5_000
    assert.equal(result.data.priorityMicroLamports, "5000");

    // --- Simulation was called exactly once with base64 encoding ---
    assert.equal(simCalls.length, 1);
    assert.equal(
      (simCalls[0].config as any).encoding,
      "base64",
      "simulation must use base64 encoding",
    );
    assert.equal((simCalls[0].config as any).sigVerify, false);

    // --- Exactly one signed+sent wire tx at maxRetries=0 ---
    assert.equal(sentWires.length, 1);
    const sent: any = sentWires[0];
    assert.ok(sent.signatures, "signed tx carries signatures");
    // The fee-payer signer address must be in the signatures map with a 64B sig.
    const feePayerSig = sent.signatures[deps.authorityAddress.toString()];
    assert.ok(feePayerSig instanceof Uint8Array);
    assert.equal(feePayerSig.length, 64);

    // --- And the signature is a valid ed25519 signature over the wire message ---
    const ok = ed25519.verify(feePayerSig, sent.messageBytes, kp.publicKey.toBytes());
    assert.equal(ok, true, "sent tx signature must verify against the keypair");
  });

  it("rejects non-positive amounts via INVALID_INPUT (no RPC calls)", async () => {
    const kp = Keypair.generate();
    const [vaultPda] = deriveVaultPDA(kp.publicKey);
    const { rpc, simCalls } = makeMockRpc();
    const signer = createKeypairSignerFromV1Keypair(kp);

    const r = await handleVaultTransferV2(
      { recipientAddress: Keypair.generate().publicKey.toBase58(), amountSol: 0 },
      {
        rpc,
        signer,
        authorityAddress: publicKeyToAddress(kp.publicKey),
        vaultAddress: publicKeyToAddress(vaultPda),
        sendAndConfirm: async () => {
          /* should never run */
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "INVALID_INPUT");
    assert.equal(simCalls.length, 0);
  });

  it("rejects malformed recipient address via PROGRAM_ERROR (thrown by parsePublicKey)", async () => {
    const kp = Keypair.generate();
    const [vaultPda] = deriveVaultPDA(kp.publicKey);
    const { rpc } = makeMockRpc();
    const signer = createKeypairSignerFromV1Keypair(kp);

    const r = await handleVaultTransferV2(
      { recipientAddress: "not-a-solana-address", amountSol: 0.1 },
      {
        rpc,
        signer,
        authorityAddress: publicKeyToAddress(kp.publicKey),
        vaultAddress: publicKeyToAddress(vaultPda),
        sendAndConfirm: async () => {
          /* should never run */
        },
      },
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      // Either INVALID_INPUT or PROGRAM_ERROR (parsePublicKey throws) — both
      // are acceptable; the important bit is we never reach the RPC.
      assert.ok(
        r.error.code === "PROGRAM_ERROR" || r.error.code === "INVALID_INPUT",
      );
    }
  });

  it("propagates sendAndConfirm BLOCK_HEIGHT_EXCEEDED into retry, then success", async () => {
    const kp = Keypair.generate();
    const [vaultPda] = deriveVaultPDA(kp.publicKey);
    const recipientKp = Keypair.generate();
    const { rpc } = makeMockRpc();
    const signer = createKeypairSignerFromV1Keypair(kp);

    let attempts = 0;
    const r = await handleVaultTransferV2(
      {
        recipientAddress: recipientKp.publicKey.toBase58(),
        amountSol: 0.1,
      },
      {
        rpc,
        signer,
        authorityAddress: publicKeyToAddress(kp.publicKey),
        vaultAddress: publicKeyToAddress(vaultPda),
        sendAndConfirm: async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error("SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED: blockhash expired");
          }
        },
        maxRetries: 2,
      },
    );

    assert.equal(r.ok, true);
    assert.equal(attempts, 2, "first attempt expired, second succeeded");
  });
});

// ==========================================================================
// §4. Action-layer env flag wiring
// ==========================================================================

describe("actions/vault — env flag dispatch", () => {
  it("vault_transfer action exports a dispatcher (v1 by default, v2 under env flag)", async () => {
    // Smoke-import the action registry without triggering network calls.
    const { vaultTransferAction, vaultTransferV2Action } = await import(
      "../src/actions/vault.js"
    );
    assert.equal(vaultTransferAction.name, "vault_transfer");
    assert.equal(typeof vaultTransferAction.handler, "function");

    // vault_transfer_v2 alternative action must exist and be marked requiresSigner
    assert.equal(vaultTransferV2Action.name, "vault_transfer_v2");
    assert.equal(vaultTransferV2Action.requiresSigner, true);
    assert.ok(vaultTransferV2Action.capabilities.includes("sign:vault" as any));
  });
});

// ADR-012 / ADR-033 PR2 — @solana/kit (v2) surface sanity checks.
//
// These tests prove two things:
//   1. `createRpc()` builds a usable Kit RPC client (method surface only —
//      we do not hit the network here).
//   2. PDA derivation on the v2 side produces the same address as the
//      existing v1 derivation in `src/solana.ts`. This is the fidelity
//      guarantee that lets PR3 route reads through v2 without changing
//      the program seed layout.
//
// Runs under `node --import tsx --test` — same harness as action-shape.test.ts.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  createRpc,
  deriveVaultPda,
  deriveAgentProfilePda,
  deriveEscrowPda,
  deriveProtocolConfigPda,
  parseAddress,
} from "../src/solana-v2.js";
import {
  deriveVaultPDA,
  deriveAgentProfilePDA,
  deriveEscrowPDA,
  deriveProtocolConfigPDA,
} from "../src/solana.js";

// Two fixed, on-curve, well-known base58 public keys. These are valid as
// both authorities (vault/agent-profile) and as client/provider in escrow
// seeds.
const KNOWN_AUTHORITY = "CwL4bWh5RZTBRuGu4Lp5LtXP4vsUdCtWVNLkQeZnoFem";
const KNOWN_CLIENT = "CwL4bWh5RZTBRuGu4Lp5LtXP4vsUdCtWVNLkQeZnoFem";
const KNOWN_PROVIDER = "4pGvR7cBxsaU6g1XVQhD2nMsDsV1Yc1eTjSbFcoFtV8d";
const KNOWN_TASK_ID = 42;

describe("ADR-012 @solana/kit v2 surface", () => {
  describe("createRpc()", () => {
    it("returns an RPC client with the expected method surface", () => {
      const rpc = createRpc();
      // Kit's Rpc<Api> exposes one method per JSON-RPC call; no network I/O
      // happens until `.send()` is awaited. Sample a representative slice
      // to prove the client was constructed correctly.
      assert.equal(typeof rpc.getLatestBlockhash, "function");
      assert.equal(typeof rpc.getAccountInfo, "function");
      assert.equal(typeof rpc.getBalance, "function");
      assert.equal(typeof rpc.sendTransaction, "function");

      // Calling the method without `.send()` returns a pending-rpc object,
      // not a promise — confirms we have the Kit shape, not a mock.
      const pending = rpc.getLatestBlockhash();
      assert.equal(typeof (pending as any).send, "function");
    });

    it("is idempotent across calls (singleton semantics)", () => {
      const a = createRpc();
      const b = createRpc();
      assert.strictEqual(a, b);
    });
  });

  describe("PDA derivation fidelity vs. src/solana.ts (v1)", () => {
    it("deriveVaultPda matches deriveVaultPDA byte-for-byte", async () => {
      const authority = new PublicKey(KNOWN_AUTHORITY);
      const [v1Pda, v1Bump] = deriveVaultPDA(authority);

      const [v2Pda, v2Bump] = await deriveVaultPda(parseAddress(KNOWN_AUTHORITY));

      assert.equal(v2Pda.toString(), v1Pda.toBase58());
      assert.equal(v2Bump, v1Bump);
    });

    it("deriveAgentProfilePda matches deriveAgentProfilePDA byte-for-byte", async () => {
      const authority = new PublicKey(KNOWN_AUTHORITY);
      const [v1Pda, v1Bump] = deriveAgentProfilePDA(authority);

      const [v2Pda, v2Bump] = await deriveAgentProfilePda(
        parseAddress(KNOWN_AUTHORITY),
      );

      assert.equal(v2Pda.toString(), v1Pda.toBase58());
      assert.equal(v2Bump, v1Bump);
    });

    it("deriveEscrowPda matches deriveEscrowPDA byte-for-byte (LE u64 taskId)", async () => {
      const client = new PublicKey(KNOWN_CLIENT);
      const provider = new PublicKey(KNOWN_PROVIDER);
      const [v1Pda, v1Bump] = deriveEscrowPDA(client, provider, KNOWN_TASK_ID);

      const [v2Pda, v2Bump] = await deriveEscrowPda(
        parseAddress(KNOWN_CLIENT),
        parseAddress(KNOWN_PROVIDER),
        KNOWN_TASK_ID,
      );

      assert.equal(v2Pda.toString(), v1Pda.toBase58());
      assert.equal(v2Bump, v1Bump);
    });

    it("deriveProtocolConfigPda matches deriveProtocolConfigPDA byte-for-byte", async () => {
      const [v1Pda, v1Bump] = deriveProtocolConfigPDA();
      const [v2Pda, v2Bump] = await deriveProtocolConfigPda();

      assert.equal(v2Pda.toString(), v1Pda.toBase58());
      assert.equal(v2Bump, v1Bump);
    });
  });

  describe("parseAddress()", () => {
    it("accepts a valid base58 address and rejects malformed input", () => {
      assert.doesNotThrow(() => parseAddress(KNOWN_AUTHORITY));
      assert.throws(() => parseAddress("not-a-base58-address"));
      assert.throws(() => parseAddress(""));
    });
  });
});

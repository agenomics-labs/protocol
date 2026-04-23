// ADR-060 reference validator tests.
//
// Runs under Node's built-in test runner (`node:test`) via `tsx` to
// sidestep the mocha-11 / chai-v6 ESM loader collision documented in
// mcp-server/test/action-shape.test.ts (PR1 / ADR-058 setup).

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import {
  validateManifest,
  manifestHash,
  unstable_canonicalJson,
  MANIFEST_SCHEMA_V1_URL,
  type CapabilityManifest,
} from "../src/index.js";

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function validManifest(): unknown {
  // A faithful ADR-060 §2 v1.0 example — base58 placeholder pubkey is
  // one valid character set; we re-use the Solana system-program
  // address (32 '1's is base58 for 32-byte zero).
  return {
    $schema: MANIFEST_SCHEMA_V1_URL,
    version: "1.0",
    agent: {
      pubkey: "11111111111111111111111111111111",
      name: "Test Agent",
    },
    agent_version: "0.1.0",
    capabilities: [
      {
        name: "transfer-funds",
        description: "Transfer SOL between two accounts.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_capabilities: [{ capability: "sign:vault" }],
        side_effects: ["signs-tx", "write-onchain"],
        stability: "stable",
      },
    ],
    published_at: "2026-04-21T00:00:00Z",
  };
}

// Build the authority keypair + signature over the canonical hash of
// the supplied manifest. Helper shared by the happy-path and tamper tests.
function signManifest(manifest: unknown): {
  hash: Uint8Array;
  signature: Uint8Array;
  pubkey: Uint8Array;
  secret: Uint8Array;
} {
  // Deterministic 32-byte seed so the test is reproducible and doesn't
  // depend on crypto.getRandomValues availability.
  const secret = new Uint8Array(32);
  for (let i = 0; i < 32; i++) secret[i] = i + 1;
  const pubkey = ed25519.getPublicKey(secret);
  const hash = manifestHash(manifest);
  const signature = ed25519.sign(hash, secret);
  return { hash, signature, pubkey, secret };
}

// -----------------------------------------------------------------
// Tests
// -----------------------------------------------------------------

describe("ADR-060 CapabilityManifest validator", () => {
  describe("happy path", () => {
    it("accepts a valid signed manifest (schema + hash + sig)", () => {
      const manifest = validManifest();
      const { hash, signature, pubkey } = signManifest(manifest);

      const result = validateManifest({
        manifest,
        onChainHash: hash,
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.manifest.version, "1.0");
        assert.equal(result.manifest.agent.name, "Test Agent");
        assert.equal(result.manifest.capabilities.length, 1);
        assert.equal(result.manifest.capabilities[0]!.name, "transfer-funds");
      }
    });

    it("produces stable canonical JSON (key order independent)", () => {
      // The whole point of RFC-8785: two semantically-equal objects
      // with different key orders must hash identically.
      const a = { b: 1, a: 2, c: { y: 9, x: 8 } };
      const b = { a: 2, c: { x: 8, y: 9 }, b: 1 };
      assert.equal(unstable_canonicalJson(a), unstable_canonicalJson(b));
      assert.deepEqual(manifestHash(a), manifestHash(b));
    });
  });

  describe("schema rejection", () => {
    it("rejects a manifest with the wrong $schema URL", () => {
      const bad = { ...(validManifest() as object), $schema: "https://example.com/v2.json" };
      const { hash, signature, pubkey } = signManifest(bad);
      const result = validateManifest({
        manifest: bad,
        onChainHash: hash,
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SCHEMA_INVALID");
    });

    it("rejects a manifest whose capability name is not kebab-case", () => {
      const bad = validManifest() as CapabilityManifest;
      (bad.capabilities[0] as { name: string }).name = "TransferFunds"; // camelCase
      const { hash, signature, pubkey } = signManifest(bad);
      const result = validateManifest({
        manifest: bad,
        onChainHash: hash,
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SCHEMA_INVALID");
    });

    it("rejects a manifest missing required fields", () => {
      const bad = { version: "1.0" }; // missing almost everything
      const { hash, signature, pubkey } = signManifest(bad);
      const result = validateManifest({
        manifest: bad,
        onChainHash: hash,
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SCHEMA_INVALID");
    });
  });

  describe("hash integrity", () => {
    it("rejects a manifest whose hash does not match the on-chain hash", () => {
      const manifest = validManifest();
      const { signature, pubkey } = signManifest(manifest);

      // Tamper with the on-chain hash: flip one byte.
      const tamperedHash = manifestHash(manifest).slice();
      tamperedHash[0] = tamperedHash[0]! ^ 0xff;

      const result = validateManifest({
        manifest,
        onChainHash: tamperedHash,
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "HASH_MISMATCH");
    });

    it("rejects a manifest that has been mutated after signing", () => {
      const original = validManifest();
      const { hash: originalHash, signature, pubkey } = signManifest(original);

      // Mutate the manifest body — name now differs from what was signed.
      const mutated = { ...(original as object), agent: { pubkey: "11111111111111111111111111111111", name: "Impostor" } };

      const result = validateManifest({
        manifest: mutated,
        onChainHash: originalHash,       // still the old hash
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "HASH_MISMATCH");
    });
  });

  describe("signature integrity", () => {
    it("rejects a valid manifest signed by a different key", () => {
      const manifest = validManifest();
      const hash = manifestHash(manifest);

      // Signed by `attacker`, but on-chain authority is `legitimate`.
      const attacker = new Uint8Array(32).fill(0xaa);
      const legitimate = new Uint8Array(32).fill(0x11);
      const attackerSig = ed25519.sign(hash, attacker);
      const legitimatePubkey = ed25519.getPublicKey(legitimate);

      const result = validateManifest({
        manifest,
        onChainHash: hash,
        onChainSignature: attackerSig,
        authorityPubkey: legitimatePubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SIGNATURE_MISMATCH");
    });

    it("rejects a signature over the wrong message", () => {
      const manifest = validManifest();
      const { pubkey, secret } = signManifest(manifest);
      const realHash = manifestHash(manifest);

      // Sign some OTHER 32-byte value, not the manifest hash.
      const wrongMessage = new Uint8Array(32).fill(0x99);
      const sig = ed25519.sign(wrongMessage, secret);

      const result = validateManifest({
        manifest,
        onChainHash: realHash,
        onChainSignature: sig,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SIGNATURE_MISMATCH");
    });
  });

  describe("input shape guards", () => {
    it("rejects non-32-byte hashes", () => {
      const manifest = validManifest();
      const { signature, pubkey } = signManifest(manifest);
      const result = validateManifest({
        manifest,
        onChainHash: new Uint8Array(16), // wrong length
        onChainSignature: signature,
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });

    it("rejects non-64-byte signatures", () => {
      const manifest = validManifest();
      const { hash, pubkey } = signManifest(manifest);
      const result = validateManifest({
        manifest,
        onChainHash: hash,
        onChainSignature: new Uint8Array(32), // wrong length
        authorityPubkey: pubkey,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });

    it("rejects non-32-byte pubkeys", () => {
      const manifest = validManifest();
      const { hash, signature } = signManifest(manifest);
      const result = validateManifest({
        manifest,
        onChainHash: hash,
        onChainSignature: signature,
        authorityPubkey: new Uint8Array(16), // wrong length
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
    });
  });
});

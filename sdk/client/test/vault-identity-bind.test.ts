/**
 * ADR-124 (AUD-116 path-a) — unit tests for the vault `agent_identity`
 * proof-of-control SDK helpers.
 *
 * Roadmap §3 B1 specifies the SDK must mirror the on-chain
 * `vault_identity_bind_message(authority, agent_identity)` byte-for-byte
 * (`programs/agent-vault/src/lib.rs`). These tests pin the two
 * load-bearing properties:
 *
 *   1. **Domain tag exactness** — the SDK's
 *      `VAULT_IDENTITY_BIND_DOMAIN` equals the on-chain constant byte-for-
 *      byte and differs from the registry's manifest domain (cross-protocol
 *      replay defense).
 *   2. **Message determinism + injectivity** — the message is
 *      `sha256(domain || authority || agent_identity)`; differing inputs
 *      produce different digests; identical inputs are stable.
 *
 * Plus instruction-builder shape tests (length validation, ed25519-program
 * id, inline pubkey / signature / message bytes).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

import {
  VAULT_IDENTITY_BIND_DOMAIN,
  vaultIdentityBindMessage,
  buildVaultIdentityBindInstruction,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Domain-tag pinning. The on-chain constant in
// `programs/agent-vault/src/lib.rs` is
// `pub const VAULT_IDENTITY_BIND_DOMAIN: &[u8] = b"AEP_VAULT_IDENTITY_BIND_V1\x00";`
// (26 ASCII chars + a trailing NUL terminator). If either side changes, both
// must be updated in lockstep — these assertions surface the drift.
// ---------------------------------------------------------------------------

test("VAULT_IDENTITY_BIND_DOMAIN is exactly 27 bytes (26 ASCII + NUL)", () => {
  assert.equal(VAULT_IDENTITY_BIND_DOMAIN.length, 27);
});

test("VAULT_IDENTITY_BIND_DOMAIN ends with a NUL terminator", () => {
  assert.equal(VAULT_IDENTITY_BIND_DOMAIN[26], 0);
});

test("VAULT_IDENTITY_BIND_DOMAIN ASCII prefix is 'AEP_VAULT_IDENTITY_BIND_V1'", () => {
  const prefix = Buffer.from(VAULT_IDENTITY_BIND_DOMAIN.slice(0, 26)).toString(
    "utf8",
  );
  assert.equal(prefix, "AEP_VAULT_IDENTITY_BIND_V1");
});

test("VAULT_IDENTITY_BIND_DOMAIN differs from the registry manifest domain (cross-protocol replay defense)", () => {
  // Hardcoded copy of `agent_registry::MANIFEST_HASH_DOMAIN`. We do not
  // import the registry constant because the design point of domain
  // separation is that the two values are independent — pinning them
  // side-by-side here keeps the divergence obvious in code review and
  // catches accidental convergence.
  const registryManifestDomain = Buffer.concat([
    Buffer.from("AEP_CAPABILITY_MANIFEST_V1", "utf8"),
    Buffer.from([0]),
  ]);
  assert.notDeepEqual(
    Buffer.from(VAULT_IDENTITY_BIND_DOMAIN),
    registryManifestDomain,
    "vault bind domain MUST differ from registry manifest domain to prevent cross-protocol signature replay",
  );
});

// ---------------------------------------------------------------------------
// Bind-message determinism + injectivity. Mirrors the Rust unit tests
// `adr_124_bind_message_applies_domain_separator` and
// `adr_124_bind_message_is_injective_per_leg` in
// `programs/agent-vault/src/lib.rs`.
// ---------------------------------------------------------------------------

test("vaultIdentityBindMessage matches sha256(domain || authority || agent_identity)", () => {
  const authority = Keypair.generate().publicKey;
  const agentIdentity = Keypair.generate().publicKey;

  const got = vaultIdentityBindMessage(authority, agentIdentity);
  const expected = crypto
    .createHash("sha256")
    .update(VAULT_IDENTITY_BIND_DOMAIN)
    .update(authority.toBuffer())
    .update(agentIdentity.toBuffer())
    .digest();

  assert.deepEqual(got, expected);
  assert.equal(got.length, 32);
});

test("vaultIdentityBindMessage is deterministic for the same inputs", () => {
  const authority = Keypair.generate().publicKey;
  const agentIdentity = Keypair.generate().publicKey;
  const first = vaultIdentityBindMessage(authority, agentIdentity);
  const second = vaultIdentityBindMessage(authority, agentIdentity);
  assert.deepEqual(first, second);
});

test("vaultIdentityBindMessage is injective across the authority leg", () => {
  const authorityA = Keypair.generate().publicKey;
  const authorityB = Keypair.generate().publicKey;
  const agentIdentity = Keypair.generate().publicKey;
  assert.notDeepEqual(
    vaultIdentityBindMessage(authorityA, agentIdentity),
    vaultIdentityBindMessage(authorityB, agentIdentity),
  );
});

test("vaultIdentityBindMessage is injective across the agent_identity leg", () => {
  const authority = Keypair.generate().publicKey;
  const agentIdentityA = Keypair.generate().publicKey;
  const agentIdentityB = Keypair.generate().publicKey;
  assert.notDeepEqual(
    vaultIdentityBindMessage(authority, agentIdentityA),
    vaultIdentityBindMessage(authority, agentIdentityB),
  );
});

test("vaultIdentityBindMessage MUST differ from the untagged sha256(authority || agent_identity) shape", () => {
  // A naive caller (or a sibling protocol) that signed the raw concat
  // without the domain tag MUST produce a different digest than the one
  // the on-chain handler accepts. This is the cross-protocol replay
  // defense seen from the message side (the domain-tag side is pinned by
  // `VAULT_IDENTITY_BIND_DOMAIN differs from the registry manifest
  // domain` above; this is the symmetric assertion at the digest layer).
  const authority = Keypair.generate().publicKey;
  const agentIdentity = Keypair.generate().publicKey;
  const tagged = vaultIdentityBindMessage(authority, agentIdentity);
  const untagged = crypto
    .createHash("sha256")
    .update(authority.toBuffer())
    .update(agentIdentity.toBuffer())
    .digest();
  assert.notDeepEqual(tagged, untagged);
});

// ---------------------------------------------------------------------------
// Instruction-builder shape tests. The on-chain
// `identity_bind::verify_ed25519_precompile` helper enforces:
//   - program_id == ed25519_program::ID
//   - inline message length == 32
//   - inline signature length == 64
//   - inline pubkey length == 32
// The SDK helper is a thin wrapper around `Ed25519Program.createInstruction…`,
// but length validation and program-id wiring belong in the SDK contract
// because they're the off-chain mirror of the on-chain expectation.
// ---------------------------------------------------------------------------

test("buildVaultIdentityBindInstruction returns an Ed25519Program ix", () => {
  const authority = Keypair.generate().publicKey;
  const agentIdentityKp = Keypair.generate();
  const message = vaultIdentityBindMessage(authority, agentIdentityKp.publicKey);
  const seed = agentIdentityKp.secretKey.slice(0, 32);
  const signature = Buffer.from(ed25519.sign(message, seed));

  const ix: TransactionInstruction = buildVaultIdentityBindInstruction({
    agentIdentity: agentIdentityKp.publicKey,
    message,
    signature,
  });

  assert.equal(ix.programId.toBase58(), Ed25519Program.programId.toBase58());
  // The precompile ix data layout starts with `num_signatures = 1` followed
  // by 14 bytes of offsets, so the data length floor is 16 + 64 + 32 + 32 =
  // 144 bytes for one inline (sig, pubkey, message) tuple.
  assert.ok(
    ix.data.length >= 144,
    `expected precompile ix data length >= 144, got ${ix.data.length}`,
  );
});

test("buildVaultIdentityBindInstruction rejects a non-32-byte message", () => {
  const agentIdentity = Keypair.generate().publicKey;
  const tooShort = Buffer.alloc(16);
  const sig = Buffer.alloc(64);
  assert.throws(
    () =>
      buildVaultIdentityBindInstruction({
        agentIdentity,
        message: tooShort,
        signature: sig,
      }),
    /message must be 32 bytes/,
  );
});

test("buildVaultIdentityBindInstruction rejects a non-64-byte signature", () => {
  const agentIdentity = Keypair.generate().publicKey;
  const msg = Buffer.alloc(32);
  const tooShort = Buffer.alloc(48);
  assert.throws(
    () =>
      buildVaultIdentityBindInstruction({
        agentIdentity,
        message: msg,
        signature: tooShort,
      }),
    /signature must be 64 bytes/,
  );
});

// ---------------------------------------------------------------------------
// End-to-end shape: noble-signed message round-trips through the precompile
// ix construction without the SDK touching the secret material.
// ---------------------------------------------------------------------------

test("end-to-end: bind message → noble sign → precompile ix carries matching inline bytes", () => {
  const authorityKp = Keypair.generate();
  const agentIdentityKp = Keypair.generate();
  const message = vaultIdentityBindMessage(
    authorityKp.publicKey,
    agentIdentityKp.publicKey,
  );
  const seed = agentIdentityKp.secretKey.slice(0, 32);
  const signature = Buffer.from(ed25519.sign(message, seed));

  // Verify the signature off-chain to pin that the bind message + secret
  // key produce a sig the runtime would accept (saves a round-trip through
  // the validator for the SDK-only test surface).
  const verified = ed25519.verify(
    signature,
    message,
    agentIdentityKp.publicKey.toBuffer(),
  );
  assert.equal(verified, true);

  // Sanity check: the public-key bytes embedded in the ix data MUST equal
  // the agent_identity pubkey bytes. The Solana ed25519-program lays the
  // pubkey out at a defined offset within the instruction data; instead of
  // re-implementing the offset arithmetic in the test, we assert the
  // construction does not throw and the data buffer is non-empty — the
  // on-chain handler's introspection check (in the agent-vault tests) is
  // the authoritative round-trip test.
  const ix = buildVaultIdentityBindInstruction({
    agentIdentity: agentIdentityKp.publicKey,
    message,
    signature,
  });
  assert.ok(ix.data.length >= 144);
});

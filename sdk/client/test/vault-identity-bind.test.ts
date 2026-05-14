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
 *
 * ADR-087: tests migrated from `@solana/web3.js` v1 to the kit `Address`
 * brand. `web3.Keypair` is reached via Anchor's re-export so this test
 * file does not pull a direct `@solana/web3.js` dep.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { web3 } from "@coral-xyz/anchor";
import { getAddressEncoder, type Address } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";

import {
  VAULT_IDENTITY_BIND_DOMAIN,
  ED25519_PROGRAM_ADDRESS,
  vaultIdentityBindMessage,
  buildVaultIdentityBindInstruction,
} from "../src/index.js";

const { Keypair } = web3;

/** Generate a fresh kit Address backed by a random ed25519 keypair. */
function newAddress(): Address {
  return Keypair.generate().publicKey.toBase58() as Address;
}

/** Raw 32 pubkey bytes for an Address (matches v1 `pubkey.toBuffer()`). */
function pubkeyBytes(addr: Address): Uint8Array {
  return getAddressEncoder().encode(addr) as Uint8Array;
}

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
  const authority = newAddress();
  const agentIdentity = newAddress();

  const got = vaultIdentityBindMessage(authority, agentIdentity);
  const expected = crypto
    .createHash("sha256")
    .update(VAULT_IDENTITY_BIND_DOMAIN)
    .update(pubkeyBytes(authority))
    .update(pubkeyBytes(agentIdentity))
    .digest();

  assert.deepEqual(got, expected);
  assert.equal(got.length, 32);
});

test("vaultIdentityBindMessage is deterministic for the same inputs", () => {
  const authority = newAddress();
  const agentIdentity = newAddress();
  const first = vaultIdentityBindMessage(authority, agentIdentity);
  const second = vaultIdentityBindMessage(authority, agentIdentity);
  assert.deepEqual(first, second);
});

test("vaultIdentityBindMessage is injective across the authority leg", () => {
  const authorityA = newAddress();
  const authorityB = newAddress();
  const agentIdentity = newAddress();
  assert.notDeepEqual(
    vaultIdentityBindMessage(authorityA, agentIdentity),
    vaultIdentityBindMessage(authorityB, agentIdentity),
  );
});

test("vaultIdentityBindMessage is injective across the agent_identity leg", () => {
  const authority = newAddress();
  const agentIdentityA = newAddress();
  const agentIdentityB = newAddress();
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
  const authority = newAddress();
  const agentIdentity = newAddress();
  const tagged = vaultIdentityBindMessage(authority, agentIdentity);
  const untagged = crypto
    .createHash("sha256")
    .update(pubkeyBytes(authority))
    .update(pubkeyBytes(agentIdentity))
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
// The SDK helper hand-rolls the Ed25519 precompile data layout (ADR-087:
// no `Ed25519Program.createInstructionWithPublicKey` dependency on the v1
// stack). Length validation and program-id wiring belong in the SDK
// contract because they're the off-chain mirror of the on-chain
// expectation.
// ---------------------------------------------------------------------------

test("ED25519_PROGRAM_ADDRESS matches the Solana native precompile address", () => {
  assert.equal(
    ED25519_PROGRAM_ADDRESS,
    "Ed25519SigVerify111111111111111111111111111",
  );
});

test("buildVaultIdentityBindInstruction targets the Ed25519 precompile and emits a 144-byte data buffer", () => {
  const authority = newAddress();
  const agentIdentityKp = Keypair.generate();
  const agentIdentity = agentIdentityKp.publicKey.toBase58() as Address;
  const message = vaultIdentityBindMessage(authority, agentIdentity);
  const seed = agentIdentityKp.secretKey.slice(0, 32);
  const signature = Buffer.from(ed25519.sign(message, seed));

  const ix = buildVaultIdentityBindInstruction({
    agentIdentity,
    message,
    signature,
  });

  assert.equal(ix.programAddress, ED25519_PROGRAM_ADDRESS);
  assert.equal(ix.accounts.length, 0);
  // The precompile ix data layout starts with `num_signatures = 1` followed
  // by 14 bytes of offsets, so the data length floor is 16 + 64 + 32 + 32 =
  // 144 bytes for one inline (sig, pubkey, message) tuple.
  assert.equal(ix.data.length, 144);
});

test("buildVaultIdentityBindInstruction lays out pubkey/sig/message at the documented offsets", () => {
  // Cross-check the hand-rolled precompile bytes against a known fixture.
  // The on-chain handler's `verify_ed25519_precompile` introspection reads
  // offsets out of the first 16 bytes; this test mirrors that read so a
  // future refactor of the layout surfaces here, not at the runtime.
  const authority = newAddress();
  const agentIdentityKp = Keypair.generate();
  const agentIdentity = agentIdentityKp.publicKey.toBase58() as Address;
  const message = vaultIdentityBindMessage(authority, agentIdentity);
  const seed = agentIdentityKp.secretKey.slice(0, 32);
  const signature = Buffer.from(ed25519.sign(message, seed));

  const ix = buildVaultIdentityBindInstruction({
    agentIdentity,
    message,
    signature,
  });

  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  assert.equal(ix.data[0], 1, "num_signatures should be 1");
  assert.equal(ix.data[1], 0, "padding should be 0");
  const sigOffset = view.getUint16(2, true);
  const pubkeyOffset = view.getUint16(6, true);
  const messageOffset = view.getUint16(10, true);
  const messageSize = view.getUint16(12, true);
  assert.equal(pubkeyOffset, 16);
  assert.equal(sigOffset, 16 + 32);
  assert.equal(messageOffset, 16 + 32 + 64);
  assert.equal(messageSize, 32);

  // Inline pubkey bytes must equal the agent_identity address-encoded bytes.
  const inlinePubkey = ix.data.slice(pubkeyOffset, pubkeyOffset + 32);
  assert.deepEqual(inlinePubkey, pubkeyBytes(agentIdentity));

  // Inline signature must equal the noble-signed bytes verbatim.
  const inlineSig = ix.data.slice(sigOffset, sigOffset + 64);
  assert.deepEqual(inlineSig, new Uint8Array(signature));

  // Inline message must equal the bind-message digest.
  const inlineMsg = ix.data.slice(messageOffset, messageOffset + 32);
  assert.deepEqual(inlineMsg, new Uint8Array(message));
});

test("buildVaultIdentityBindInstruction rejects a non-32-byte message", () => {
  const agentIdentity = newAddress();
  const tooShort = new Uint8Array(16);
  const sig = new Uint8Array(64);
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
  const agentIdentity = newAddress();
  const msg = new Uint8Array(32);
  const tooShort = new Uint8Array(48);
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
  const authority = authorityKp.publicKey.toBase58() as Address;
  const agentIdentity = agentIdentityKp.publicKey.toBase58() as Address;
  const message = vaultIdentityBindMessage(authority, agentIdentity);
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

  const ix = buildVaultIdentityBindInstruction({
    agentIdentity,
    message,
    signature,
  });
  assert.equal(ix.data.length, 144);
  assert.equal(ix.programAddress, ED25519_PROGRAM_ADDRESS);
});

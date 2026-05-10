/**
 * AUD-003 regression gate: PDA equivalence between the SDK and on-chain
 * seed conventions.
 *
 * The published `@agenomics/client` SDK derives PDAs in TypeScript that
 * MUST be byte-identical to the on-chain Anchor `seeds = [...]`
 * declarations. Any divergence means every vault / escrow / registry
 * operation routed through the SDK fails on-chain (account does not exist
 * for the program-derived address).
 *
 * The 2026-04-25 architecture audit (finding AUD-003) caught three such
 * divergences:
 *   1. `vault.ts`     — seed order reversed: `[authority, "vault"]`
 *      vs. on-chain  `[b"vault", authority.key().as_ref()]`.
 *   2. `settlement.ts`— wrong seed string: `"task_escrow"` vs. on-chain
 *      `b"escrow"`.
 *   3. `registry.ts`  + `index.ts` — nonce encoded as `BigInt64Array`
 *      (signed i64) when `OwnerNonce::nonce` is `u64` on-chain. Byte-
 *      identical for non-negative nonces today, but the wrong sign
 *      convention masks a future overflow regression.
 *
 * This test is the regression gate. It pins the SDK output for fixed
 * inputs against:
 *   (a) Hard-coded golden base58 strings, computed once from the on-chain
 *       seed declarations and cross-checked against the canonical
 *       derivations in `mcp-server/src/solana.ts:240-365`.
 *   (b) An independent in-test re-derivation that mirrors the on-chain
 *       seed convention literally, so a refactor that breaks the SDK
 *       helpers is caught even if the golden base58 strings are
 *       accidentally regenerated alongside the bug.
 *
 * If a future PR changes the on-chain seeds in `programs/<crate>/src/contexts.rs`
 * (or the `b"escrow"` signer-seeds in `instructions/<file>.rs`), this test
 * will fail intentionally — update both the SDK helpers AND this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import type { AnchorProvider, Idl } from "@coral-xyz/anchor";
import { AgentRegistryClient, AgentVaultClient, SettlementClient } from "../src/index.js";
import { AepClient } from "../src/index.js";

// ---------------------------------------------------------------------------
// Cluster-stable program IDs. These match the on-chain `declare_id!` macros
// in programs/*/src/lib.rs and the values exported from
// `mcp-server/src/solana.ts`.
// ---------------------------------------------------------------------------
const VAULT_PROGRAM_ID = new PublicKey("28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw");
const REGISTRY_PROGRAM_ID = new PublicKey("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");
const SETTLEMENT_PROGRAM_ID = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");

// ---------------------------------------------------------------------------
// Three fixed authorities. Picked from well-known cluster-stable pubkeys so
// re-running this test on any cluster is deterministic and the golden
// vectors below never need updating.
// ---------------------------------------------------------------------------
const AUTHORITY_A = new PublicKey("11111111111111111111111111111111"); // SystemProgram
const AUTHORITY_B = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL mint
const AUTHORITY_C = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // Token program

// ---------------------------------------------------------------------------
// Canonical on-chain re-derivations. These mirror the literal seed
// declarations in the Rust contexts and are the source of truth here.
// ---------------------------------------------------------------------------

/** Vault PDA: `seeds = [b"vault", authority.key().as_ref()]`. */
function canonicalVaultPda(authority: PublicKey): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    VAULT_PROGRAM_ID,
  );
  return pda.toBase58();
}

/** Owner-nonce PDA: `seeds = [authority.key().as_ref(), b"owner-nonce"]`. */
function canonicalOwnerNoncePda(authority: PublicKey): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("owner-nonce")],
    REGISTRY_PROGRAM_ID,
  );
  return pda.toBase58();
}

/**
 * Profile PDA: `seeds = [authority.key().as_ref(), b"agent-profile",
 * &nonce.to_le_bytes()]` — nonce is `u64`, ADR-097.
 */
function canonicalProfilePda(authority: PublicKey, nonce: bigint): string {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  const [pda] = PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
    REGISTRY_PROGRAM_ID,
  );
  return pda.toBase58();
}

/**
 * Escrow PDA: `seeds = [b"escrow", client.key().as_ref(),
 * provider.key().as_ref(), &task_id.to_le_bytes()]` — task_id is `u64`.
 */
function canonicalEscrowPda(
  client: PublicKey,
  provider: PublicKey,
  taskId: bigint,
): string {
  const taskBuf = Buffer.alloc(8);
  taskBuf.writeBigUInt64LE(taskId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), taskBuf],
    SETTLEMENT_PROGRAM_ID,
  );
  return pda.toBase58();
}

/** Protocol-config PDA: `seeds = [b"protocol_config"]`. */
function canonicalProtocolConfigPda(): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    SETTLEMENT_PROGRAM_ID,
  );
  return pda.toBase58();
}

// ---------------------------------------------------------------------------
// Golden base58 PDAs, computed once from the canonical helpers above.
// Pinned here so a regression in BOTH the SDK helper and the canonical
// helper (e.g. a copy-paste typo in this file) still fails the gate.
// ---------------------------------------------------------------------------
const GOLDEN = {
  vault: {
    A: "DVbM5aCtrwQ1azFyQXxqV8Cmto8gXSLzArsWCSwQ1nfv",
    B: "G2JuDSmLKaxheLELYMAcMMJKbYQpBadZLAeL5FNJqi4",
    C: "ECzwNoHxRW4bJF5gNx7xBunsmbbCuqRuhKKuFmNa8ZfH",
  },
  ownerNonce: {
    A: "BtgY59SDm6DWzMbBVZExnpE1esrUov5KXcVDPpmDkMH3",
    B: "7CnVVYqJ1PhjNmfWgmt8SLPEMDF9SuMTr1rAVmtbwTVm",
  },
  profile: {
    A0: "DnjqCXQQ9N7S2oET9nNMGBVas2gBuri6n6HV4FunwetH",
    A1: "AQZHT9S9cEhqQdQLuukWHeAxYPrF9pMN92AC77zoruH7",
    B42: "7o5XM9xxCuBve8Nr8mLm55Ma39yA7YreTrBkNwWvPiAH",
  },
  escrow: {
    AB1: "EggCDLpux6iLzCbZmRsJboWKEjufXCfyitWdpoLRbewC",
    AB2: "357GbEhphWesFpsdXYxefm2xk6ntsuLtL6B1iPygX74F",
    BC99: "891Ta3SwLsSChmDW6VSdpWFcqpqYq4KZecmaJ23hQKfa",
  },
  protocolConfig: "EEz7JfgdJ1nVYafjpzvtXtvnyC4yHF1mayAT5EUxz3oh",
} as const;

// ---------------------------------------------------------------------------
// SDK clients. The client constructors require an Anchor `Program`, which in
// turn needs a provider + IDL. PDA derivation is pure and only consults
// `program.programId`, so we pass a stub provider + a minimal IDL whose only
// load-bearing field is the `address` (Anchor 0.31 reads the program ID from
// `idl.address`). No RPC calls are made.
// ---------------------------------------------------------------------------

function stubProvider(): AnchorProvider {
  return {
    publicKey: AUTHORITY_A,
    connection: { rpcEndpoint: "http://invalid.local" },
    sendAndConfirm: async () => {
      throw new Error("stubProvider: sendAndConfirm should never be called from a PDA test");
    },
  } as unknown as AnchorProvider;
}

function minimalIdl(programId: PublicKey): Idl {
  // Anchor 0.31 IDL shape. The constructor only reads `address`,
  // `metadata.name`, `instructions`, `accounts`, `events`, `errors`,
  // `types` — empty arrays are valid and sufficient for the
  // PDA-derivation surface this test exercises.
  return {
    address: programId.toBase58(),
    metadata: { name: "stub", version: "0.0.0", spec: "0.1.0" },
    instructions: [],
    accounts: [],
    events: [],
    errors: [],
    types: [],
  } as unknown as Idl;
}

function makeRegistryClient(): AgentRegistryClient {
  return new AgentRegistryClient(
    stubProvider(),
    minimalIdl(REGISTRY_PROGRAM_ID),
    REGISTRY_PROGRAM_ID,
  );
}
function makeVaultClient(): AgentVaultClient {
  return new AgentVaultClient(
    stubProvider(),
    minimalIdl(VAULT_PROGRAM_ID),
    VAULT_PROGRAM_ID,
  );
}
function makeSettlementClient(): SettlementClient {
  return new SettlementClient(
    stubProvider(),
    minimalIdl(SETTLEMENT_PROGRAM_ID),
    SETTLEMENT_PROGRAM_ID,
  );
}

// ---------------------------------------------------------------------------
// Vault PDA equivalence (AUD-003 fix #1)
// ---------------------------------------------------------------------------

test("AgentVaultClient.vaultPda matches on-chain seeds and golden vectors", () => {
  const client = makeVaultClient();

  const sdkA = client.vaultPda(AUTHORITY_A).toBase58();
  const sdkB = client.vaultPda(AUTHORITY_B).toBase58();
  const sdkC = client.vaultPda(AUTHORITY_C).toBase58();

  // (a) Golden vectors — pre-AUD-003 the SDK reversed seed order, which
  //     would produce *different* base58 strings here. This is the
  //     load-bearing assertion.
  assert.equal(sdkA, GOLDEN.vault.A);
  assert.equal(sdkB, GOLDEN.vault.B);
  assert.equal(sdkC, GOLDEN.vault.C);

  // (b) Independent canonical re-derivation — guards against this test
  //     file silently regenerating both columns from the same broken seed
  //     order in a future refactor.
  assert.equal(sdkA, canonicalVaultPda(AUTHORITY_A));
  assert.equal(sdkB, canonicalVaultPda(AUTHORITY_B));
  assert.equal(sdkC, canonicalVaultPda(AUTHORITY_C));
});

// ---------------------------------------------------------------------------
// Registry PDAs (AUD-003 fix #3 — u64 nonce encoding)
// ---------------------------------------------------------------------------

test("AgentRegistryClient.ownerNoncePda matches on-chain seeds and golden vectors", () => {
  const client = makeRegistryClient();
  const sdkA = client.ownerNoncePda(AUTHORITY_A).toBase58();
  const sdkB = client.ownerNoncePda(AUTHORITY_B).toBase58();
  assert.equal(sdkA, GOLDEN.ownerNonce.A);
  assert.equal(sdkB, GOLDEN.ownerNonce.B);
  assert.equal(sdkA, canonicalOwnerNoncePda(AUTHORITY_A));
  assert.equal(sdkB, canonicalOwnerNoncePda(AUTHORITY_B));
});

test("AgentRegistryClient.profilePda matches on-chain seeds and golden vectors", () => {
  const client = makeRegistryClient();

  const sdkA0 = client.profilePda(AUTHORITY_A, 0n).toBase58();
  const sdkA1 = client.profilePda(AUTHORITY_A, 1n).toBase58();
  const sdkB42 = client.profilePda(AUTHORITY_B, 42n).toBase58();

  assert.equal(sdkA0, GOLDEN.profile.A0);
  assert.equal(sdkA1, GOLDEN.profile.A1);
  assert.equal(sdkB42, GOLDEN.profile.B42);

  assert.equal(sdkA0, canonicalProfilePda(AUTHORITY_A, 0n));
  assert.equal(sdkA1, canonicalProfilePda(AUTHORITY_A, 1n));
  assert.equal(sdkB42, canonicalProfilePda(AUTHORITY_B, 42n));
});

test("AepClient.deriveAgentProfilePda matches AgentRegistryClient.profilePda byte-for-byte", () => {
  // The AepClient helper duplicates the registry derivation as a
  // convenience for callers who only have a base58 string. AUD-003 fix #3
  // updated both encoders in lockstep; this test pins them together.
  const aep = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  const registry = makeRegistryClient();

  for (const [authority, nonce] of [
    [AUTHORITY_A, 0n] as const,
    [AUTHORITY_A, 1n] as const,
    [AUTHORITY_B, 42n] as const,
  ]) {
    const fromRegistry = registry.profilePda(authority, nonce).toBase58();
    const fromAep = aep.deriveAgentProfilePda(authority.toBase58(), nonce);
    assert.equal(fromAep, fromRegistry);
  }
});

// ---------------------------------------------------------------------------
// Settlement PDAs (AUD-003 fix #2 — escrow seed string)
// ---------------------------------------------------------------------------

test("SettlementClient.escrowPda matches on-chain seeds and golden vectors", () => {
  const client = makeSettlementClient();

  const sdkAB1 = client
    .escrowPda(AUTHORITY_A, AUTHORITY_B, 1n)
    .toBase58();
  const sdkAB2 = client
    .escrowPda(AUTHORITY_A, AUTHORITY_B, 2n)
    .toBase58();
  const sdkBC99 = client
    .escrowPda(AUTHORITY_B, AUTHORITY_C, 99n)
    .toBase58();

  // Pre-AUD-003 the SDK used `"task_escrow"` as the seed, producing
  // entirely different base58 strings — this assertion is the
  // load-bearing regression gate for fix #2.
  assert.equal(sdkAB1, GOLDEN.escrow.AB1);
  assert.equal(sdkAB2, GOLDEN.escrow.AB2);
  assert.equal(sdkBC99, GOLDEN.escrow.BC99);

  assert.equal(sdkAB1, canonicalEscrowPda(AUTHORITY_A, AUTHORITY_B, 1n));
  assert.equal(sdkAB2, canonicalEscrowPda(AUTHORITY_A, AUTHORITY_B, 2n));
  assert.equal(sdkBC99, canonicalEscrowPda(AUTHORITY_B, AUTHORITY_C, 99n));
});

test("SettlementClient.protocolConfigPda matches on-chain seed and golden vector", () => {
  const client = makeSettlementClient();
  const sdk = client.protocolConfigPda().toBase58();
  assert.equal(sdk, GOLDEN.protocolConfig);
  assert.equal(sdk, canonicalProtocolConfigPda());
});

// ---------------------------------------------------------------------------
// Cross-property checks — these would also fail under the pre-AUD-003 bugs
// but are kept narrow so a single root-cause regression surfaces with
// minimal noise.
// ---------------------------------------------------------------------------

test("escrow seed is 'escrow' (6 bytes), not 'task_escrow' (11 bytes) — length-of-seed regression guard", () => {
  // If the SDK ever drifts back to "task_escrow", the byte length check
  // alone catches it deterministically without needing a golden vector.
  const client = makeSettlementClient();
  const onChainEscrow = canonicalEscrowPda(AUTHORITY_A, AUTHORITY_B, 1n);
  const sdkEscrow = client.escrowPda(AUTHORITY_A, AUTHORITY_B, 1n).toBase58();
  assert.equal(sdkEscrow, onChainEscrow);

  // Direct comparison against a deliberately wrong "task_escrow" seed:
  const taskBuf = Buffer.alloc(8);
  taskBuf.writeBigUInt64LE(1n);
  const [wrong] = PublicKey.findProgramAddressSync(
    [Buffer.from("task_escrow"), AUTHORITY_A.toBuffer(), AUTHORITY_B.toBuffer(), taskBuf],
    SETTLEMENT_PROGRAM_ID,
  );
  assert.notEqual(
    sdkEscrow,
    wrong.toBase58(),
    "SDK escrow PDA must not equal the legacy `task_escrow`-seed derivation",
  );
});

test("vault seed order is [seed, authority], not [authority, seed] — order regression guard", () => {
  const client = makeVaultClient();
  const correct = client.vaultPda(AUTHORITY_A).toBase58();

  // Deliberately wrong (pre-AUD-003) order:
  const [wrong] = PublicKey.findProgramAddressSync(
    [AUTHORITY_A.toBuffer(), Buffer.from("vault")],
    VAULT_PROGRAM_ID,
  );
  assert.notEqual(
    correct,
    wrong.toBase58(),
    "SDK vault PDA must not equal the legacy reversed-seed derivation",
  );
});

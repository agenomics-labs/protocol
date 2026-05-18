/**
 * SDK-F2 (cycle-4 audit `06-sdk.md` finding F2) — cross-package seed-parity
 * gate between the published `@agenomics/client` SDK and the on-chain
 * Anchor program source.
 *
 * WHY THIS EXISTS (and why `pda-equivalence.test.ts` is NOT sufficient):
 *
 *   `pda-equivalence.test.ts` pins SDK output against (a) hard-coded golden
 *   base58 strings and (b) a hand-written canonical re-derivation that
 *   *mirrors* the on-chain seed convention as SDK-local string literals in
 *   the test file. Both columns live in the SDK package.
 *
 *   ADR-141 (codama generation) is now `Accepted` (2026-05-18). The
 *   `owner-nonce`, `vault`, `escrow`, and `protocol_config` PDAs derive
 *   through Codama-generated `find*Pda` helpers whose seed bytes come
 *   straight from the committed Anchor IDL, guarded by the CI codegen-diff
 *   gate. The two PDAs whose seeds reference a runtime/cross-account value
 *   (`agent-profile`: third seed is `owner_nonce.nonce`; `delegation`:
 *   fourth seed is a runtime u8 `nonce`) have no static codegen and remain
 *   hand-derivations — for THOSE the seed *strings* are still not in the
 *   IDL, so the CI IDL-drift gate (`scripts/check-idl.sh`) cannot see a
 *   coordinated rename. A PR that renames such an on-chain seed AND the SDK
 *   constant in lockstep passes every other gate green while every consumer
 *   silently derives a valid-looking but un-owned PDA. This is the exact
 *   bug-class AUD-003 caught once. This test closes that gap for ALL six
 *   PDAs by reading the on-chain Rust source as the trust root, and
 *   ADDITIONALLY (ADR-141 block below) asserts the generated helpers agree
 *   byte-for-byte with both the façade and the program-sourced derivation.
 *
 * WHAT THIS TEST DOES DIFFERENTLY:
 *
 *   It reads the *on-chain Rust program source* (the `programs` crate
 *   `contexts.rs` / `state.rs` / `lib.rs` files) at
 *   test time and extracts the literal seed byte-strings the Anchor
 *   `seeds = [...]` constraints (and the `*_SEED` consts they reference)
 *   actually compile to. It then independently derives each PDA from those
 *   PROGRAM-SOURCED seeds and asserts the public SDK client method returns a
 *   byte-identical address for fixed input vectors.
 *
 *   The source of truth here is the program crate, NOT an SDK-local mirror.
 *   If a future PR renames `b"vault"` -> `b"agent-vault"` on-chain, this
 *   test re-parses the new seed, the SDK constant (still `"vault"`) no longer
 *   matches, and the gate fails — even though IDL JSON is unchanged and the
 *   author updated the SDK constant only on the SDK side. The seed-rename gap
 *   the IDL gate cannot see is now closed in code.
 *
 * `06-sdk.md` F2 mandate, now discharged: ADR-141 moved Proposed ->
 * Accepted (2026-05-18). The codama major is pinned in
 * `sdk/client/package.json` devDependencies, the generated output is
 * committed in-tree under `src/generated/`, and the CI codegen-diff gate
 * (`npm run codegen:check`) fails on a stale tree. This seed-parity test
 * remains the cross-stack proof regardless of generation, and the new
 * ADR-141 block below adds a third column: the generated `find*Pda`
 * helpers must agree byte-for-byte with the façade AND the program-sourced
 * derivation, so a regenerated-but-wrong tree (or a façade that stops
 * delegating to codegen) fails here too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { web3 } from "@coral-xyz/anchor";
import type { AnchorProvider, Idl } from "@coral-xyz/anchor";
import type { Address } from "@solana/kit";
import { AgentRegistryClient, AgentVaultClient, SettlementClient } from "../src/index.js";
import { hookSignerPda } from "../src/cctp-hook.js";
// ADR-141: assert the generated helpers directly — the third parity column.
import { findOwnerNoncePda } from "../src/generated/registry/pdas/ownerNonce.js";
import { findVaultPda } from "../src/generated/vault/pdas/vault.js";
import { findEscrowPda } from "../src/generated/settlement/pdas/escrow.js";
import { findProtocolConfigPda } from "../src/generated/settlement/pdas/protocolConfig.js";

const { PublicKey } = web3;
type PublicKey = web3.PublicKey;

const HERE = dirname(fileURLToPath(import.meta.url));
// sdk/client/test -> repo root
const REPO_ROOT = join(HERE, "..", "..", "..");

function readProgramSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// Seed extraction from on-chain Rust source.
//
// Two forms appear in `seeds = [...]`:
//   1. inline byte-string literal:  b"vault"
//   2. a referenced const:          PROTOCOL_CONFIG_SEED  (defined elsewhere
//                                     as `pub const X: &[u8] = b"...";`)
// Both are resolved here against the literal program text so the test
// tracks whatever the program actually compiles.
// ---------------------------------------------------------------------------

/** All distinct `b"..."` byte-string literals present in a source file. */
function byteStringLiterals(src: string): Set<string> {
  const out = new Set<string>();
  const re = /b"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** Resolve `pub const NAME: &[u8] = b"...";` to its literal value. */
function constSeed(src: string, name: string): string {
  const re = new RegExp(
    `const\\s+${name}\\s*:\\s*&\\[u8\\]\\s*=\\s*b"((?:[^"\\\\]|\\\\.)*)"`,
  );
  const m = re.exec(src);
  assert.ok(
    m,
    `on-chain const ${name} not found / shape changed — seed-parity cannot be proven`,
  );
  return m![1];
}

/**
 * Assert a seed the SDK depends on is literally present in the program
 * source. This is the load-bearing cross-package link: it fails if the
 * on-chain seed is renamed without the SDK following.
 */
function assertSeedInProgram(src: string, seed: string, ctx: string): void {
  assert.ok(
    byteStringLiterals(src).has(seed),
    `seed "${seed}" (${ctx}) not found as a b"..." literal in the on-chain ` +
      `program source — on-chain seed was renamed but the SDK still derives ` +
      `with the old seed; every PDA on this surface is now wrong/un-owned`,
  );
}

// ---------------------------------------------------------------------------
// Program IDs (match declare_id! in programs/*/src/lib.rs).
// ---------------------------------------------------------------------------
const VAULT_PROGRAM_ID_BS58 = "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw";
const REGISTRY_PROGRAM_ID_BS58 = "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv";
const SETTLEMENT_PROGRAM_ID_BS58 = "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95";

const VAULT_PROGRAM_ID = new PublicKey(VAULT_PROGRAM_ID_BS58);
const REGISTRY_PROGRAM_ID = new PublicKey(REGISTRY_PROGRAM_ID_BS58);
const SETTLEMENT_PROGRAM_ID = new PublicKey(SETTLEMENT_PROGRAM_ID_BS58);

const VAULT_PROGRAM_ADDR = VAULT_PROGRAM_ID_BS58 as Address;
const REGISTRY_PROGRAM_ADDR = REGISTRY_PROGRAM_ID_BS58 as Address;
const SETTLEMENT_PROGRAM_ADDR = SETTLEMENT_PROGRAM_ID_BS58 as Address;

// Fixed, cluster-stable input vectors (same pubkeys as pda-equivalence).
const AUTH_A = new PublicKey("11111111111111111111111111111111");
const AUTH_B = new PublicKey("So11111111111111111111111111111111111111112");
const AUTH_C = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const AUTH_A_ADDR = AUTH_A.toBase58() as Address;
const AUTH_B_ADDR = AUTH_B.toBase58() as Address;

// ---------------------------------------------------------------------------
// Stub Anchor program plumbing (PDA derivation is pure; no RPC).
// ---------------------------------------------------------------------------
function stubProvider(): AnchorProvider {
  return {
    publicKey: AUTH_A,
    connection: { rpcEndpoint: "http://invalid.local" },
    sendAndConfirm: async () => {
      throw new Error("stubProvider: sendAndConfirm must not be called in a PDA test");
    },
  } as unknown as AnchorProvider;
}
function minimalIdl(programId: PublicKey): Idl {
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
const vaultClient = new AgentVaultClient(stubProvider(), minimalIdl(VAULT_PROGRAM_ID) as any, VAULT_PROGRAM_ADDR);
const registryClient = new AgentRegistryClient(stubProvider(), minimalIdl(REGISTRY_PROGRAM_ID) as any, REGISTRY_PROGRAM_ADDR);
const settlementClient = new SettlementClient(stubProvider(), minimalIdl(SETTLEMENT_PROGRAM_ID) as any, SETTLEMENT_PROGRAM_ADDR);

function le8(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

// ===========================================================================
// vault PDA: on-chain `seeds = [b"vault", authority.key().as_ref()]`
//            (programs/agent-vault/src/contexts.rs)
// ===========================================================================
test("vault PDA — SDK derivation matches seed parsed from agent-vault program source", async () => {
  const src = readProgramSource("programs/agent-vault/src/contexts.rs");
  assertSeedInProgram(src, "vault", "agent-vault vault PDA");

  for (const auth of [AUTH_A, AUTH_B, AUTH_C]) {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auth.toBuffer()],
      VAULT_PROGRAM_ID,
    );
    const sdk = await vaultClient.vaultPda(auth.toBase58() as Address);
    assert.equal(
      sdk,
      expected.toBase58(),
      `SDK vault PDA != PDA derived from the on-chain "vault" seed for ${auth.toBase58()}`,
    );
  }
});

// ===========================================================================
// delegation grant PDA: on-chain
//   `seeds = [b"delegation", vault.key().as_ref(), grantee.as_ref(), &[nonce]]`
// ===========================================================================
test("delegation PDA — SDK derivation matches seed parsed from agent-vault program source", async () => {
  const src = readProgramSource("programs/agent-vault/src/contexts.rs");
  assertSeedInProgram(src, "delegation", "agent-vault delegation grant PDA");

  const vaultPda = await vaultClient.vaultPda(AUTH_A_ADDR);
  const grantee = AUTH_B;
  const nonce = 7;
  const [expected] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("delegation"),
      new PublicKey(vaultPda).toBuffer(),
      grantee.toBuffer(),
      Buffer.from([nonce]),
    ],
    VAULT_PROGRAM_ID,
  );
  const sdk = await vaultClient.delegationGrantPda(
    vaultPda,
    grantee.toBase58() as Address,
    nonce,
  );
  assert.equal(
    sdk,
    expected.toBase58(),
    'SDK delegation PDA != PDA derived from the on-chain "delegation" seed',
  );
});

// ===========================================================================
// owner-nonce + agent-profile PDAs: on-chain (agent-registry/src/contexts.rs)
//   owner-nonce:  `seeds = [authority.key().as_ref(), b"owner-nonce"]`
//   profile:      `seeds = [authority, b"agent-profile", &nonce.to_le_bytes()]`
// ===========================================================================
test("owner-nonce + agent-profile PDAs — SDK matches seeds parsed from agent-registry source", async () => {
  const src = readProgramSource("programs/agent-registry/src/contexts.rs");
  assertSeedInProgram(src, "owner-nonce", "agent-registry owner-nonce PDA");
  assertSeedInProgram(src, "agent-profile", "agent-registry agent-profile PDA");

  for (const auth of [AUTH_A, AUTH_B]) {
    const [expectedNonce] = PublicKey.findProgramAddressSync(
      [auth.toBuffer(), Buffer.from("owner-nonce")],
      REGISTRY_PROGRAM_ID,
    );
    assert.equal(
      await registryClient.ownerNoncePda(auth.toBase58() as Address),
      expectedNonce.toBase58(),
      `SDK owner-nonce PDA != on-chain-seed derivation for ${auth.toBase58()}`,
    );
  }

  for (const [auth, nonce] of [
    [AUTH_A, 0n],
    [AUTH_A, 1n],
    [AUTH_B, 42n],
  ] as const) {
    const [expectedProfile] = PublicKey.findProgramAddressSync(
      [auth.toBuffer(), Buffer.from("agent-profile"), le8(nonce)],
      REGISTRY_PROGRAM_ID,
    );
    assert.equal(
      await registryClient.profilePda(auth.toBase58() as Address, nonce),
      expectedProfile.toBase58(),
      `SDK agent-profile PDA != on-chain-seed derivation for ${auth.toBase58()}/${nonce}`,
    );
  }
});

// ===========================================================================
// escrow + protocol_config PDAs: on-chain (settlement/src/contexts.rs +
//   settlement/src/state.rs `PROTOCOL_CONFIG_SEED`)
//   escrow:          `seeds = [b"escrow", client, provider, &task_id.to_le_bytes()]`
//   protocol_config: `seeds = [PROTOCOL_CONFIG_SEED]` (= b"protocol_config")
// ===========================================================================
test("escrow + protocol_config PDAs — SDK matches seeds parsed from settlement source", async () => {
  const ctxSrc = readProgramSource("programs/settlement/src/contexts.rs");
  const stateSrc = readProgramSource("programs/settlement/src/state.rs");
  assertSeedInProgram(ctxSrc, "escrow", "settlement escrow PDA");
  // protocol_config is a referenced const — resolve it against state.rs.
  const protocolConfigSeed = constSeed(stateSrc, "PROTOCOL_CONFIG_SEED");
  assert.equal(
    protocolConfigSeed,
    "protocol_config",
    "on-chain PROTOCOL_CONFIG_SEED value changed — SDK settlement.ts constant must follow",
  );

  for (const [client, provider, taskId] of [
    [AUTH_A, AUTH_B, 1n],
    [AUTH_A, AUTH_B, 2n],
    [AUTH_B, AUTH_C, 99n],
  ] as const) {
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), le8(taskId)],
      SETTLEMENT_PROGRAM_ID,
    );
    assert.equal(
      await settlementClient.escrowPda(
        client.toBase58() as Address,
        provider.toBase58() as Address,
        taskId,
      ),
      expected.toBase58(),
      `SDK escrow PDA != on-chain-seed derivation for ${client.toBase58()}/${provider.toBase58()}/${taskId}`,
    );
  }

  const [expectedCfg] = PublicKey.findProgramAddressSync(
    [Buffer.from(protocolConfigSeed)],
    SETTLEMENT_PROGRAM_ID,
  );
  assert.equal(
    await settlementClient.protocolConfigPda(),
    expectedCfg.toBase58(),
    "SDK protocol_config PDA != on-chain PROTOCOL_CONFIG_SEED derivation",
  );
});

// ===========================================================================
// hook_signer PDA: on-chain (cctp-hook/src/lib.rs `HOOK_SIGNER_SEED`)
//   `seeds = [HOOK_SIGNER_SEED, agent_authority.key().as_ref()]`
// ===========================================================================
test("hook_signer PDA — SDK matches HOOK_SIGNER_SEED parsed from cctp-hook source", async () => {
  const src = readProgramSource("programs/cctp-hook/src/lib.rs");
  const hookSignerSeed = constSeed(src, "HOOK_SIGNER_SEED");
  assert.equal(
    hookSignerSeed,
    "hook_signer",
    "on-chain HOOK_SIGNER_SEED value changed — SDK cctp-hook.ts constant must follow",
  );

  // Use a stable program id for cctp-hook (only PDA math, no RPC).
  const CCTP_HOOK_PROGRAM = "3yifMUYBpKpDr5oFR1V51U6Kxa1Acm2tJ4Lwa6E314vb" as Address;
  const [sdkPda] = await hookSignerPda(CCTP_HOOK_PROGRAM, AUTH_A_ADDR);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from(hookSignerSeed), AUTH_A.toBuffer()],
    new PublicKey(CCTP_HOOK_PROGRAM),
  );
  assert.equal(
    sdkPda,
    expected.toBase58(),
    "SDK hook_signer PDA != on-chain HOOK_SIGNER_SEED derivation",
  );
});

// ===========================================================================
// ADR-141 — Codama-generated `find*Pda` helpers are the third parity
// column. The committed generated trees under `src/generated/` are
// rendered from the Anchor IDL; their seed bytes MUST equal both the
// public façade output and an independent derivation from the on-chain
// Rust seed. If `npm run codegen` produced a stale/wrong tree, or a
// façade silently stopped delegating to codegen, this fails — even though
// `find*Pda` is byte-clean against itself.
// ===========================================================================
test("ADR-141 — generated find*Pda helpers match façade AND on-chain-sourced seeds", async () => {
  // owner-nonce (registry): generated `findOwnerNoncePda`.
  assertSeedInProgram(
    readProgramSource("programs/agent-registry/src/contexts.rs"),
    "owner-nonce",
    "agent-registry owner-nonce PDA (ADR-141 generated)",
  );
  for (const auth of [AUTH_A, AUTH_B, AUTH_C]) {
    const addr = auth.toBase58() as Address;
    const [gen] = await findOwnerNoncePda(
      { authority: addr },
      { programAddress: REGISTRY_PROGRAM_ADDR },
    );
    const [onchain] = PublicKey.findProgramAddressSync(
      [auth.toBuffer(), Buffer.from("owner-nonce")],
      REGISTRY_PROGRAM_ID,
    );
    assert.equal(gen, onchain.toBase58(), `gen owner-nonce != on-chain seed (${addr})`);
    assert.equal(
      gen,
      await registryClient.ownerNoncePda(addr),
      `gen owner-nonce != façade ownerNoncePda (${addr}) — façade stopped delegating to codegen`,
    );
  }

  // vault: generated `findVaultPda`.
  assertSeedInProgram(
    readProgramSource("programs/agent-vault/src/contexts.rs"),
    "vault",
    "agent-vault vault PDA (ADR-141 generated)",
  );
  for (const auth of [AUTH_A, AUTH_B, AUTH_C]) {
    const addr = auth.toBase58() as Address;
    const [gen] = await findVaultPda(
      { authority: addr },
      { programAddress: VAULT_PROGRAM_ADDR },
    );
    const [onchain] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), auth.toBuffer()],
      VAULT_PROGRAM_ID,
    );
    assert.equal(gen, onchain.toBase58(), `gen vault != on-chain seed (${addr})`);
    assert.equal(
      gen,
      await vaultClient.vaultPda(addr),
      `gen vault != façade vaultPda (${addr}) — façade stopped delegating to codegen`,
    );
  }

  // escrow + protocol_config (settlement): generated helpers.
  assertSeedInProgram(
    readProgramSource("programs/settlement/src/contexts.rs"),
    "escrow",
    "settlement escrow PDA (ADR-141 generated)",
  );
  for (const [client, provider, taskId] of [
    [AUTH_A, AUTH_B, 1n],
    [AUTH_B, AUTH_C, 99n],
  ] as const) {
    const [gen] = await findEscrowPda(
      {
        client: client.toBase58() as Address,
        provider: provider.toBase58() as Address,
        taskId,
      },
      { programAddress: SETTLEMENT_PROGRAM_ADDR },
    );
    const [onchain] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), le8(taskId)],
      SETTLEMENT_PROGRAM_ID,
    );
    assert.equal(gen, onchain.toBase58(), `gen escrow != on-chain seed`);
    assert.equal(
      gen,
      await settlementClient.escrowPda(
        client.toBase58() as Address,
        provider.toBase58() as Address,
        taskId,
      ),
      `gen escrow != façade escrowPda — façade stopped delegating to codegen`,
    );
  }

  const protocolConfigSeed = constSeed(
    readProgramSource("programs/settlement/src/state.rs"),
    "PROTOCOL_CONFIG_SEED",
  );
  const [genCfg] = await findProtocolConfigPda({
    programAddress: SETTLEMENT_PROGRAM_ADDR,
  });
  const [onchainCfg] = PublicKey.findProgramAddressSync(
    [Buffer.from(protocolConfigSeed)],
    SETTLEMENT_PROGRAM_ID,
  );
  assert.equal(genCfg, onchainCfg.toBase58(), "gen protocol_config != on-chain seed");
  assert.equal(
    genCfg,
    await settlementClient.protocolConfigPda(),
    "gen protocol_config != façade protocolConfigPda — façade stopped delegating to codegen",
  );
});

// ===========================================================================
// Negative control — proves the gate actually fires on a seed rename.
// ===========================================================================
test("seed-parity gate fails when the on-chain seed differs from the SDK seed (negative control)", async () => {
  // Simulate an on-chain rename b"vault" -> b"vault2" while the SDK constant
  // stays "vault": the SDK PDA must NOT match the renamed-seed derivation.
  const [renamed] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault2"), AUTH_A.toBuffer()],
    VAULT_PROGRAM_ID,
  );
  const sdk = await vaultClient.vaultPda(AUTH_A_ADDR);
  assert.notEqual(
    sdk,
    renamed.toBase58(),
    "SDK vault PDA must diverge from a renamed on-chain seed — this asserts " +
      "the parity test would catch a coordinated rename",
  );
});

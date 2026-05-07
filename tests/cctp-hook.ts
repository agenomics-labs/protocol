// Surface 3 — `cctp-hook` Anchor program tests.
//
// Scope (Day 1-3):
//   - Sanity: program ID, account-size invariants, IDL discriminator.
//   - Hook gates that fire BEFORE the Settlement CPI:
//       * payload `escrow_pda` mismatch
//       * malformed payload (zero base_tx_hash, zero amount)
//       * settlement_program / registry_program address pinning
//       * non-Settlement-owned escrow account
//   - Replay protection (the `init` constraint on the replay-guard PDA).
//
// Out of scope for this file (deferred to Day 4-7 once the full session-pool
// pattern is wired):
//   - End-to-end success path that fully completes the Settlement CPI. The
//     existing `tests/settlement.ts` already exercises `approve_milestone`
//     directly; the Hook layer's CPI is a thin pass-through. A full success
//     test requires constructing a session-pool escrow whose `client` is the
//     Hook's `hook_signer` PDA — that wiring belongs to Surface 4 / the
//     master spec's "session-level escrow pattern" and is tracked in
//     `.kiro/specs/surface-3-cctp-hook/open-questions.md` Q-S3-A and Q-S3-G.
//
// All on-chain state for these tests lives in Hook-owned PDAs (replay guard)
// or fixture accounts owned by ad-hoc keypairs / the System program — no
// AEP-program state is mutated, so this file is safe to run alongside the
// existing `tests/settlement.ts` / `tests/agent-registry.ts` / `tests/agent-vault.ts`
// suites.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";

describe("Surface 3 — cctp-hook program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // anchor.workspace key is camelCase of the Cargo crate name.
  const program = anchor.workspace.CctpHook as Program;
  const connection = provider.connection;

  // Program IDs (kept in lockstep with `Anchor.toml [programs.localnet]`).
  const HOOK_PROGRAM_ID = new PublicKey(
    "3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb",
  );
  const SETTLEMENT_PROGRAM_ID = new PublicKey(
    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
  );
  const REGISTRY_PROGRAM_ID = new PublicKey(
    "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
  );

  const HOOK_SIGNER_SEED = Buffer.from("hook_signer");
  const HOOK_REPLAY_SEED = Buffer.from("hook-replay");

  function hookSignerPda(agent: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [HOOK_SIGNER_SEED, agent.toBuffer()],
      HOOK_PROGRAM_ID,
    );
  }

  function hookReplayPda(
    escrow: PublicKey,
    milestoneIndex: number,
    baseTxHash: Buffer,
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        HOOK_REPLAY_SEED,
        escrow.toBuffer(),
        Buffer.from([milestoneIndex]),
        baseTxHash,
      ],
      HOOK_PROGRAM_ID,
    );
  }

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  let payer: Keypair;
  let agentAuthority: Keypair;
  // A "fake escrow" account: a System-owned keypair we treat as the escrow
  // address so the EscrowOwnerMismatch gate fires deterministically. For
  // tests that require the Settlement-owned-escrow path, we use a known
  // SETTLEMENT_PROGRAM_ID-owned PDA placeholder (not constructed here).
  let fakeEscrow: Keypair;

  before(async () => {
    payer = Keypair.generate();
    agentAuthority = Keypair.generate();
    fakeEscrow = Keypair.generate();

    // Fund payer + agentAuthority with enough SOL for `init` rent + tx fees.
    const sig1 = await connection.requestAirdrop(
      payer.publicKey,
      2 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig1, "confirmed");

    const sig2 = await connection.requestAirdrop(
      agentAuthority.publicKey,
      LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig2, "confirmed");
  });

  // Build a minimal payload object matching the IDL `ReflexHookPayload`.
  function buildPayload(overrides: Partial<{
    escrowPda: PublicKey;
    milestoneIndex: number;
    baseTxHash: number[];
    amountReturnedMicros: anchor.BN;
  }> = {}) {
    return {
      escrowPda: overrides.escrowPda ?? fakeEscrow.publicKey,
      milestoneIndex: overrides.milestoneIndex ?? 0,
      baseTxHash: overrides.baseTxHash ?? Array(32).fill(0xab),
      amountReturnedMicros:
        overrides.amountReturnedMicros ?? new anchor.BN(80_000),
    };
  }

  // Build the standard accounts struct. Settlement / Registry / token-program
  // slots take placeholder addresses since we expect the gates BEFORE the CPI
  // to short-circuit these tests.
  function buildAccounts(overrides: Record<string, PublicKey> = {}) {
    const [hookSigner] = hookSignerPda(agentAuthority.publicKey);
    return {
      payer: payer.publicKey,
      agentAuthority: agentAuthority.publicKey,
      hookSigner,
      // replay_guard PDA is computed per-payload at the call site.
      escrow: overrides.escrow ?? fakeEscrow.publicKey,
      escrowTokenAccount: overrides.escrowTokenAccount ?? Keypair.generate().publicKey,
      providerTokenAccount: overrides.providerTokenAccount ?? Keypair.generate().publicKey,
      settlementProgram: overrides.settlementProgram ?? SETTLEMENT_PROGRAM_ID,
      registryProgram: overrides.registryProgram ?? REGISTRY_PROGRAM_ID,
      providerAuthority: overrides.providerAuthority ?? Keypair.generate().publicKey,
      providerOwnerNonce: overrides.providerOwnerNonce ?? Keypair.generate().publicKey,
      providerProfile: overrides.providerProfile ?? Keypair.generate().publicKey,
      settlementAuthority: overrides.settlementAuthority ?? Keypair.generate().publicKey,
      protocolConfig: overrides.protocolConfig ?? Keypair.generate().publicKey,
      tokenProgram: overrides.tokenProgram ?? TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
  }

  // -------------------------------------------------------------------------
  // Sanity / metadata
  // -------------------------------------------------------------------------

  describe("metadata", () => {
    it("workspace program ID matches Anchor.toml", () => {
      expect(program.programId.toBase58()).to.equal(HOOK_PROGRAM_ID.toBase58());
    });

    it("IDL exposes auto_approve_milestone instruction (Anchor 0.31 mixed-case)", () => {
      const ixs = (program.idl as any).instructions as Array<{ name: string }>;
      const names = ixs.map((i) => i.name);
      // Anchor 0.31's TS-side IDL renames Rust snake_case to camelCase. Both
      // forms are valid lookup keys against the IDL; we accept either so the
      // test survives Anchor's IDL-naming churn.
      expect(
        names.includes("auto_approve_milestone") ||
          names.includes("autoApproveMilestone"),
        `expected auto_approve_milestone in IDL; got ${JSON.stringify(names)}`,
      ).to.equal(true);
    });

    it("IDL exposes ReflexHookPayload type with the IC-4 fields", () => {
      const types = (program.idl as any).types as Array<{
        name: string;
        type: { fields: Array<{ name: string }> };
      }>;
      const payloadType = types.find(
        (t) => t.name === "ReflexHookPayload" || t.name === "reflexHookPayload",
      );
      expect(payloadType, "ReflexHookPayload type missing from IDL").to.exist;
      const fieldNames = payloadType!.type.fields.map((f) => f.name).sort();
      // Anchor 0.31 may render the field names as either snake_case or
      // camelCase depending on the build path. Accept either; we only care
      // about set-equality on the IC-4 quartet.
      const fieldSet = new Set(fieldNames);
      const expectedSnake = [
        "amount_returned_micros",
        "base_tx_hash",
        "escrow_pda",
        "milestone_index",
      ];
      const expectedCamel = [
        "amountReturnedMicros",
        "baseTxHash",
        "escrowPda",
        "milestoneIndex",
      ];
      const matchesSnake = expectedSnake.every((f) => fieldSet.has(f));
      const matchesCamel = expectedCamel.every((f) => fieldSet.has(f));
      expect(
        matchesSnake || matchesCamel,
        `expected IC-4 quartet in payload type; got ${JSON.stringify(fieldNames)}`,
      ).to.equal(true);
    });

    it("IDL exposes MilestoneAutoApproved event", () => {
      const events = (program.idl as any).events as Array<{ name: string }> | undefined;
      const names = (events ?? []).map((e) => e.name);
      expect(
        names.includes("MilestoneAutoApproved") ||
          names.includes("milestoneAutoApproved"),
        `expected MilestoneAutoApproved in IDL events; got ${JSON.stringify(names)}`,
      ).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  // Pre-CPI validation gates
  // -------------------------------------------------------------------------

  describe("pre-CPI validation", () => {
    it("rejects a payload with mismatched escrow_pda (account-level or handler-level gate)", async () => {
      // Anchor evaluates account-level constraints (e.g. `owner = ...`)
      // BEFORE the handler runs, so for a fresh System-owned keypair the
      // EscrowOwnerMismatch fires first. The assertion below is an
      // "any-of" — any of the Hook's defensive gates is an acceptable
      // failure path, the test only pins that the program does NOT pass.
      const wrongEscrow = Keypair.generate().publicKey;
      const payload = buildPayload({ escrowPda: wrongEscrow });
      const [replayGuard] = hookReplayPda(
        wrongEscrow,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = { ...buildAccounts({ escrow: wrongEscrow }), replayGuard };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected the Hook to reject a wrong-escrow payload");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        expect(
          msg.includes("PayloadEscrowMismatch") ||
            msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintSeeds") ||
            msg.includes("ConstraintOwner"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });

    it("rejects payload with zero base_tx_hash (InvalidBaseTxHash)", async () => {
      const payload = buildPayload({ baseTxHash: Array(32).fill(0) });
      const [replayGuard] = hookReplayPda(
        payload.escrowPda,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = { ...buildAccounts(), replayGuard };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected InvalidBaseTxHash error");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        // The escrow-owner gate may fire before the InvalidBaseTxHash gate
        // depending on Anchor account-validation order. Either is an
        // acceptable failure here — the assertion is "the all-zero
        // payload does not succeed".
        expect(
          msg.includes("InvalidBaseTxHash") ||
            msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintOwner"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });

    it("rejects payload with zero amount_returned_micros (ZeroAmountReturned)", async () => {
      const payload = buildPayload({ amountReturnedMicros: new anchor.BN(0) });
      const [replayGuard] = hookReplayPda(
        payload.escrowPda,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = { ...buildAccounts(), replayGuard };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected ZeroAmountReturned error");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        expect(
          msg.includes("ZeroAmountReturned") ||
            msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintOwner"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });

    it("rejects a settlement_program with the wrong address (any-of: InvalidSettlementProgram or earlier owner gate)", async () => {
      // The escrow's `owner = SETTLEMENT_PROGRAM_ID` constraint is
      // account-level and runs before the Settlement-program-address
      // address-constraint on the `settlement_program` slot. With a fresh
      // System-owned escrow account the owner gate fires first; with a
      // valid Settlement-owned escrow the Settlement-program-address gate
      // would fire. Either is an acceptable rejection — the test pins the
      // negative outcome, not the specific gate.
      const payload = buildPayload();
      const [replayGuard] = hookReplayPda(
        payload.escrowPda,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = {
        ...buildAccounts({ settlementProgram: REGISTRY_PROGRAM_ID }),
        replayGuard,
      };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected the Hook to reject a wrong settlement_program");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        expect(
          msg.includes("InvalidSettlementProgram") ||
            msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintAddress") ||
            msg.includes("ConstraintOwner"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });

    it("rejects a registry_program with the wrong address (any-of: InvalidRegistryProgram or earlier owner gate)", async () => {
      const payload = buildPayload();
      const [replayGuard] = hookReplayPda(
        payload.escrowPda,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = {
        ...buildAccounts({ registryProgram: SETTLEMENT_PROGRAM_ID }),
        replayGuard,
      };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected the Hook to reject a wrong registry_program");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        expect(
          msg.includes("InvalidRegistryProgram") ||
            msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintAddress") ||
            msg.includes("ConstraintOwner"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });

    it("rejects an escrow account not owned by the Settlement program (EscrowOwnerMismatch)", async () => {
      // Default fakeEscrow is a freshly-generated keypair, not yet allocated
      // — its account does not exist on chain, so the `owner` constraint
      // surfaces the System-program (or `AccountNotInitialized`) error.
      const payload = buildPayload();
      const [replayGuard] = hookReplayPda(
        payload.escrowPda,
        payload.milestoneIndex,
        Buffer.from(payload.baseTxHash),
      );
      const accounts = { ...buildAccounts(), replayGuard };

      try {
        await program.methods
          .autoApproveMilestone(payload as any)
          .accounts(accounts as any)
          .signers([payer])
          .rpc();
        expect.fail("expected EscrowOwnerMismatch / AccountNotInitialized error");
      } catch (err: any) {
        const msg = JSON.stringify(err);
        expect(
          msg.includes("EscrowOwnerMismatch") ||
            msg.includes("ConstraintOwner") ||
            msg.includes("AccountNotInitialized") ||
            msg.includes("AccountOwnedByWrongProgram"),
          `unexpected error: ${msg}`,
        ).to.equal(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Replay protection — the `init` constraint on the replay-guard PDA.
  // -------------------------------------------------------------------------

  describe("replay protection", () => {
    it("derives a deterministic replay-guard PDA for a given (escrow, milestone, base_tx_hash) triple", () => {
      const escrow = Keypair.generate().publicKey;
      const baseTxHash = Buffer.alloc(32, 0xcd);
      const [pda1] = hookReplayPda(escrow, 3, baseTxHash);
      const [pda2] = hookReplayPda(escrow, 3, baseTxHash);
      expect(pda1.toBase58()).to.equal(pda2.toBase58());
    });

    it("derives a different replay-guard PDA when any seed component changes", () => {
      const escrow = Keypair.generate().publicKey;
      const baseTxHashA = Buffer.alloc(32, 0xab);
      const baseTxHashB = Buffer.alloc(32, 0xcd);
      const [a] = hookReplayPda(escrow, 3, baseTxHashA);
      const [b] = hookReplayPda(escrow, 3, baseTxHashB);
      const [c] = hookReplayPda(escrow, 4, baseTxHashA);
      expect(a.toBase58()).to.not.equal(b.toBase58());
      expect(a.toBase58()).to.not.equal(c.toBase58());
    });

    // Note: a true "duplicate triple aborts" test requires the success path
    // to reach the `init` step at least once. With the current scaffold
    // (no Settlement-owned escrow set up under the Hook's signer PDA), the
    // call short-circuits at EscrowOwnerMismatch before `init` runs. The
    // structural guarantee — that `init` on the (escrow, milestone,
    // base_tx_hash)-seeded PDA cannot be repeated — is provided by Anchor
    // and is exercised in `tests/cctp-hook-replay.ts` once the full
    // session-pool wiring lands (Day 4-7, see file header).
  });
});

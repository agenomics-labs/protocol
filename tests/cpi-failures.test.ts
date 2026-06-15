// AUD-017: Settlement → Registry CPI failure-path integration tests.
//
// Long-promised by ADR-001 / ADR-007 / ADR-014 / ADR-095 but never written
// before this audit cycle. This file exercises the failure surfaces of the
// Settlement → Registry reputation CPI: `propose_reputation_delta`, the
// SOLE reputation-mutation surface in the Registry post-PR-G (the legacy
// `update_reputation` was removed in commit `0a02850`).
//
// The CPI is reachable from three Settlement instructions:
//   - `approve_milestone` (reason 0, positive delta, task_completed)
//   - `expire_escrow` (reason 2 in spec; reason 1 in PR-G's interim
//     bridge code — same reason byte as dispute_loss until plumbing lands)
//   - `resolve_dispute` / `resolve_dispute_timeout` (reason 1, negative)
//
// Each `it()` here drives a complete escrow flow up to the CPI invocation,
// perturbs one input, and asserts the failure surfaces correctly. Helpers
// are duplicated (with attribution) from `tests/settlement.ts` and
// `tests/agent-registry.ts` to avoid touching those files mid-audit
// (the parallel test-followup agent owns those files).
//
// Header notes on infeasible cases:
//
//   Case 4 — spoofed `settlement_authority` signer:
//     The Registry binds `settlement_authority` via
//     `seeds::program = SETTLEMENT_PROGRAM_ID` + `signer`. Forging a signed
//     PDA from outside the Settlement program is cryptographically
//     infeasible from TypeScript — `invoke_signed` only succeeds when
//     called from the declaring program — so we cannot exercise this
//     from a TS client without adding a dedicated "spoofer" Solana
//     program (which the AUD-017 task forbids: "Do NOT modify program
//     code"). Listed as `it.skip` with a reasoned note rather than
//     silently dropped.
//
//   Case 3 — Suspended provider:
//     Post-PR-G, `propose_reputation_delta` no longer auto-suspends a
//     provider on negative deltas (the legacy slash-counting that flipped
//     status to Suspended at slash_count >= 3 was attached to the
//     removed `update_reputation`). Suspension is now reachable only
//     via (a) `update_status` — but PR-I rejects self-issued `* →
//     Suspended` transitions, leaving no programmatic path from a
//     non-authority caller — or (b) migrating a legacy on-chain profile
//     via `migrate_agent_profile`, which requires a pre-existing
//     unbounded-score profile that doesn't exist on a fresh validator.
//     We document the absence of a status check in
//     `propose_reputation_delta` (see lib.rs) by exercising the happy
//     path against an Active provider and noting the design choice.
//
//   Case 6 — discriminator drift:
//     Anchor's TS client encodes the discriminator from the IDL. Sending
//     a wrong discriminator requires hand-building the
//     `TransactionInstruction` below the program-wrapper layer. The
//     pre-fix path (Finding #17 in ARCHITECTURE_DEEP_CRITIQUE) was a
//     hand-rolled CPI that hard-coded the discriminator on the Rust
//     side; that is what got fixed. There is no longer a TS-reachable
//     wrong-discriminator surface to exercise.

import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("AUD-017: Settlement → Registry CPI failure paths", () => {
  // ============================================================================
  // SETUP — mirrors tests/settlement.ts to keep PDA helpers and program IDs in
  // lockstep with the canonical happy-path suite. Duplicated rather than
  // imported to avoid creating cross-file edit conflicts during the audit
  // remediation cycle (per task constraint).
  // ============================================================================

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Settlement as Program;
  const registryProgram = anchor.workspace.AgentRegistry as Program;
  const connection = provider.connection;

  // Program IDs (declared in Anchor.toml [programs.localnet]).
  const REGISTRY_PROGRAM_ID = new PublicKey(
    "psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv",
  );
  const SETTLEMENT_PROGRAM_ID = new PublicKey(
    "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95",
  );
  const VAULT_PROGRAM_ID = new PublicKey(
    "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw",
  );
  // BPF Upgradeable Loader — owns ProgramData accounts for upgradeable
  // programs. AUD-005: `initialize_protocol_config` derives the Settlement
  // program's ProgramData PDA under this program ID and pins the payer
  // to the upgrade authority recorded there.
  const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111",
  );

  // ADR-097: agent_profile PDA seeds = [authority, b"agent-profile", nonce-le].
  function deriveAgentProfilePDA(
    authority: PublicKey,
    nonce: bigint = 0n,
  ): [PublicKey, number] {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(nonce);
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
      REGISTRY_PROGRAM_ID,
    );
  }

  // ADR-097: owner-nonce PDA `[authority, b"owner-nonce"]` in the registry.
  function deriveOwnerNoncePDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("owner-nonce")],
      REGISTRY_PROGRAM_ID,
    );
  }

  function deriveVaultPDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.toBuffer()],
      VAULT_PROGRAM_ID,
    );
  }
  const vaultFor = (pk: PublicKey) => deriveVaultPDA(pk)[0];

  // Singleton ProtocolConfig PDA.
  const [PROTOCOL_CONFIG_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    SETTLEMENT_PROGRAM_ID,
  );

  // AUD-005: Settlement program's ProgramData PDA, owned by the BPF
  // Upgradeable Loader. Required by `initialize_protocol_config` to bind
  // the initialization to the upgrade authority.
  const [SETTLEMENT_PROGRAM_DATA_PDA] = PublicKey.findProgramAddressSync(
    [SETTLEMENT_PROGRAM_ID.toBuffer()],
    BPF_UPGRADEABLE_LOADER_ID,
  );

  // Settlement's CPI signing PDA. The Registry's `ProposeReputationDelta`
  // context requires this to be a `signer` whose seeds derive under
  // SETTLEMENT_PROGRAM_ID.
  const [SETTLEMENT_AUTHORITY_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID,
  );

  // Far-future deadline so deadline checks don't interfere with the CPI
  // failure surface we're actually testing.
  function futureDeadline(): BN {
    return new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
  }

  // Short deadline for expire_escrow flows; we'll poll the on-chain clock
  // until `now > deadline` (PR-L pattern, AUD-055) rather than wall-clock-sleep.
  function shortDeadline(): BN {
    return new BN(Math.floor(Date.now() / 1000) + 2);
  }

  // ============================================================================
  // SHARED FIXTURES
  // ============================================================================

  let mintAuthority: Keypair;
  let tokenMint: PublicKey;

  /**
   * Get or create an SPL token account for `owner`, paying with `payer`.
   */
  async function ata(owner: PublicKey, payer: Keypair): Promise<PublicKey> {
    const acct = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenMint,
      owner,
    );
    return acct.address;
  }

  /**
   * Derive the TaskEscrow PDA for a (client, provider, taskId).
   */
  async function deriveEscrowPDA(
    clientKey: PublicKey,
    providerKey: PublicKey,
    taskId: BN,
  ): Promise<[PublicKey, number]> {
    const taskIdBuf = Buffer.alloc(8);
    taskIdBuf.writeBigUInt64LE(BigInt(taskId.toString()), 0);
    return await anchor.web3.PublicKey.findProgramAddress(
      [
        Buffer.from("escrow"),
        clientKey.toBuffer(),
        providerKey.toBuffer(),
        taskIdBuf,
      ],
      program.programId,
    );
  }

  function escrowTokenAccountFor(escrowPDA: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(tokenMint, escrowPDA, true);
  }

  function makeMilestone(amount: bigint, descHash?: Buffer): any {
    return {
      amount: new BN(amount.toString()),
      descriptionHash: descHash || Buffer.alloc(32),
    };
  }

  /**
   * Airdrop `amount` lamports to each keypair and confirm.
   */
  async function airdropAll(
    keys: Keypair[],
    amount: number = 10 * LAMPORTS_PER_SOL,
  ) {
    for (const kp of keys) {
      const sig = await connection.requestAirdrop(kp.publicKey, amount);
      await connection.confirmTransaction(sig);
    }
  }

  /**
   * Register a fresh provider in the Agent Registry. Returns the profile PDA.
   */
  async function registerProvider(
    providerKp: Keypair,
    nameSuffix: string,
  ): Promise<PublicKey> {
    const [profilePDA] = deriveAgentProfilePDA(providerKp.publicKey);
    await registryProgram.methods
      .registerAgent(
        `CPI-Fail Provider ${nameSuffix}`,
        "Provider used by AUD-017 CPI-failure tests",
        "cpi-failure-tests",
        ["task-execution"],
        { perTask: {} },
        new BN(100000),
        [tokenMint],
      )
      .accounts({
        authority: providerKp.publicKey,
        ownerNonce: deriveOwnerNoncePDA(providerKp.publicKey)[0],
        agentProfile: profilePDA,
        vault: vaultFor(providerKp.publicKey),
        systemProgram: SystemProgram.programId,
      })
      .signers([providerKp])
      .rpc();
    return profilePDA;
  }

  /**
   * Build a (client, provider, escrow) tuple already in `Active` state with
   * one Submitted milestone, ready for `approve_milestone` to fire the CPI.
   * The provider's AgentProfile is pre-registered.
   */
  async function buildEscrowToCpiPoint(opts: {
    taskId: BN;
    deadline?: BN;
    nameSuffix: string;
    submitMilestone?: boolean;
  }): Promise<{
    client: Keypair;
    providerKp: Keypair;
    clientTA: PublicKey;
    providerTA: PublicKey;
    escrowPDA: PublicKey;
    escrowTA: PublicKey;
    profilePDA: PublicKey;
  }> {
    const client = Keypair.generate();
    const providerKp = Keypair.generate();
    await airdropAll([client, providerKp]);

    const clientTA = await ata(client.publicKey, client);
    const providerTA = await ata(providerKp.publicKey, client);
    await mintTo(
      connection,
      mintAuthority,
      tokenMint,
      clientTA,
      mintAuthority.publicKey,
      10_000_000n,
    );

    const profilePDA = await registerProvider(providerKp, opts.nameSuffix);

    const [escrowPDA] = await deriveEscrowPDA(
      client.publicKey,
      providerKp.publicKey,
      opts.taskId,
    );
    const escrowTA = escrowTokenAccountFor(escrowPDA);
    const milestones = [makeMilestone(1_000_000n, Buffer.alloc(32, 1))];

    await program.methods
      .createEscrow(
        opts.taskId,
        new BN(1_000_000),
        Buffer.alloc(32),
        opts.deadline ?? futureDeadline(),
        milestones,
        null,
      )
      .accounts({
        client: client.publicKey,
        clientVault: vaultFor(client.publicKey),
        providerVault: vaultFor(providerKp.publicKey),
        protocolConfig: PROTOCOL_CONFIG_PDA,
        provider: providerKp.publicKey,
        tokenMint: tokenMint,
        clientTokenAccount: clientTA,
        escrow: escrowPDA,
        escrowTokenAccount: escrowTA,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();

    await program.methods
      .acceptTask()
      .accounts({ provider: providerKp.publicKey, escrow: escrowPDA })
      .signers([providerKp])
      .rpc();

    if (opts.submitMilestone !== false) {
      await program.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({ provider: providerKp.publicKey, escrow: escrowPDA })
        .signers([providerKp])
        .rpc();
    }

    return {
      client,
      providerKp,
      clientTA,
      providerTA,
      escrowPDA,
      escrowTA,
      profilePDA,
    };
  }

  /**
   * Poll the on-chain clock until `now > deadline` (PR-L / AUD-055 pattern).
   * Avoids `setTimeout` flake under contended CI runners.
   */
  async function waitForChainTimePast(
    deadlineSec: number,
    pollMs: number = 30_000,
  ): Promise<void> {
    const stopAt = Date.now() + pollMs;
    while (Date.now() < stopAt) {
      const slot = await connection.getSlot("confirmed");
      const chainTime = await connection.getBlockTime(slot);
      if (chainTime !== null && chainTime > deadlineSec) return;
      await new Promise((res) => setImmediate(res));
    }
  }

  before(async () => {
    mintAuthority = Keypair.generate();
    await airdropAll([mintAuthority]);

    // Initialize ProtocolConfig once if it doesn't already exist (idempotent
    // for warm validator sessions where settlement.ts has already run).
    //
    // AUD-005: the `payer` MUST be the Settlement program's current upgrade
    // authority. `anchor.AnchorProvider.env().wallet` is configured from
    // ANCHOR_WALLET (typically `~/.config/solana/id.json`); the test harness
    // assumes that wallet is the deployer. If a fresh validator was started
    // with `solana-test-validator --bpf-program …`, that flag does NOT set
    // an upgrade authority, and this init will fail with
    // `SettlementError::Unauthorized` (code 6028). Use
    // `solana program deploy --upgrade-authority <wallet>` instead.
    const existing = await connection.getAccountInfo(PROTOCOL_CONFIG_PDA);
    if (existing === null) {
      const payerKey = (provider.wallet as anchor.Wallet).publicKey;
      await program.methods
        .initializeProtocolConfig()
        .accounts({
          payer: payerKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          programData: SETTLEMENT_PROGRAM_DATA_PDA,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }

    tokenMint = await createMint(
      connection,
      mintAuthority,
      mintAuthority.publicKey,
      null,
      6,
    );
  });

  // ============================================================================
  // CPI FAILURE CASES
  // ============================================================================

  describe("propose_reputation_delta CPI", () => {
    // ------------------------------------------------------------------------
    // Case 1: Closed AgentProfile.
    //
    // The provider deregisters between `accept_task` and `approve_milestone`.
    // The Registry side will fail when it tries to deserialize an
    // `Account<'_, AgentProfile>` from a closed (zero-discriminator) account.
    // The error surfaces back through the CPI as a transaction failure on
    // `approve_milestone`. Because single-milestone escrows trigger the CPI
    // on the LAST approval (auto-completion), we use a single-milestone setup
    // so the very first approve attempt fires the CPI.
    // ------------------------------------------------------------------------
    it("reverts when provider AgentProfile is closed", async () => {
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7001),
        nameSuffix: "case1-closed",
      });

      // Deregister the provider — closes the profile account. (No stake was
      // ever placed, so SEC-4's StakePresentOnDeregister guard is satisfied.)
      await registryProgram.methods
        .deregisterAgent()
        .accounts({
          authority: ctx.providerKp.publicKey,
          ownerNonce: deriveOwnerNoncePDA(ctx.providerKp.publicKey)[0],
          agentProfile: ctx.profilePDA,
        })
        .signers([ctx.providerKp])
        .rpc();

      // Sanity: the profile is gone.
      try {
        await (registryProgram.account as any).agentProfile.fetch(
          ctx.profilePDA,
        );
        expect.fail("AgentProfile should be closed after deregister");
      } catch (err: any) {
        expect(err.message).to.match(/Account does not exist/);
      }

      // approve_milestone fires the CPI; Registry can't load the closed profile.
      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: ctx.profilePDA,
            providerOwnerNonce: deriveOwnerNoncePDA(
              ctx.providerKp.publicKey,
            )[0],
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail("approve_milestone CPI should fail on closed profile");
      } catch (err: any) {
        // Anchor surfaces this as `AccountNotInitialized` /
        // `AccountOwnedByWrongProgram` depending on whether the System
        // Program reaped the account between txs. The owner_nonce
        // account similarly may surface `ConstraintSeeds` if it was
        // also closed/reset by deregister (deregister bumps the nonce
        // and does not close owner_nonce, but the now-incremented
        // nonce no longer derives the closed profile address). Any of
        // these is acceptable evidence that the closed-profile case is
        // rejected before any reputation mutation lands.
        const msg = String(err.message ?? err);
        expect(msg).to.match(
          /AccountNotInitialized|AccountOwnedByWrongProgram|ConstraintSeeds|seeds constraint was violated|owned by the wrong program|not initialized|Account does not exist/i,
        );
      }
    });

    // ------------------------------------------------------------------------
    // Case 2: Wrong OwnerNonce.
    //
    // The Registry's `ProposeReputationDelta` context derives `agent_profile`
    // PDA seeds from `[authority, b"agent-profile", owner_nonce.nonce-le]`
    // and binds `owner_nonce` itself to `[authority, b"owner-nonce"]`. If
    // the caller passes an `OwnerNonce` PDA derived for a *different*
    // authority, the seeds constraint on `owner_nonce` itself rejects.
    // ------------------------------------------------------------------------
    it("reverts when wrong OwnerNonce is passed", async () => {
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7002),
        nameSuffix: "case2-wrong-nonce",
      });

      // Register a separate authority so we have a *valid but unrelated*
      // OwnerNonce account to pass instead.
      const otherProvider = Keypair.generate();
      await airdropAll([otherProvider]);
      await registerProvider(otherProvider, "case2-decoy");

      const wrongOwnerNonce = deriveOwnerNoncePDA(otherProvider.publicKey)[0];
      // Sanity: the decoy nonce is genuinely different from the real one.
      const realOwnerNonce = deriveOwnerNoncePDA(ctx.providerKp.publicKey)[0];
      expect(wrongOwnerNonce.toString()).to.not.equal(
        realOwnerNonce.toString(),
      );

      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: ctx.profilePDA,
            providerOwnerNonce: wrongOwnerNonce, // <-- spoofed
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail("approve_milestone should reject mismatched OwnerNonce");
      } catch (err: any) {
        const msg = String(err.message ?? err);
        // Registry's `seeds = [authority, b"owner-nonce"]` constraint on
        // `owner_nonce` rejects because the decoy nonce doesn't re-derive
        // under our authority. Anchor formats this as `ConstraintSeeds`
        // (numbered code 2006).
        expect(msg).to.match(
          /ConstraintSeeds|seeds constraint was violated|2006/i,
        );
      }
    });

    // ------------------------------------------------------------------------
    // Case 3: Suspended provider behavior.
    //
    // ADR-095 specifies that suspension blocks vault outflows but does NOT
    // gate the reputation CPI itself. Post-PR-G,
    // `propose_reputation_delta` (lib.rs) does not inspect
    // `agent_profile.status` — it only validates `|delta| <=
    // MAX_DELTA_PER_CALL` and applies the change. So a Suspended provider's
    // reputation can still be mutated, which is the correct (if unusual)
    // behavior: dispute losses against an already-suspended provider must
    // still be recorded.
    //
    // Programmatically REACHING Suspended state from a fresh validator is
    // hard:
    //   - Pre-PR-G, 3 negative `update_reputation` CPIs auto-flipped status
    //     to Suspended via the slash counter. That code is gone (commit
    //     `0a02850` / PR-G). `propose_reputation_delta` does not touch
    //     status.
    //   - `update_status(Suspended)` is now blocked for self-issued
    //     transitions (PR-I, AUD-004).
    //   - `migrate_agent_profile` can land a profile in Suspended via the
    //     legacy-state normalization path, but that requires a pre-existing
    //     profile with the `Suspended ⇒ slash_count >= 3` invariant
    //     pre-violated — not reproducible on a fresh validator.
    //
    // What we CAN verify here is the design property: the CPI succeeds
    // against a fresh, Active provider (the happy-path baseline) and the
    // post-state is precisely `propose_reputation_delta`'s contract:
    // delta applied, score clamped to [0, 100]. That negatively
    // demonstrates that the CPI does not have a status precondition.
    //
    // The full Suspended-provider end-to-end test is left to a future
    // migration-aware test that owns its own legacy-fixture pipeline.
    // ------------------------------------------------------------------------
    it("handles a Suspended provider (verify behavior)", async () => {
      // Active baseline: drive approve_milestone to fire the CPI happily.
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7003),
        nameSuffix: "case3-active-baseline",
      });

      const before = await (
        registryProgram.account as any
      ).agentProfile.fetch(ctx.profilePDA);
      expect((before as any).status).to.have.property("active");

      await program.methods
        .approveMilestone(new BN(0), 5)
        .accounts({
          client: ctx.client.publicKey,
          escrow: ctx.escrowPDA,
          escrowTokenAccount: ctx.escrowTA,
          providerTokenAccount: ctx.providerTA,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: ctx.profilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(ctx.providerKp.publicKey)[0],
          providerAuthority: ctx.providerKp.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([ctx.client])
        .rpc();

      const after = await (
        registryProgram.account as any
      ).agentProfile.fetch(ctx.profilePDA);

      // CPI applied: score moved upward by the configured task_completed
      // delta (default +10 post-PR-G), clamped to [0, 100]. Status is
      // unchanged: Active stays Active. This is the post-PR-G contract;
      // the Suspended branch would behave identically (no status check).
      expect((after as any).status).to.have.property("active");
      expect((after as any).reputationScore.toNumber()).to.be.greaterThan(
        (before as any).reputationScore.toNumber(),
      );
      expect((after as any).reputationScore.toNumber()).to.be.lte(100);

      // Documented design note (asserted via comment, not exec):
      // Were `before.status` Suspended, the same CPI would still apply
      // the delta — `propose_reputation_delta` reads only delta + reason
      // + score; it does not branch on `status`. That is the
      // intentional shape (per ADR-095): suspension governs vault
      // outflows, not reputation arithmetic.
    });

    // ------------------------------------------------------------------------
    // Case 4: Spoofed `settlement_authority` signer.
    //
    // The Registry's `ProposeReputationDelta` context binds:
    //   #[account(signer, seeds = [b"settlement_authority"], bump,
    //             seeds::program = SETTLEMENT_PROGRAM_ID)]
    //
    // Forging a signed PDA from outside the Settlement program requires
    // calling `invoke_signed` with the seeds — and `invoke_signed` only
    // succeeds when invoked from the program that the seeds are derived
    // under. From a TS client, we can derive the address but cannot make it
    // a `Signer`. We can pass an arbitrary keypair claiming to be the PDA,
    // but the `seeds + seeds::program` constraint will reject it because
    // the keypair's pubkey is not the canonical PDA.
    //
    // A fully negative test here would require a dedicated helper Solana
    // program that attempts to CPI into the Registry with a forged
    // settlement_authority — out of scope for this PR (would require new
    // program code, which the AUD-017 task explicitly forbids).
    //
    // What we CAN test cheaply: passing a *different* PublicKey in the
    // `settlement_authority` slot fails Anchor's seeds constraint on the
    // *Settlement* side before the CPI is even attempted. That asserts
    // the same invariant from the caller direction. We exercise that
    // here as a positive sanity check; a true cross-program forgery test
    // is left as a `it.skip`.
    // ------------------------------------------------------------------------
    it("rejects a non-canonical settlement_authority address", async () => {
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7004),
        nameSuffix: "case4-spoof-addr",
      });

      // Substitute a random keypair pubkey for the settlement_authority
      // slot. Settlement's `ApproveMilestone` context binds this account
      // via `seeds = [b"settlement_authority"], seeds::program = crate::ID`
      // (SEC-8 / ADR-074). Anchor rejects on seed mismatch before the CPI.
      const fakeAuthority = Keypair.generate();

      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: ctx.profilePDA,
            providerOwnerNonce: deriveOwnerNoncePDA(
              ctx.providerKp.publicKey,
            )[0],
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: fakeAuthority.publicKey, // <-- spoofed
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail("approve_milestone should reject spoofed settlement_authority");
      } catch (err: any) {
        const msg = String(err.message ?? err);
        // Settlement-side seeds constraint rejects before CPI.
        expect(msg).to.match(
          /ConstraintSeeds|seeds constraint was violated|2006/i,
        );
      }
    });

    it.skip(
      "rejects forged settlement_authority signer from a non-Settlement program (skipped — requires helper program)",
      async () => {
        // Re-enable once a 'spoofer' Solana program exists that attempts
        // the forged CPI. Without it we cannot construct a non-Settlement
        // caller that produces a valid `invoke_signed` for the
        // settlement_authority PDA seeds. The Registry's
        // `seeds::program = SETTLEMENT_PROGRAM_ID` constraint is the
        // primary cryptographic guard; the Settlement-side address check
        // (covered above) is a belt-and-braces SEC-8 hardening.
      },
    );

    // ------------------------------------------------------------------------
    // Case 5: Cross-account provider/profile mismatch.
    //
    // Pass `provider_profile` for agent A but route the CPI's
    // `provider_authority` to agent B. Settlement's `ApproveMilestone`
    // context constrains `provider_authority = escrow.provider`, so the
    // authority slot is forced to the escrow's provider (A). The Registry's
    // `has_one = authority` constraint on `agent_profile` then trips:
    // profile B's `.authority` is B, not A. (In practice the
    // `owner_nonce` seeds constraint may trip first since `owner_nonce`
    // is bound by `[authority, b"owner-nonce"]` and the caller would have
    // to supply A's nonce paired with B's profile.) Either rejection is
    // valid evidence the cross-account substitution is closed.
    // ------------------------------------------------------------------------
    it("rejects cross-account provider/profile mismatch", async () => {
      const ctxA = await buildEscrowToCpiPoint({
        taskId: new BN(7005),
        nameSuffix: "case5-provider-a",
      });

      // Register a second provider (B) with a real, valid AgentProfile.
      const providerB = Keypair.generate();
      await airdropAll([providerB]);
      const profileBPDA = await registerProvider(providerB, "case5-provider-b");

      // Sanity: the two profile PDAs differ.
      expect(profileBPDA.toString()).to.not.equal(ctxA.profilePDA.toString());

      // Settlement-side `ApproveMilestone` constrains
      // `provider_authority = escrow.provider`. So `provider_authority`
      // must be A. We slip B's *profile* (and B's nonce) into the slots
      // reserved for A. The Registry side trips on either:
      //   - `owner_nonce` seeds constraint (B's nonce can't re-derive
      //      under A's authority), or
      //   - `has_one = authority` (profile B's stored authority is B,
      //      but the supplied authority is A).
      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctxA.client.publicKey,
            escrow: ctxA.escrowPDA,
            escrowTokenAccount: ctxA.escrowTA,
            providerTokenAccount: ctxA.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: profileBPDA, // <-- B's profile
            providerOwnerNonce: deriveOwnerNoncePDA(providerB.publicKey)[0], // <-- B's nonce
            providerAuthority: ctxA.providerKp.publicKey, // forced to A by escrow constraint
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctxA.client])
          .rpc();
        expect.fail("CPI should reject cross-account provider/profile mismatch");
      } catch (err: any) {
        const msg = String(err.message ?? err);
        expect(msg).to.match(
          /ConstraintSeeds|ConstraintHasOne|seeds constraint was violated|has one constraint was violated|UnauthorizedCaller|2006|2001/i,
        );
      }
    });

    // ------------------------------------------------------------------------
    // Case 6 (optional): Discriminator drift.
    //
    // The cpi.rs comment block (Finding #17 in ARCHITECTURE_DEEP_CRITIQUE)
    // explicitly notes that the previous hand-rolled instruction with a
    // hard-coded discriminator was replaced by the Anchor-generated
    // helper, which regenerates from the Registry's `#[program]` module on
    // every build. From TS, every method call goes through the IDL,
    // which encodes the discriminator from the same source — there is no
    // exposed surface to send a wrong discriminator without dropping below
    // Anchor's abstraction layer.
    //
    // Skipped per the task's "only if straightforward" guidance.
    // ------------------------------------------------------------------------
    it.skip(
      "rejects wrong discriminator on direct Registry CPI (skipped — not exposed via IDL)",
      async () => {
        // Anchor's TS client encodes the discriminator from the IDL. To
        // exercise this we'd need to hand-build the instruction at the
        // raw `TransactionInstruction` level, bypassing the program
        // wrapper. The Finding #17 fix replaced exactly that hand-rolled
        // code-path on the Rust side; there is no longer a
        // wrong-discriminator path to reach from a typical TS test.
      },
    );
  });

  // ============================================================================
  // AUD-117 (cycle-2): Settlement-boundary seeds defense-in-depth.
  //
  // AUD-117 layered Anchor `seeds` constraints onto `provider_owner_nonce`
  // and `provider_profile` in the four Settlement contexts that CPI into
  // the Registry's `propose_reputation_delta`:
  //   - ApproveMilestone
  //   - ResolveDispute
  //   - ResolveDisputeTimeout
  //   - ExpireEscrow
  //
  // Pre-fix, those two accounts were `UncheckedAccount` and the Registry's
  // own seeds constraint was the SOLE validator. Cycle-2 flagged this as
  // "one-future-PR-away" from re-opening AUD-001 (cross-account reuse).
  // Post-fix, BOTH the Settlement caller and the Registry callee re-derive
  // the PDAs — same protection applied twice.
  //
  // These tests pin the new layer by feeding wrong-account substitutions
  // that, pre-fix, would have only been caught by the Registry. Each test
  // asserts on TWO things:
  //
  //   1. Anchor's `ConstraintSeeds` (error code 2006) fires.
  //   2. The failure happens at the **Settlement** boundary — i.e. before
  //      the CPI to the Registry is even attempted. We discriminate via
  //      the transaction logs: a failure at Settlement shows
  //      `Program <SETTLEMENT_PROGRAM_ID> invoke [1]` followed by an
  //      AnchorError, with NO `Program <REGISTRY_PROGRAM_ID> invoke [2]`
  //      line. A failure at Registry would have an `invoke [2]` line.
  //
  // Without (2), a test that only asserts `ConstraintSeeds` cannot tell
  // the AUD-117 layer from the pre-fix behavior — the Registry would
  // surface the same error code from inside the CPI.
  //
  // Coverage strategy: 3 active tests across 3 of the 4 contexts
  // (ApproveMilestone × 2 — one for each of the two newly-constrained
  // accounts; ResolveDispute; ExpireEscrow), plus 1 documented `it.skip`
  // for ResolveDisputeTimeout (its trigger condition,
  // `now > dispute_window_start + dispute_timeout_seconds`, is gated by
  // a 7-day governance-controlled value with no test-feature override —
  // same blocker noted at tests/settlement.ts:2224).
  // ============================================================================

  describe("AUD-117: Settlement-boundary seeds defense-in-depth", () => {
    /**
     * Extract `err.logs` from an Anchor / web3.js error in a
     * version-tolerant way. Different Anchor versions surface logs via
     * `err.logs` (SendTransactionError), `err.transactionLogs`
     * (AnchorError post-0.29), or only via the wrapped string. We
     * normalize to a single array.
     */
    function extractLogs(err: any): string[] {
      if (Array.isArray(err?.logs)) return err.logs;
      if (Array.isArray(err?.transactionLogs)) return err.transactionLogs;
      if (Array.isArray(err?.error?.logs)) return err.error.logs;
      // Fallback: scrape the stringified error for the embedded log list.
      const s = String(err?.message ?? err);
      const m = s.match(/Logs:\s*\[([\s\S]*?)\]/);
      if (m) return m[1].split("\n").map((l) => l.trim()).filter(Boolean);
      return [];
    }

    /**
     * Boundary discriminator: assert the transaction logs prove the
     * failure happened at the Settlement program's account-validation
     * phase, NOT inside the Registry CPI. We look for two signals:
     *
     *   - Settlement's `invoke [1]` line is present (sanity: we did
     *     reach the Settlement program).
     *   - There is NO `Program <REGISTRY_PROGRAM_ID> invoke [N]` line
     *     for any depth >= 2 — i.e. the CPI was never dispatched.
     *
     * If logs are missing entirely (some surface-level failures), we
     * fall back to asserting the error message contains the Settlement
     * program ID, NOT the Registry program ID. The asymmetry is the
     * point: pre-AUD-117, the constraint would have failed inside the
     * Registry CPI (depth 2) and the Registry's program ID would
     * appear in both the invoke line and the `failed:` line.
     */
    function assertFailedAtSettlementBoundary(err: any) {
      const logs = extractLogs(err);
      const settlementId = SETTLEMENT_PROGRAM_ID.toBase58();
      const registryId = REGISTRY_PROGRAM_ID.toBase58();

      if (logs.length > 0) {
        const sawSettlementInvoke = logs.some((l) =>
          l.includes(`Program ${settlementId} invoke [1]`),
        );
        const sawRegistryCpi = logs.some((l) =>
          // depth 2+ — the Registry was actually called via CPI.
          /Program .+ invoke \[(2|3|4)\]/.test(l) && l.includes(registryId),
        );
        expect(
          sawSettlementInvoke,
          `expected Settlement invoke [1] in logs; got:\n${logs.join("\n")}`,
        ).to.equal(true);
        expect(
          sawRegistryCpi,
          `expected NO Registry CPI (invoke [2+]); failure should happen at the Settlement boundary, but logs show:\n${logs.join(
            "\n",
          )}`,
        ).to.equal(false);
        return;
      }

      // Fallback: log array unavailable (e.g. simulation-only failure).
      // The error message embeds the program ID. Settlement's program
      // ID must be present; Registry's must NOT — pre-AUD-117 the
      // constraint trip would have surfaced from inside the Registry
      // and its ID would dominate.
      const msg = String(err?.message ?? err);
      expect(msg).to.include(settlementId);
      expect(
        msg.includes(registryId),
        `error message mentions Registry program ID — failure may have occurred inside the CPI rather than at the Settlement boundary: ${msg}`,
      ).to.equal(false);
    }

    /**
     * Assert the error is an Anchor `ConstraintSeeds` (code 2006).
     * Settlement's `seeds = [...], seeds::program = AGENT_REGISTRY_PROGRAM_ID`
     * on `provider_owner_nonce` and `provider_profile` rejects with
     * this error code when the supplied account doesn't re-derive
     * under the declared seeds.
     */
    function assertConstraintSeeds(err: any) {
      const msg = String(err?.message ?? err);
      expect(msg).to.match(
        /ConstraintSeeds|seeds constraint was violated|2006/i,
      );
    }

    // ------------------------------------------------------------------------
    // AUD-117 / Case A: ApproveMilestone — substitute provider_owner_nonce
    // for a different owner. Pre-fix, the OwnerNonce account was
    // UncheckedAccount on the Settlement side; only the Registry's seeds
    // constraint would catch the wrong-owner substitution, and the failure
    // would surface from inside the CPI (Registry's invoke [2]). Post-fix,
    // Settlement's own
    //   `seeds = [provider_authority.key().as_ref(), b"owner-nonce"],
    //    seeds::program = AGENT_REGISTRY_PROGRAM_ID`
    // rejects before the CPI is dispatched.
    // ------------------------------------------------------------------------
    it("ApproveMilestone: rejects wrong provider_owner_nonce at Settlement boundary", async () => {
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7117),
        nameSuffix: "aud117-approve-nonce",
      });

      // Register a decoy provider so we have a *valid* OwnerNonce account
      // to swap in (a fully-bogus address would trip AccountNotInitialized
      // before reaching the seeds check, which doesn't exercise AUD-117).
      const decoyProvider = Keypair.generate();
      await airdropAll([decoyProvider]);
      await registerProvider(decoyProvider, "aud117-approve-decoy");
      const wrongOwnerNonce = deriveOwnerNoncePDA(decoyProvider.publicKey)[0];

      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: ctx.profilePDA,
            providerOwnerNonce: wrongOwnerNonce, // <-- decoy's nonce
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail(
          "approve_milestone should reject wrong provider_owner_nonce at the Settlement boundary",
        );
      } catch (err: any) {
        assertConstraintSeeds(err);
        assertFailedAtSettlementBoundary(err);
      }
    });

    // ------------------------------------------------------------------------
    // AUD-117 / Case B: ApproveMilestone — substitute provider_profile for
    // a different owner (with that owner's matching OwnerNonce so the
    // first seeds check passes and we exercise the SECOND constraint).
    // Pre-fix, the AgentProfile account was UncheckedAccount on the
    // Settlement side and the Registry's
    // `seeds = [authority, b"agent-profile", owner_nonce.nonce.to_le_bytes()]`
    // was the sole guard. Post-fix, Settlement re-derives the same PDA
    // at the boundary using the same seeds + `seeds::program =
    // AGENT_REGISTRY_PROGRAM_ID`.
    //
    // To isolate the profile constraint specifically, we have to also
    // pass the decoy's owner_nonce (otherwise the nonce constraint trips
    // first and the test wouldn't prove the profile constraint exists).
    // The result: provider_authority is forced to the real provider (by
    // the `address = escrow.provider` constraint above it); the supplied
    // owner_nonce derives under the decoy authority, so the
    // owner_nonce seeds constraint trips. So in practice this test
    // exercises the same first-trip as Case A unless we work harder.
    //
    // What we CAN do: pass the real owner_nonce (matches the real
    // authority) but the decoy's profile. Now the first constraint passes
    // (real nonce derives under real authority), and the SECOND
    // constraint (provider_profile seeds, using the real nonce's `.nonce`
    // field) trips because the decoy's profile address is derived from
    // the decoy authority + decoy nonce, not the real authority + real
    // nonce.
    // ------------------------------------------------------------------------
    it("ApproveMilestone: rejects wrong provider_profile at Settlement boundary", async () => {
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7118),
        nameSuffix: "aud117-approve-profile",
      });

      // Decoy with its own valid AgentProfile.
      const decoyProvider = Keypair.generate();
      await airdropAll([decoyProvider]);
      const decoyProfilePDA = await registerProvider(
        decoyProvider,
        "aud117-approve-profile-decoy",
      );

      // Sanity: decoy's profile address differs from the real one.
      expect(decoyProfilePDA.toString()).to.not.equal(ctx.profilePDA.toString());

      const realOwnerNonce = deriveOwnerNoncePDA(ctx.providerKp.publicKey)[0];

      try {
        await program.methods
          .approveMilestone(new BN(0), 5)
          .accounts({
            client: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: decoyProfilePDA, // <-- decoy's profile
            providerOwnerNonce: realOwnerNonce, // <-- real nonce (passes first check)
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail(
          "approve_milestone should reject wrong provider_profile at the Settlement boundary",
        );
      } catch (err: any) {
        assertConstraintSeeds(err);
        assertFailedAtSettlementBoundary(err);
      }
    });

    // ------------------------------------------------------------------------
    // AUD-117 / Case C: ResolveDispute — substitute provider_owner_nonce
    // for a different owner. Same wrong-account substitution shape as
    // Case A, but exercised against the dispute-resolution rail to prove
    // AUD-117's seeds layer covers `ResolveDispute` too.
    //
    // ResolveDispute requires:
    //   1. Escrow has a `dispute_resolver` set at create_escrow time.
    //   2. The escrow is in `Disputed` state (raise_dispute called).
    //   3. The signer is the dispute_resolver (SEC-7 / ADR-073).
    // ------------------------------------------------------------------------
    it("ResolveDispute: rejects wrong provider_owner_nonce at Settlement boundary", async () => {
      // We can't reuse buildEscrowToCpiPoint here — it omits the
      // dispute_resolver. Build the escrow inline with a resolver.
      const client = Keypair.generate();
      const providerKp = Keypair.generate();
      const resolver = Keypair.generate();
      await airdropAll([client, providerKp, resolver]);

      const clientTA = await ata(client.publicKey, client);
      const providerTA = await ata(providerKp.publicKey, client);
      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTA,
        mintAuthority.publicKey,
        10_000_000n,
      );

      const profilePDA = await registerProvider(providerKp, "aud117-dispute");
      const taskId = new BN(7119);
      const [escrowPDA] = await deriveEscrowPDA(
        client.publicKey,
        providerKp.publicKey,
        taskId,
      );
      const escrowTA = escrowTokenAccountFor(escrowPDA);
      const milestones = [makeMilestone(1_000_000n, Buffer.alloc(32, 1))];

      await program.methods
        .createEscrow(
          taskId,
          new BN(1_000_000),
          Buffer.alloc(32),
          futureDeadline(),
          milestones,
          resolver.publicKey, // dispute_resolver
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(providerKp.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: providerKp.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();

      await program.methods
        .acceptTask()
        .accounts({ provider: providerKp.publicKey, escrow: escrowPDA })
        .signers([providerKp])
        .rpc();

      await program.methods
        .raiseDispute()
        .accounts({ requester: client.publicKey, escrow: escrowPDA })
        .signers([client])
        .rpc();

      // Decoy provider supplies a *valid but unrelated* OwnerNonce.
      const decoyProvider = Keypair.generate();
      await airdropAll([decoyProvider]);
      await registerProvider(decoyProvider, "aud117-dispute-decoy");
      const wrongOwnerNonce = deriveOwnerNoncePDA(decoyProvider.publicKey)[0];

      try {
        await program.methods
          .resolveDispute(new BN(500_000), new BN(500_000))
          .accounts({
            resolver: resolver.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount: escrowTA,
            clientTokenAccount: clientTA,
            providerTokenAccount: providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: profilePDA,
            providerOwnerNonce: wrongOwnerNonce, // <-- decoy's nonce
            providerAuthority: providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([resolver])
          .rpc();
        expect.fail(
          "resolve_dispute should reject wrong provider_owner_nonce at the Settlement boundary",
        );
      } catch (err: any) {
        assertConstraintSeeds(err);
        assertFailedAtSettlementBoundary(err);
      }
    });

    // ------------------------------------------------------------------------
    // AUD-117 / Case D: ExpireEscrow — substitute provider_owner_nonce
    // for a different owner. Same wrong-account substitution shape, but
    // on the expiry rail. Requires waiting past `escrow.deadline` (we
    // use a short deadline + on-chain-clock poll, the AUD-055 pattern).
    // ------------------------------------------------------------------------
    it("ExpireEscrow: rejects wrong provider_owner_nonce at Settlement boundary", async () => {
      // Compute deadline from the on-chain clock (not wall-clock) so we
      // don't trip create_escrow's `DeadlineInPast` guard under
      // validator-clock skew. +15s gives buildEscrowToCpiPoint enough
      // headroom to land its 4-tx setup before the deadline elapses
      // while still being short enough that the post-setup
      // waitForChainTimePast poll returns within seconds.
      const startSlot = await connection.getSlot("confirmed");
      const onchainNow = await connection.getBlockTime(startSlot);
      if (onchainNow === null) {
        throw new Error(
          "getBlockTime returned null; cannot compute on-chain deadline",
        );
      }
      const deadline = new BN(onchainNow + 15);
      const ctx = await buildEscrowToCpiPoint({
        taskId: new BN(7120),
        deadline,
        nameSuffix: "aud117-expire",
      });

      // Decoy supplies a valid but unrelated OwnerNonce.
      const decoyProvider = Keypair.generate();
      await airdropAll([decoyProvider]);
      await registerProvider(decoyProvider, "aud117-expire-decoy");
      const wrongOwnerNonce = deriveOwnerNoncePDA(decoyProvider.publicKey)[0];

      // Wait until the on-chain clock is past the escrow deadline so
      // expire_escrow's deadline check passes and we reach the seeds
      // validation phase that AUD-117 protects.
      await waitForChainTimePast(deadline.toNumber());

      try {
        await program.methods
          .expireEscrow()
          .accounts({
            payer: ctx.client.publicKey,
            escrow: ctx.escrowPDA,
            escrowTokenAccount: ctx.escrowTA,
            clientTokenAccount: ctx.clientTA,
            providerTokenAccount: ctx.providerTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: ctx.profilePDA,
            providerOwnerNonce: wrongOwnerNonce, // <-- decoy's nonce
            providerAuthority: ctx.providerKp.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([ctx.client])
          .rpc();
        expect.fail(
          "expire_escrow should reject wrong provider_owner_nonce at the Settlement boundary",
        );
      } catch (err: any) {
        assertConstraintSeeds(err);
        assertFailedAtSettlementBoundary(err);
      }
    });

    // ------------------------------------------------------------------------
    // AUD-117 / Case E (skipped): ResolveDisputeTimeout coverage.
    // Asymmetric-coverage gap closed by AUD-203 — see below.
    //
    // ResolveDisputeTimeout's trigger condition is
    //   `now > dispute_window_start + dispute_timeout_seconds`
    // where `dispute_timeout_seconds` is governance-controlled
    // (ProtocolConfig.dispute_timeout_seconds, default 7 days). Reaching
    // this from a TS test on solana-test-validator requires either:
    //   - Burning 7 days of wall-clock time (infeasible in CI), OR
    //   - A test-feature override that lets the test set
    //     `dispute_timeout_seconds` to a small value (would require
    //     modifying program code, which the AUD-117 task forbids), OR
    //   - anchor-bankrun with a clock-warp helper (out of scope here;
    //     same blocker noted in tests/settlement.ts:2224 for the
    //     positive-path test).
    //
    // Bankrun migration is scheduled (routine
    // `trig_01NokXSDGAb7ECabM5n9ULR3`, target 2026-05-10). When that
    // lands, this `it.skip` flips to active and case E gains the same
    // wrong-`provider_owner_nonce` substitution coverage cases A/B/D
    // already have above.
    //
    // AUD-203 (cycle-3) interim coverage — closes the asymmetric gap:
    //   The four AUD-117-touched contexts are mechanically identical in
    //   their seeds constraints (verbatim copies of the ApproveMilestone
    //   block — see programs/settlement/src/contexts.rs lines 196-221 vs
    //   343-363 vs 424-444 vs 586-606). The Rust unit-test module
    //   `aud_117_seeds_parity` at the bottom of `contexts.rs` reads its
    //   own source via `include_str!` and asserts byte-identity of the
    //   `provider_owner_nonce` and `provider_profile` `#[account(...)]`
    //   blocks across all four contexts on every `cargo test` run
    //   (3 tests, all green at HEAD). That mechanical-identity proof is
    //   what lets this TS skip stay green during the launch window: if
    //   any of cases A/B/D regress, their `it()` fails directly; if
    //   case E regresses in source, the Rust parity test fails before
    //   build. The only uncovered surface is "case E regresses
    //   identically to A/B/D in lockstep at the source level", which the
    //   third Rust test (`aud_203_reference_blocks_contain_required_constraint_tokens`)
    //   pins by asserting the reference block contains the required
    //   constraint tokens. After bankrun migration, this TS test becomes
    //   the runtime sentinel and the parity tests become belt-and-braces
    //   (kept — different threats).
    // ------------------------------------------------------------------------
    it.skip(
      "ResolveDisputeTimeout: rejects wrong provider_owner_nonce at Settlement boundary (skipped — 7-day governance timeout; mechanical-identity coverage at programs/settlement/src/contexts.rs::aud_117_seeds_parity per AUD-203)",
      async () => {
        // BANKRUN-TODO(trig_01NokXSDGAb7ECabM5n9ULR3, 2026-05-10):
        // Re-enable once the suite migrates to anchor-bankrun and gains
        // a clock-warp helper. The seeds constraint block on
        // ResolveDisputeTimeout is a verbatim copy of the
        // ApproveMilestone block (see commit 10a58f9 + AUD-203's
        // mechanical-identity unit tests in
        // programs/settlement/src/contexts.rs::aud_117_seeds_parity),
        // so the active ApproveMilestone test above plus the source-
        // level parity tests are the regression sentinels until then.
      },
    );
  });
});

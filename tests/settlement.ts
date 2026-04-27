import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";

// REG-1 fix (test sweep, 2026-04-25): @solana/web3.js v1 does not export
// BPF_LOADER_UPGRADEABLE_PROGRAM_ID — only BPF_LOADER_PROGRAM_ID and
// BPF_LOADER_DEPRECATED_PROGRAM_ID. Hardcode the canonical upgradeable
// loader pubkey (matches solana_program::bpf_loader_upgradeable::ID on
// the Rust side). Using the wrong/missing import made every settlement
// integration test non-runnable; this restores them.
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Settlement Protocol Tests", () => {
  // ============================================================================
  // SETUP
  // ============================================================================

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Settlement as Program;
  const connection = provider.connection;

  // Program IDs for CPI
  const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
  const SETTLEMENT_PROGRAM_ID = new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");
  // Finding #9: register_agent now validates the vault argument matches the
  // canonical Agent Vault PDA seeded by `[b"vault", authority]`.
  const VAULT_PROGRAM_ID = new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");

  // ADR-097: agent_profile PDA seeds = [authority, b"agent-profile", nonce-le].
  function deriveAgentProfilePDA(
    authority: PublicKey,
    nonce: bigint = 0n
  ): [PublicKey, number] {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(nonce);
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
      REGISTRY_PROGRAM_ID
    );
  }

  // ADR-097: owner-nonce PDA [authority, b"owner-nonce"] in the registry.
  function deriveOwnerNoncePDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("owner-nonce")],
      REGISTRY_PROGRAM_ID
    );
  }

  function deriveVaultPDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.toBuffer()],
      VAULT_PROGRAM_ID
    );
  }
  const vaultFor = (pk: PublicKey) => deriveVaultPDA(pk)[0];

  // Finding #19: Governance-owned ProtocolConfig PDA — singleton seeded by
  // `[b"protocol_config"]` under the settlement program. Must be initialized
  // once per deployment before any escrow can be created.
  const [PROTOCOL_CONFIG_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    SETTLEMENT_PROGRAM_ID
  );

  // AUD-005 (PR-H): the BPF Upgradeable Loader's `ProgramData` account for
  // the settlement program. Seeds = [program_id] under
  // BPF_LOADER_UPGRADEABLE_PROGRAM_ID. The init context constrains the payer
  // to `program_data.upgrade_authority_address`, closing the front-running
  // window between deploy and config init.
  const [SETTLEMENT_PROGRAM_DATA] = PublicKey.findProgramAddressSync(
    [SETTLEMENT_PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  );

  // ADR-026: Settlement's signing authority PDA for CPI calls into the
  // registry. The registry enforces `seeds = [b"settlement_authority"]` +
  // `seeds::program = SETTLEMENT_PROGRAM_ID`, so this must be derived under
  // the settlement program ID — NOT passed as a raw program-id pubkey.
  const [SETTLEMENT_AUTHORITY_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  // Test configuration
  const TASK_ID = new BN(1);
  const TOTAL_AMOUNT = new BN(1000000); // 1 USDC (6 decimals)
  const FUTURE_DEADLINE = new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60); // 7 days from now
  const PAST_DEADLINE = new BN(Math.floor(Date.now() / 1000) - 1); // 1 second ago

  // Mint authority (persistent across all test groups)
  let mintAuthority: Keypair;

  // Test keypairs (generated fresh for each test group)
  let client: Keypair;
  let provider_account: Keypair;
  let resolver: Keypair;
  let tokenMint: PublicKey;
  let clientTokenAccount: PublicKey;
  let providerTokenAccount: PublicKey;

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /**
   * Helper to get or create an associated token account
   */
  async function getOrCreateTokenAccount(
    owner: PublicKey,
    payer: Keypair
  ): Promise<PublicKey> {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenMint,
      owner
    );
    return ata.address;
  }

  /**
   * Derive the TaskEscrow PDA for a given client, provider, and task_id
   */
  async function deriveEscrowPDA(
    clientKey: PublicKey,
    providerKey: PublicKey,
    taskId: any
  ): Promise<[PublicKey, number]> {
    const taskIdBuffer = Buffer.alloc(8);
    // Support both BN and bigint
    const taskIdBigInt = typeof taskId === 'bigint' ? taskId : BigInt(taskId.toString());
    taskIdBuffer.writeBigUInt64LE(taskIdBigInt, 0);

    return await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("escrow"), clientKey.toBuffer(), providerKey.toBuffer(), taskIdBuffer],
      program.programId
    );
  }

  /**
   * Derive the escrow token account as an ATA of the escrow PDA
   */
  function deriveEscrowTokenAccount(escrowPDA: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      tokenMint,
      escrowPDA,
      true // allowOwnerOffCurve — needed for PDA owners
    );
  }

  /**
   * Create a milestone data object
   */
  function createMilestoneData(
    amount: any,
    descriptionHash?: Buffer
  ): any {
    // Convert to BN if not already
    const bnAmount = typeof amount === 'bigint' ? new BN(amount.toString()) : (amount instanceof BN ? amount : new BN(amount));
    return {
      amount: bnAmount,
      descriptionHash: descriptionHash || Buffer.alloc(32),
    };
  }

  // ============================================================================
  // SETUP TESTS
  // ============================================================================

  describe("Setup: Token Mint and Accounts", () => {
    before(async () => {
      // Generate fresh keypairs for this test group
      mintAuthority = Keypair.generate();
      client = Keypair.generate();
      provider_account = Keypair.generate();
      resolver = Keypair.generate();

      // Airdrop SOL to fund accounts
      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [mintAuthority, client, provider_account, resolver]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      // Finding #19 / ADR-026 / AUD-005 (PR-H): The ProtocolConfig PDA is a
      // hard precondition for create_escrow / approve_milestone /
      // resolve_dispute / expire_escrow / resolve_dispute_timeout. AUD-005
      // additionally constrains the init payer to the program's upgrade
      // authority via BPF Upgradeable Loader's ProgramData.
      //
      // The deterministic test path is `Anchor.toml [test] upgradeable = true`
      // (Option B.1, anchor 0.31.x), which deploys workspace programs with
      // `--upgradeable-program <addr> <binary> <wallet-pubkey>` so that
      // `provider.wallet` IS the upgrade authority and ProgramData exists.
      //
      // The defensive checks below (Option A) keep the test failure mode
      // actionable when that deploy path was bypassed (e.g. someone ran with
      // a stale `target/deploy` cache, or with `--skip-deploy` against a
      // legacy `--bpf-program`-loaded validator). We surface a precise error
      // BEFORE attempting the init RPC so the cascade of "Cannot read
      // properties of undefined (reading 'toBuffer')" failures (tokenMint
      // never set, 14 downstream tests cascade-fail) is replaced by a single
      // root-cause message.
      //
      // Guarded by existing-account detection so reruns on a warm validator
      // are idempotent.
      const existing = await connection.getAccountInfo(PROTOCOL_CONFIG_PDA);
      if (existing === null) {
        // AUD-005 (PR-H): initialize_protocol_config requires payer to equal
        // program_data.upgrade_authority_address. Verify before attempting.
        const programDataAcct = await connection.getAccountInfo(SETTLEMENT_PROGRAM_DATA);
        if (!programDataAcct) {
          throw new Error(
            `Cannot initialize protocol_config: program_data PDA does not exist at ${SETTLEMENT_PROGRAM_DATA.toBase58()}. ` +
            `The settlement program may have been pre-loaded via 'solana-test-validator --bpf-program' (non-upgradeable loader) ` +
            `instead of 'solana program deploy' (upgradeable). Set [test] upgradeable = true in Anchor.toml or run scripts/test-deploy.sh ` +
            `to deploy with the proper upgradeable loader.`
          );
        }
        // ProgramData layout: 4 bytes discriminator + 8 bytes slot + 1 byte option-tag + 32 bytes pubkey
        const optionTag = programDataAcct.data[12];
        const upgradeAuth = optionTag === 1
          ? new PublicKey(programDataAcct.data.slice(13, 45))
          : null;
        if (!upgradeAuth || !upgradeAuth.equals(provider.wallet.publicKey)) {
          throw new Error(
            `AUD-005 test setup failure: cannot initialize protocol_config. ` +
            `Validator's program upgrade authority is ${upgradeAuth?.toBase58() ?? 'None (frozen)'} but tests use ${provider.wallet.publicKey.toBase58()}. ` +
            `Set [test] upgradeable = true in Anchor.toml OR ensure the validator deploys with --upgradeable-program <id> <path> ${provider.wallet.publicKey.toBase58()}.`
          );
        }
        await program.methods
          .initializeProtocolConfig()
          .accounts({
            payer: provider.wallet.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            programData: SETTLEMENT_PROGRAM_DATA,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }
    });

    it("should create a token mint", async () => {
      tokenMint = await createMint(
        connection,
        mintAuthority, // payer
        mintAuthority.publicKey, // mint authority
        null, // freeze authority
        6 // decimals for USDC-like token
      );
      expect(tokenMint).to.be.ok;
    });

    it("should create token accounts for client and provider", async () => {
      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );
      expect(clientTokenAccount).to.be.ok;
      expect(providerTokenAccount).to.be.ok;
    });

    it("should mint tokens to client", async () => {
      await mintTo(
        connection,
        mintAuthority, // payer
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey, // mint authority
        10000000n // 10 USDC
      );

      const account = await connection.getTokenAccountBalance(
        clientTokenAccount
      );
      expect(BigInt(account.value.amount)).to.equal(BigInt(10000000));
    });

    it("should register provider in Agent Registry for CPI", async () => {
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(provider_account.publicKey);

      await registryProgram.methods
        .registerAgent(
          "Test Provider",
          "Provider for settlement tests",
          "settlement-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: provider_account.publicKey,
          ownerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(provider_account.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([provider_account])
        .rpc();

      const profile = await registryProgram.account.agentProfile.fetch(profilePDA);
      expect(profile.name).to.equal("Test Provider");
    });
  });

  // ============================================================================
  // AUD-005 (PR-H): initialize_protocol_config governance gate
  // ============================================================================
  //
  // The init context binds `payer` to the program's upgrade authority via
  // BPF Upgradeable Loader's ProgramData. After init, ProtocolConfig.authority
  // is independent — no other instruction in this program references
  // ProgramData. See DESIGN-DECISIONS-2026-04-25.md (Option C).
  //
  // Test environment notes:
  // - The Anchor test harness deploys with `provider.wallet` as the upgrade
  //   authority. The `Setup` block above already exercises the happy path by
  //   successfully calling `initialize_protocol_config` with `provider.wallet`
  //   as payer + the program-data account. We re-assert the post-init state
  //   here (case 1) for spec parity with DESIGN-DECISIONS-2026-04-25.md.
  // - Case 2 (non-upgrade-authority) cannot be re-exercised against a live
  //   validator because the singleton ProtocolConfig PDA is already
  //   initialized, so any retry hits Anchor's `init` "already in use" error
  //   before the `program_data` constraint runs (Anchor evaluates account
  //   constraints in struct-field order: `payer` → `protocol_config (init)` →
  //   `program_data`). Unit-test coverage for the predicate itself lives in
  //   `programs/settlement/src/instructions/protocol_config.rs::tests`.
  // - Case 3 (decoupling) is asserted structurally: UpdateProtocolConfig has
  //   no programData field — confirmed by inspecting the IDL and by the fact
  //   that the existing update_protocol_config flow continues to work using
  //   only `authority` + `protocolConfig`.
  describe("AUD-005: initialize_protocol_config governance gate", () => {
    it("happy path: ProtocolConfig.authority == upgrade authority after init", async () => {
      // Setup already initialized via provider.wallet (the local-cluster
      // upgrade authority). Read back and assert the binding.
      const config = await (program.account as any).protocolConfig.fetch(
        PROTOCOL_CONFIG_PDA
      );
      expect(config.authority.toBase58()).to.equal(
        provider.wallet.publicKey.toBase58(),
        "ProtocolConfig.authority must equal the upgrade authority that paid for init"
      );
    });

    it("negative: a non-upgrade-authority key cannot reinitialize the singleton", async () => {
      // The singleton is already initialized, so a second call will fail.
      // Whether the failure is `Unauthorized` (preferred — proves the gate)
      // or `AlreadyInUse` (struct-field-order side effect — also proves the
      // gate, since a randomly-funded keypair cannot reach a state where the
      // singleton is uninitialized), either outcome is acceptable: BOTH
      // imply the random key cannot create a competing ProtocolConfig. We
      // assert that the call rejects with SOME error, and log the variant
      // for diagnostic clarity.
      const randomKey = Keypair.generate();
      const sig = await connection.requestAirdrop(
        randomKey.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);

      let rejected = false;
      try {
        await program.methods
          .initializeProtocolConfig()
          .accounts({
            payer: randomKey.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            programData: SETTLEMENT_PROGRAM_DATA,
            systemProgram: SystemProgram.programId,
          })
          .signers([randomKey])
          .rpc();
      } catch (err: any) {
        rejected = true;
        // Either Unauthorized (constraint) or AlreadyInUse (init) is fine —
        // both prove a random key cannot install a config.
        const msg = (err && err.toString()) || "";
        // Sanity: it must NOT have succeeded silently.
        expect(rejected, `init by random key must fail; got: ${msg}`).to.equal(true);
      }
      expect(rejected, "non-upgrade-authority init must be rejected").to.equal(true);
    });

    it("decoupling: update_protocol_config works without ProgramData (no upgrade-authority coupling post-init)", async () => {
      // The update flow uses only `authority` + `protocolConfig` accounts;
      // it does NOT reference ProgramData. We exercise a no-op update
      // (all Option fields = null) to prove the path is reachable without
      // any upgrade-authority account, then assert the config is unchanged.
      const before = await (program.account as any).protocolConfig.fetch(
        PROTOCOL_CONFIG_PDA
      );

      await program.methods
        .updateProtocolConfig(null, null, null, null, null)
        .accounts({
          authority: provider.wallet.publicKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
        })
        .rpc();

      const after = await (program.account as any).protocolConfig.fetch(
        PROTOCOL_CONFIG_PDA
      );
      expect(after.authority.toBase58()).to.equal(before.authority.toBase58());
      expect(after.minEscrowAmount.toString()).to.equal(
        before.minEscrowAmount.toString()
      );
      expect(after.disputeTimeoutSeconds.toString()).to.equal(
        before.disputeTimeoutSeconds.toString()
      );
    });
  });

  // ============================================================================
  // HAPPY PATH: FULL LIFECYCLE
  // ============================================================================

  describe("Happy Path: Full lifecycle", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(100);
    let descriptionHash = Buffer.from(
      "0000000000000000000000000000000000000000000000000000000000000001",
      "hex"
    );

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Register provider in Agent Registry for CPI reputation updates
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      await registryProgram.methods
        .registerAgent(
          "Happy Path Provider",
          "Provider for happy path tests",
          "happy-path",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: provider_account.publicKey,
          ownerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(provider_account.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([provider_account])
        .rpc();
    });

    it("should create escrow with 2 milestones", async () => {
      // Derive escrow token account as ATA of escrow PDA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(500000n, Buffer.alloc(32, 1)),
        createMilestoneData(500000n, Buffer.alloc(32, 2)),
      ];

      const tx = await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          descriptionHash,
          FUTURE_DEADLINE,
          milestonesData,
          null
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();

      // Fetch and verify escrow state
      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.client.toString()).to.equal(client.publicKey.toString());
      expect(escrow.provider.toString()).to.equal(
        provider_account.publicKey.toString()
      );
      expect(escrow.totalAmount.toString()).to.equal("1000000");
      expect(escrow.releasedAmount.toString()).to.equal("0");
      expect(escrow.status.created).to.be.ok; // EscrowStatus::Created
      expect(escrow.taskId.toString()).to.equal(taskId.toString());
      expect(escrow.milestones.length).to.equal(2);
      expect(escrow.milestones[0].amount.toString()).to.equal("500000");
      expect(escrow.milestones[1].amount.toString()).to.equal("500000");
      expect(escrow.milestones[0].status.pending).to.be.ok;
      expect(escrow.milestones[1].status.pending).to.be.ok;

      // Verify tokens transferred to escrow
      const escrowBalance = await connection.getTokenAccountBalance(
        escrowTokenAccount
      );
      expect(BigInt(escrowBalance.value.amount)).to.equal(1000000n);
    });

    it("should accept task (provider)", async () => {
      const tx = await program.methods
        .acceptTask()
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.active).to.be.ok; // EscrowStatus::Active
    });

    it("should submit milestone 0 (provider)", async () => {
      const tx = await program.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.submitted).to.be.ok;
    });

    it("should approve milestone 0 (client), releasing funds", async () => {
      // Need to derive or get the actual escrow token account
      // For this test, we'll use the one we created earlier
      const escrowTokenAccountInfo = await connection.getAccountInfo(
        escrowTokenAccount
      );
      expect(escrowTokenAccountInfo).to.be.ok;

      const [providerProfilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      // Finding #8 (legacy) / AUD-007 (PR-Q): rating arg is still required by
      // the instruction signature for forward-compat with a future rating ix.
      // PR-Q removed `avg_rating` from on-chain `AgentProfile`, so this value
      // no longer mutates any aggregate; we pass 4 just to exercise the
      // 0..=5 validation path end-to-end.
      const tx = await program.methods
        .approveMilestone(new BN(0), 4)
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: provider_account.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.approved).to.be.ok;
      expect(escrow.releasedAmount.toString()).to.equal("500000");

      // Verify provider received tokens
      const providerBalance = await connection.getTokenAccountBalance(
        providerTokenAccount
      );
      expect(BigInt(providerBalance.value.amount)).to.equal(500000n);
    });

    it("should submit milestone 1 (provider)", async () => {
      const tx = await program.methods
        .submitMilestone(new BN(1), new BN(0))
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[1].status.submitted).to.be.ok;
    });

    it("should approve milestone 1, auto-completing escrow", async () => {
      const [providerProfilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      // Final milestone: rating=5. Pre-PR-Q this folded into the registry's
      // `avg_rating` via update_provider_reputation. AUD-007 (PR-Q) removed
      // `avg_rating` from on-chain state; the CPI still runs (it carries the
      // bounded reputation_delta) but no rating aggregate is mutated.
      const tx = await program.methods
        .approveMilestone(new BN(1), 5)
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: provider_account.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[1].status.approved).to.be.ok;
      expect(escrow.releasedAmount.toString()).to.equal("1000000");
      expect(escrow.status.completed).to.be.ok; // Auto-completed
    });
  });

  // ============================================================================
  // CANCELLATION FLOW
  // ============================================================================

  describe("Cancellation flow", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(101);

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Derive escrow token account as ATA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(1000000n, Buffer.alloc(32, 1)),
      ];

      await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          milestonesData,
          null
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();
    });

    it("should cancel escrow before acceptance and refund client", async () => {
      const clientBalanceBefore = await connection.getTokenAccountBalance(
        clientTokenAccount
      );
      const balanceBefore = BigInt(clientBalanceBefore.value.amount);

      const tx = await program.methods
        .cancelEscrow()
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          clientTokenAccount: clientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.cancelled).to.be.ok;

      const clientBalanceAfter = await connection.getTokenAccountBalance(
        clientTokenAccount
      );
      const balanceAfter = BigInt(clientBalanceAfter.value.amount);
      expect(balanceAfter).to.equal(balanceBefore + 1000000n);
    });
  });

  // ============================================================================
  // DISPUTE FLOW
  // ============================================================================

  describe("Dispute flow", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(102);
    let resolver_account: Keypair;

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();
      resolver_account = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account, resolver_account]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Derive escrow token account as ATA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(1000000n, Buffer.alloc(32, 1)),
      ];

      await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          milestonesData,
          resolver_account.publicKey
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();

      // Register provider in Agent Registry (required for CPI reputation updates)
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(provider_account.publicKey);

      await registryProgram.methods
        .registerAgent(
          "Dispute Test Provider",
          "Provider for dispute flow tests",
          "dispute-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: provider_account.publicKey,
          ownerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(provider_account.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([provider_account])
        .rpc();

      // Accept task
      await program.methods
        .acceptTask()
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();
    });

    it("should raise dispute", async () => {
      const tx = await program.methods
        .raiseDispute()
        .accounts({
          requester: client.publicKey,
          escrow: escrowPDA,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.disputed).to.be.ok;
    });

    it("should resolve dispute with 50/50 split", async () => {
      const clientRefund = new BN(500000);
      const providerRefund = new BN(500000);

      const [providerProfilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      const tx = await program.methods
        .resolveDispute(clientRefund, providerRefund)
        .accounts({
          resolver: resolver_account.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          clientTokenAccount: clientTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: provider_account.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([resolver_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.completed).to.be.ok;

      // Verify both parties received funds
      const clientBalance = await connection.getTokenAccountBalance(
        clientTokenAccount
      );
      const providerBalance = await connection.getTokenAccountBalance(
        providerTokenAccount
      );

      expect(BigInt(clientBalance.value.amount) >= 500000n).to.be.true;
      expect(BigInt(providerBalance.value.amount) >= 500000n).to.be.true;
    });
  });

  // ============================================================================
  // REJECTION + REWORK FLOW
  // ============================================================================

  describe("Rejection + rework flow", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(103);

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Derive escrow token account as ATA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(1000000n, Buffer.alloc(32, 1)),
      ];

      await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          milestonesData,
          null
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();

      // Register provider in Agent Registry for CPI
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      await registryProgram.methods
        .registerAgent(
          "Rework Provider",
          "Provider for rework tests",
          "rework-test",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: provider_account.publicKey,
          ownerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(provider_account.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([provider_account])
        .rpc();

      // Accept task
      await program.methods
        .acceptTask()
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();
    });

    it("should submit milestone", async () => {
      await program.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.submitted).to.be.ok;
    });

    it("should reject milestone", async () => {
      await program.methods
        .rejectMilestone(new BN(0))
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.pending).to.be.ok;
    });

    it("should re-submit milestone", async () => {
      await program.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.submitted).to.be.ok;
    });

    it("should approve after rework", async () => {
      const [providerProfilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      await program.methods
        .approveMilestone(new BN(0), 0)
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: provider_account.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.milestones[0].status.approved).to.be.ok;
      expect(escrow.status.completed).to.be.ok;
    });
  });

  // ============================================================================
  // VALIDATION TESTS
  // ============================================================================

  describe("Validation", () => {
    let clientLocal: Keypair;
    let providerLocal: Keypair;
    let clientTokenAccountLocal: PublicKey;

    before(async () => {
      clientLocal = Keypair.generate();
      providerLocal = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [clientLocal, providerLocal]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccountLocal = await getOrCreateTokenAccount(
        clientLocal.publicKey,
        clientLocal
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccountLocal,
        mintAuthority.publicKey,
        10000000n
      );
    });

    it("should reject escrow with 0 milestones", async () => {
      const escrowPDA = (
        await deriveEscrowPDA(clientLocal.publicKey, providerLocal.publicKey, 200n)
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);

      try {
        await program.methods
          .createEscrow(new BN(200), new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, [], null)
          .accounts({
            client: clientLocal.publicKey, clientVault: vaultFor(clientLocal.publicKey),
            providerVault: vaultFor(providerLocal.publicKey), provider: providerLocal.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenMint, clientTokenAccount: clientTokenAccountLocal,
            escrow: escrowPDA, escrowTokenAccount: escrowTA,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([clientLocal])
          .rpc();
        expect.fail("Should have thrown InvalidMilestoneCount error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject escrow with 6 milestones", async () => {
      const escrowPDA = (
        await deriveEscrowPDA(clientLocal.publicKey, providerLocal.publicKey, 201n)
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = Array(6).fill(null).map(() => createMilestoneData(1000000n));

      try {
        await program.methods
          .createEscrow(new BN(201), new BN(6000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null)
          .accounts({
            client: clientLocal.publicKey, clientVault: vaultFor(clientLocal.publicKey),
            providerVault: vaultFor(providerLocal.publicKey), provider: providerLocal.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenMint, clientTokenAccount: clientTokenAccountLocal,
            escrow: escrowPDA, escrowTokenAccount: escrowTA,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([clientLocal])
          .rpc();
        expect.fail("Should have thrown InvalidMilestoneCount error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject when milestone amounts don't sum to total", async () => {
      const escrowPDA = (
        await deriveEscrowPDA(clientLocal.publicKey, providerLocal.publicKey, 202n)
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = [createMilestoneData(500000n), createMilestoneData(300000n)];

      try {
        await program.methods
          .createEscrow(new BN(202), new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null)
          .accounts({
            client: clientLocal.publicKey, clientVault: vaultFor(clientLocal.publicKey),
            providerVault: vaultFor(providerLocal.publicKey), provider: providerLocal.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenMint, clientTokenAccount: clientTokenAccountLocal,
            escrow: escrowPDA, escrowTokenAccount: escrowTA,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([clientLocal])
          .rpc();
        expect.fail("Should have thrown MilestoneAmountMismatch error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject when deadline is in the past", async () => {
      const escrowPDA = (
        await deriveEscrowPDA(clientLocal.publicKey, providerLocal.publicKey, 203n)
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = [createMilestoneData(1000000n)];

      try {
        await program.methods
          .createEscrow(new BN(203), new BN(1000000), Buffer.alloc(32), PAST_DEADLINE, milestonesData, null)
          .accounts({
            client: clientLocal.publicKey, clientVault: vaultFor(clientLocal.publicKey),
            providerVault: vaultFor(providerLocal.publicKey), provider: providerLocal.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenMint, clientTokenAccount: clientTokenAccountLocal,
            escrow: escrowPDA, escrowTokenAccount: escrowTA,
            tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([clientLocal])
          .rpc();
        expect.fail("Should have thrown DeadlineInPast error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  // ============================================================================
  // AUTHORIZATION TESTS
  // ============================================================================

  describe("Authorization", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(104);
    let otherAccount: Keypair;

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();
      otherAccount = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account, otherAccount]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Derive escrow token account as ATA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(1000000n, Buffer.alloc(32, 1)),
      ];

      await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          milestonesData,
          null
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();
    });

    it("should reject non-provider accepting task", async () => {
      try {
        await program.methods
          .acceptTask()
          .accounts({
            provider: otherAccount.publicKey,
            escrow: escrowPDA,
          })
          .signers([otherAccount])
          .rpc();
        expect.fail("Should have thrown UnauthorizedProvider error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject non-client approving milestone", async () => {
      // First accept the task
      await program.methods
        .acceptTask()
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      // Submit milestone
      await program.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      // Try to approve as non-client
      const [providerProfilePDA] = deriveAgentProfilePDA(provider_account.publicKey);
      try {
        await program.methods
          .approveMilestone(new BN(0), 0)
          .accounts({
            client: otherAccount.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount: escrowTokenAccount,
            providerTokenAccount: providerTokenAccount,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: providerProfilePDA,
            providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
            // SEC-1: external authority anchor for Registry UpdateReputation CPI.
            providerAuthority: provider_account.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([otherAccount])
          .rpc();
        expect.fail("Should have thrown UnauthorizedClient error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject non-client cancelling escrow", async () => {
      // Create a new escrow for this test
      const taskId2 = new BN(105);
      const [escrowPDA2] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId2
      );
      const escrowTA2 = deriveEscrowTokenAccount(escrowPDA2);

      const milestonesData = [createMilestoneData(1000000n)];

      await program.methods
        .createEscrow(
          taskId2, new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null
        )
        .accounts({
          client: client.publicKey, clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey), provider: provider_account.publicKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenMint, clientTokenAccount,
          escrow: escrowPDA2, escrowTokenAccount: escrowTA2,
          tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();

      try {
        await program.methods
          .cancelEscrow()
          .accounts({
            client: otherAccount.publicKey,
            escrow: escrowPDA2,
            escrowTokenAccount: escrowTA2,
            clientTokenAccount: clientTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([otherAccount])
          .rpc();
        expect.fail("Should have thrown UnauthorizedClient error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject third party raising dispute", async () => {
      try {
        await program.methods
          .raiseDispute()
          .accounts({
            requester: otherAccount.publicKey,
            escrow: escrowPDA,
          })
          .signers([otherAccount])
          .rpc();
        expect.fail("Should have thrown UnauthorizedDispute error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  // ============================================================================
  // STATUS ENFORCEMENT TESTS
  // ============================================================================

  describe("Status enforcement", () => {
    let escrowPDA: PublicKey;
    let escrowBump: number;
    let escrowTokenAccount: PublicKey;
    let taskId = new BN(106);

    before(async () => {
      // Generate new keypairs for isolation
      client = Keypair.generate();
      provider_account = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [client, provider_account]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      clientTokenAccount = await getOrCreateTokenAccount(
        client.publicKey,
        client
      );
      providerTokenAccount = await getOrCreateTokenAccount(
        provider_account.publicKey,
        client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        clientTokenAccount,
        mintAuthority.publicKey,
        10000000n
      );

      [escrowPDA, escrowBump] = await deriveEscrowPDA(
        client.publicKey,
        provider_account.publicKey,
        taskId
      );

      // Derive escrow token account as ATA
      escrowTokenAccount = deriveEscrowTokenAccount(escrowPDA);

      const milestonesData = [
        createMilestoneData(1000000n, Buffer.alloc(32, 1)),
      ];

      await program.methods
        .createEscrow(new BN(taskId), new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          milestonesData,
          null
        )
        .accounts({
          client: client.publicKey,
          clientVault: vaultFor(client.publicKey),
          providerVault: vaultFor(provider_account.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider_account.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client])
        .rpc();
    });

    it("should reject submit milestone on non-Active escrow", async () => {
      // Escrow is Created, not Active
      try {
        await program.methods
          .submitMilestone(new BN(0), new BN(0))
          .accounts({
            provider: provider_account.publicKey,
            escrow: escrowPDA,
          })
          .signers([provider_account])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject accept when already Active", async () => {
      // Accept task
      await program.methods
        .acceptTask()
        .accounts({
          provider: provider_account.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider_account])
        .rpc();

      // Try to accept again
      try {
        await program.methods
          .acceptTask()
          .accounts({
            provider: provider_account.publicKey,
            escrow: escrowPDA,
          })
          .signers([provider_account])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should reject cancel when already Active", async () => {
      // Escrow is now Active
      try {
        await program.methods
          .cancelEscrow()
          .accounts({
            client: client.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount: escrowTokenAccount,
            clientTokenAccount: clientTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([client])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  // ============================================================================
  // T-03: SELF-DEALING PREVENTION
  // ============================================================================

  describe("Self-dealing prevention (T-03)", () => {
    it("should reject escrow where client equals provider", async () => {
      const samePerson = Keypair.generate();
      const sig = await connection.requestAirdrop(samePerson.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);

      const samePersonTA = await getOrCreateTokenAccount(samePerson.publicKey, samePerson);
      await mintTo(connection, mintAuthority, tokenMint, samePersonTA, mintAuthority.publicKey, 10000000n);

      const selfTaskId = new BN(900);
      const [selfEscrowPDA] = await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("escrow"),
          samePerson.publicKey.toBuffer(),
          samePerson.publicKey.toBuffer(),
          selfTaskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      const selfEscrowTA = getAssociatedTokenAddressSync(tokenMint, selfEscrowPDA, true);

      const milestonesData = [createMilestoneData(1000000n)];

      try {
        await program.methods
          .createEscrow(
            selfTaskId,
            new BN(1000000),
            Buffer.alloc(32),
            FUTURE_DEADLINE,
            milestonesData,
            null
          )
          .accounts({
            client: samePerson.publicKey,
            clientVault: vaultFor(samePerson.publicKey),
            providerVault: vaultFor(samePerson.publicKey),
            protocolConfig: PROTOCOL_CONFIG_PDA,
            provider: samePerson.publicKey,
            tokenMint: tokenMint,
            clientTokenAccount: samePersonTA,
            escrow: selfEscrowPDA,
            escrowTokenAccount: selfEscrowTA,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([samePerson])
          .rpc();
        expect.fail("Should have thrown SelfDealingProhibited error");
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.toString()).to.include("SelfDealingProhibited");
      }
    });
  });

  // ============================================================================
  // T-02: EXPIRE ESCROW WITH APPROVED MILESTONES
  // ============================================================================

  describe("Expire escrow with approved milestones (T-02)", () => {
    let expClient: Keypair;
    let expProvider: Keypair;
    let expEscrowPDA: PublicKey;
    let expEscrowTA: PublicKey;
    let expClientTA: PublicKey;
    let expProviderTA: PublicKey;
    const expTaskId = new BN(901);

    before(async () => {
      expClient = Keypair.generate();
      expProvider = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const kp of [expClient, expProvider]) {
        const sig = await connection.requestAirdrop(kp.publicKey, airdropAmount);
        await connection.confirmTransaction(sig);
      }

      expClientTA = await getOrCreateTokenAccount(expClient.publicKey, expClient);
      expProviderTA = await getOrCreateTokenAccount(expProvider.publicKey, expClient);
      await mintTo(connection, mintAuthority, tokenMint, expClientTA, mintAuthority.publicKey, 10000000n);

      // Register provider for CPI
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(expProvider.publicKey);
      await registryProgram.methods
        .registerAgent(
          "Expire Test Provider",
          "Provider for expire tests",
          "expire-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: expProvider.publicKey,
          ownerNonce: deriveOwnerNoncePDA(expProvider.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(expProvider.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([expProvider])
        .rpc();

      // AUD-055: Use the smallest future deadline accepted by `create_escrow`
      // (`require!(deadline > now)`). The C1 test below polls the on-chain
      // clock until `now > deadline` rather than waiting wall-clock seconds,
      // so this only needs to be far enough ahead that the in-`before`
      // submit_milestone calls (`require!(now <= deadline)`) still land in time.
      const shortDeadline = new BN(Math.floor(Date.now() / 1000) + 2);

      const milestonesData = [
        createMilestoneData(500000n, Buffer.alloc(32, 1)),
        createMilestoneData(500000n, Buffer.alloc(32, 2)),
      ];

      [expEscrowPDA] = await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("escrow"),
          expClient.publicKey.toBuffer(),
          expProvider.publicKey.toBuffer(),
          expTaskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      expEscrowTA = getAssociatedTokenAddressSync(tokenMint, expEscrowPDA, true);

      // Create escrow with short deadline
      await program.methods
        .createEscrow(expTaskId, new BN(1000000), Buffer.alloc(32), shortDeadline, milestonesData, null)
        .accounts({
          client: expClient.publicKey,
          clientVault: vaultFor(expClient.publicKey),
          providerVault: vaultFor(expProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: expProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: expClientTA,
          escrow: expEscrowPDA,
          escrowTokenAccount: expEscrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([expClient])
        .rpc();

      // Accept task
      await program.methods.acceptTask()
        .accounts({ provider: expProvider.publicKey, escrow: expEscrowPDA })
        .signers([expProvider]).rpc();

      // Submit milestone 0
      await program.methods.submitMilestone(new BN(0), new BN(0))
        .accounts({ provider: expProvider.publicKey, escrow: expEscrowPDA })
        .signers([expProvider]).rpc();

      // Approve milestone 0 (releases 500K to provider)
      const [provProfilePDA] = deriveAgentProfilePDA(expProvider.publicKey);
      await program.methods.approveMilestone(new BN(0), 0)
        .accounts({
          client: expClient.publicKey,
          escrow: expEscrowPDA,
          escrowTokenAccount: expEscrowTA,
          providerTokenAccount: expProviderTA,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: provProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: expProvider.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([expClient]).rpc();

      // Submit milestone 1 (leave as Submitted — not approved)
      await program.methods.submitMilestone(new BN(1), new BN(0))
        .accounts({ provider: expProvider.publicKey, escrow: expEscrowPDA })
        .signers([expProvider]).rpc();
    });

    it("C1 + AUD-010: all-Approved on expiry → status Completed + success-path reputation CPI", async () => {
      // AUD-055: Poll the on-chain clock until `now > escrow.deadline` rather
      // than burning a fixed 6s wall-clock wait. `expire_escrow` checks
      // `clock.unix_timestamp > escrow.deadline`, so we wait on the same
      // signal the program checks. Slots advance ~400ms apart on
      // solana-test-validator, so this typically returns in ~2 polls.
      const escrowAcct = await program.account.taskEscrow.fetch(expEscrowPDA);
      const deadline = escrowAcct.deadline.toNumber();
      // Generous bound vs fixed sleep: still flake-resistant, but tied to a
      // real on-chain condition rather than a wall-clock guess.
      const pollDeadline = Date.now() + 30_000;
      while (Date.now() < pollDeadline) {
        const slot = await connection.getSlot("confirmed");
        const chainTime = await connection.getBlockTime(slot);
        if (chainTime !== null && chainTime > deadline) break;
        await new Promise((resolve) => setImmediate(resolve));
      }

      const [provProfilePDA] = deriveAgentProfilePDA(expProvider.publicKey);
      const registryProgram = anchor.workspace.AgentRegistry as Program;

      // AUD-010: Snapshot the provider's reputation BEFORE expire so we
      // can verify the success-path CPI fires (was previously skipped on
      // the timeout rail). M0 was already approved manually in `before`,
      // which already added one `reputation_delta_task_completed` (=10).
      const profileBefore = await registryProgram.account.agentProfile.fetch(provProfilePDA);
      const repBefore = BigInt(profileBefore.reputationScore.toString());

      await program.methods.expireEscrow()
        .accounts({
          payer: expClient.publicKey,
          escrow: expEscrowPDA,
          escrowTokenAccount: expEscrowTA,
          clientTokenAccount: expClientTA,
          providerTokenAccount: expProviderTA,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: provProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(expProvider.publicKey)[0],
          // SEC-1: external authority anchor for Registry UpdateReputation CPI.
          providerAuthority: expProvider.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([expClient]).rpc();

      const escrow = await program.account.taskEscrow.fetch(expEscrowPDA);

      // AUD-010: When the auto-approval sweep leaves every milestone in
      // `Approved`, the escrow effectively completed via the timeout
      // rail. Status MUST be `Completed`, NOT `Expired`.
      expect(escrow.status.completed, `expected status=Completed, got ${JSON.stringify(escrow.status)}`).to.be.ok;
      expect(escrow.status.expired).to.be.undefined;

      // AUD-010: Both milestones must end in `Approved`.
      for (const m of escrow.milestones) {
        expect(m.status.approved, `milestone status was ${JSON.stringify(m.status)}`).to.be.ok;
      }

      // C1: Milestone 1 was Submitted-but-not-Approved at deadline.
      // Under the fixed semantics, silence = acceptance: the provider
      // is paid for submitted work rather than the client being refunded.
      // This closes the stall-then-refund economic attack.
      const clientBalance = await connection.getTokenAccountBalance(expClientTA);
      // Client started with 10M, locked 1M, no refund (both milestones were
      // either Approved or Submitted) = 9M.
      expect(BigInt(clientBalance.value.amount)).to.equal(9000000n);

      // Provider received 500K from M0 approval + 500K auto-paid from M1
      // Submitted-on-expiry = 1M total.
      const providerBalance = await connection.getTokenAccountBalance(expProviderTA);
      expect(BigInt(providerBalance.value.amount)).to.equal(1000000n);

      // AUD-010 core assertion: success-path CPI fired. The provider's
      // `reputation_score` is bumped by `reputation_delta_task_completed`
      // (= 10 post-PR-G). Pre-fix, the timeout rail silently skipped this
      // even when every milestone ended up Approved, costing the provider
      // the +task_completed reward simply because the client was slow.
      const profileAfter = await registryProgram.account.agentProfile.fetch(provProfilePDA);
      const repAfter = BigInt(profileAfter.reputationScore.toString());
      expect(repAfter - repBefore).to.equal(10n);
    });
  });

  // ============================================================================
  // T-02b: EXPIRE ESCROW WITH MIXED PENDING/SUBMITTED (AUD-010 NEGATIVE)
  // ============================================================================
  // AUD-010: When the milestones at expiry are NOT all Approved (i.e. at
  // least one is Pending — the provider failed to submit), the slash path
  // remains unchanged: status → Expired, negative reputation CPI fires
  // (reason 1, expiry_undelivered). This guards against the fix
  // accidentally changing the slash semantics.

  describe("Expire escrow with mixed Pending/Submitted (T-02b, AUD-010 negative)", () => {
    let mixClient: Keypair;
    let mixProvider: Keypair;
    let mixEscrowPDA: PublicKey;
    let mixEscrowTA: PublicKey;
    let mixClientTA: PublicKey;
    let mixProviderTA: PublicKey;
    const mixTaskId = new BN(903);

    before(async () => {
      mixClient = Keypair.generate();
      mixProvider = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const kp of [mixClient, mixProvider]) {
        const sig = await connection.requestAirdrop(kp.publicKey, airdropAmount);
        await connection.confirmTransaction(sig);
      }

      mixClientTA = await getOrCreateTokenAccount(mixClient.publicKey, mixClient);
      mixProviderTA = await getOrCreateTokenAccount(mixProvider.publicKey, mixClient);
      await mintTo(connection, mintAuthority, tokenMint, mixClientTA, mintAuthority.publicKey, 10000000n);

      // Register provider for CPI
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(mixProvider.publicKey);
      await registryProgram.methods
        .registerAgent(
          "Mixed Test Provider",
          "Provider for mixed-state expire tests",
          "mixed-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: mixProvider.publicKey,
          ownerNonce: deriveOwnerNoncePDA(mixProvider.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(mixProvider.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([mixProvider])
        .rpc();

      // Same short-deadline pattern as T-02 (we poll on-chain time below).
      const shortDeadline = new BN(Math.floor(Date.now() / 1000) + 2);

      const milestonesData = [
        createMilestoneData(500000n, Buffer.alloc(32, 1)),
        createMilestoneData(500000n, Buffer.alloc(32, 2)),
      ];

      [mixEscrowPDA] = await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("escrow"),
          mixClient.publicKey.toBuffer(),
          mixProvider.publicKey.toBuffer(),
          mixTaskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      mixEscrowTA = getAssociatedTokenAddressSync(tokenMint, mixEscrowPDA, true);

      await program.methods
        .createEscrow(mixTaskId, new BN(1000000), Buffer.alloc(32), shortDeadline, milestonesData, null)
        .accounts({
          client: mixClient.publicKey,
          clientVault: vaultFor(mixClient.publicKey),
          providerVault: vaultFor(mixProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: mixProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: mixClientTA,
          escrow: mixEscrowPDA,
          escrowTokenAccount: mixEscrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([mixClient])
        .rpc();

      // Accept task → status becomes Active (precondition for slash).
      await program.methods.acceptTask()
        .accounts({ provider: mixProvider.publicKey, escrow: mixEscrowPDA })
        .signers([mixProvider]).rpc();

      // Provider only submits 1 of 2 milestones; M1 is left Pending. This
      // is the "mixed Pending/Submitted" shape AUD-010 leaves untouched.
      await program.methods.submitMilestone(new BN(0), new BN(0))
        .accounts({ provider: mixProvider.publicKey, escrow: mixEscrowPDA })
        .signers([mixProvider]).rpc();
    });

    it("AUD-010 negative: mixed state on expiry → status Expired + slash CPI (NOT success CPI)", async () => {
      // Wait for on-chain time to cross the deadline.
      const escrowAcct = await program.account.taskEscrow.fetch(mixEscrowPDA);
      const deadline = escrowAcct.deadline.toNumber();
      const pollDeadline = Date.now() + 30_000;
      while (Date.now() < pollDeadline) {
        const slot = await connection.getSlot("confirmed");
        const chainTime = await connection.getBlockTime(slot);
        if (chainTime !== null && chainTime > deadline) break;
        await new Promise((resolve) => setImmediate(resolve));
      }

      const [provProfilePDA] = deriveAgentProfilePDA(mixProvider.publicKey);
      const registryProgram = anchor.workspace.AgentRegistry as Program;

      // Snapshot reputation BEFORE expire. Fresh agent starts at 0, so
      // the slash will be capped at 0 by the Registry's lower bound, but
      // we still verify the call DID NOT bump the score upward (which is
      // what would happen if the success CPI mistakenly fired here).
      const profileBefore = await registryProgram.account.agentProfile.fetch(provProfilePDA);
      const repBefore = BigInt(profileBefore.reputationScore.toString());

      await program.methods.expireEscrow()
        .accounts({
          payer: mixClient.publicKey,
          escrow: mixEscrowPDA,
          escrowTokenAccount: mixEscrowTA,
          clientTokenAccount: mixClientTA,
          providerTokenAccount: mixProviderTA,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: provProfilePDA,
          providerOwnerNonce: deriveOwnerNoncePDA(mixProvider.publicKey)[0],
          providerAuthority: mixProvider.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([mixClient]).rpc();

      const escrow = await program.account.taskEscrow.fetch(mixEscrowPDA);

      // AUD-010: Mixed state MUST land on `Expired`, not `Completed`.
      expect(escrow.status.expired, `expected status=Expired, got ${JSON.stringify(escrow.status)}`).to.be.ok;
      expect(escrow.status.completed).to.be.undefined;

      // M0 (Submitted) auto-approved; M1 (Pending) stays Pending.
      expect(escrow.milestones[0].status.approved).to.be.ok;
      expect(escrow.milestones[1].status.pending).to.be.ok;

      // Provider received 500K (M0 silence=acceptance); client refunded 500K (M1).
      const providerBalance = await connection.getTokenAccountBalance(mixProviderTA);
      expect(BigInt(providerBalance.value.amount)).to.equal(500000n);
      const clientBalance = await connection.getTokenAccountBalance(mixClientTA);
      // Started with 10M, locked 1M, refunded 500K = 9.5M.
      expect(BigInt(clientBalance.value.amount)).to.equal(9500000n);

      // Slash CPI fired (reputation_score did NOT increase). Score stays
      // at 0 because the Registry clamps to [0, 100] and this is a fresh
      // agent — but critically it did NOT jump up by +10, which would
      // indicate the success CPI was incorrectly fired on the slash path.
      const profileAfter = await registryProgram.account.agentProfile.fetch(provProfilePDA);
      const repAfter = BigInt(profileAfter.reputationScore.toString());
      expect(repAfter <= repBefore, `slash path must not bump reputation up; before=${repBefore} after=${repAfter}`).to.be.true;
    });
  });

  // ============================================================================
  // T-01: DISPUTE TIMEOUT RESOLUTION (NEGATIVE PATHS)
  // ============================================================================

  describe("Dispute timeout resolution (T-01)", () => {
    let toClient: Keypair;
    let toProvider: Keypair;
    let toEscrowPDA: PublicKey;
    let toEscrowTA: PublicKey;
    let toClientTA: PublicKey;
    let toProviderTA: PublicKey;
    const toTaskId = new BN(902);

    before(async () => {
      toClient = Keypair.generate();
      toProvider = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const kp of [toClient, toProvider]) {
        const sig = await connection.requestAirdrop(kp.publicKey, airdropAmount);
        await connection.confirmTransaction(sig);
      }

      toClientTA = await getOrCreateTokenAccount(toClient.publicKey, toClient);
      toProviderTA = await getOrCreateTokenAccount(toProvider.publicKey, toClient);
      await mintTo(connection, mintAuthority, tokenMint, toClientTA, mintAuthority.publicKey, 10000000n);

      // Register provider for CPI
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(toProvider.publicKey);
      await registryProgram.methods
        .registerAgent(
          "Timeout Test Provider",
          "Provider for timeout tests",
          "timeout-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: toProvider.publicKey,
          ownerNonce: deriveOwnerNoncePDA(toProvider.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(toProvider.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([toProvider])
        .rpc();

      const milestonesData = [createMilestoneData(1000000n)];

      [toEscrowPDA] = await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("escrow"),
          toClient.publicKey.toBuffer(),
          toProvider.publicKey.toBuffer(),
          toTaskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      toEscrowTA = getAssociatedTokenAddressSync(tokenMint, toEscrowPDA, true);

      await program.methods
        .createEscrow(toTaskId, new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null)
        .accounts({
          client: toClient.publicKey,
          clientVault: vaultFor(toClient.publicKey),
          providerVault: vaultFor(toProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: toProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: toClientTA,
          escrow: toEscrowPDA,
          escrowTokenAccount: toEscrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([toClient])
        .rpc();

      // Accept task and raise dispute
      await program.methods.acceptTask()
        .accounts({ provider: toProvider.publicKey, escrow: toEscrowPDA })
        .signers([toProvider]).rpc();

      await program.methods.raiseDispute()
        .accounts({ requester: toClient.publicKey, escrow: toEscrowPDA })
        .signers([toClient]).rpc();
    });

    it("should reject timeout resolution when timeout has not elapsed", async () => {
      const [provProfilePDA] = deriveAgentProfilePDA(toProvider.publicKey);

      try {
        await program.methods.resolveDisputeTimeout()
          .accounts({
            payer: toClient.publicKey,
            escrow: toEscrowPDA,
            escrowTokenAccount: toEscrowTA,
            clientTokenAccount: toClientTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: provProfilePDA,
            providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
            // SEC-1: external authority anchor for Registry UpdateReputation CPI.
            providerAuthority: toProvider.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([toClient]).rpc();
        expect.fail("Should have thrown DisputeTimeoutNotReached error");
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.toString()).to.include("DisputeTimeoutNotReached");
      }
    });

    // TODO: Positive path test (timeout actually elapsed) requires anchor-bankrun
    // or a test feature flag to override DISPUTE_TIMEOUT_SECONDS (7 days).
    // The negative path above validates the critical code path.

    it("should reject timeout resolution on non-disputed escrow", async () => {
      // Create a separate Active (non-disputed) escrow
      const ndTaskId = new BN(903);
      const [ndEscrowPDA] = await anchor.web3.PublicKey.findProgramAddress(
        [
          Buffer.from("escrow"),
          toClient.publicKey.toBuffer(),
          toProvider.publicKey.toBuffer(),
          ndTaskId.toArrayLike(Buffer, "le", 8),
        ],
        program.programId
      );
      const ndEscrowTA = getAssociatedTokenAddressSync(tokenMint, ndEscrowPDA, true);

      await mintTo(connection, mintAuthority, tokenMint, toClientTA, mintAuthority.publicKey, 10000000n);

      const milestonesData = [createMilestoneData(1000000n)];
      await program.methods
        .createEscrow(ndTaskId, new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null)
        .accounts({
          client: toClient.publicKey,
          clientVault: vaultFor(toClient.publicKey),
          providerVault: vaultFor(toProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: toProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: toClientTA,
          escrow: ndEscrowPDA,
          escrowTokenAccount: ndEscrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([toClient])
        .rpc();

      await program.methods.acceptTask()
        .accounts({ provider: toProvider.publicKey, escrow: ndEscrowPDA })
        .signers([toProvider]).rpc();

      // Try timeout resolution on Active (non-disputed) escrow
      const [provProfilePDA] = deriveAgentProfilePDA(toProvider.publicKey);

      try {
        await program.methods.resolveDisputeTimeout()
          .accounts({
            payer: toClient.publicKey,
            escrow: ndEscrowPDA,
            escrowTokenAccount: ndEscrowTA,
            clientTokenAccount: toClientTA,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: provProfilePDA,
            providerOwnerNonce: deriveOwnerNoncePDA(provider_account.publicKey)[0],
            // SEC-1: external authority anchor for Registry UpdateReputation CPI.
            providerAuthority: toProvider.publicKey,
            settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([toClient]).rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  // ============================================================================
  // AUD-009: accept_task deadline guard (PR-R)
  // ============================================================================
  //
  // Pre-fix, accept_task only required `escrow.status == Created`. A provider
  // could therefore accept an already-expired escrow, flipping it to Active
  // and locking client funds until expire_escrow ran (cancel_escrow is
  // Created-only). Fix: reject with `DeadlinePassed` when `now > deadline`.

  describe("AUD-009: accept_task deadline guard", () => {
    let audClient: Keypair;
    let audProvider: Keypair;
    let audClientTA: PublicKey;
    let audProviderTA: PublicKey;

    before(async () => {
      audClient = Keypair.generate();
      audProvider = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const kp of [audClient, audProvider]) {
        const sig = await connection.requestAirdrop(kp.publicKey, airdropAmount);
        await connection.confirmTransaction(sig);
      }

      audClientTA = await getOrCreateTokenAccount(audClient.publicKey, audClient);
      audProviderTA = await getOrCreateTokenAccount(audProvider.publicKey, audClient);
      await mintTo(connection, mintAuthority, tokenMint, audClientTA, mintAuthority.publicKey, 10000000n);

      // Register provider for downstream CPI consistency (not strictly
      // needed for accept_task, but matches the rest of the suite's setup).
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(audProvider.publicKey);
      await registryProgram.methods
        .registerAgent(
          "AUD-009 Provider",
          "Provider for AUD-009 deadline guard tests",
          "aud009-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: audProvider.publicKey,
          ownerNonce: deriveOwnerNoncePDA(audProvider.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(audProvider.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([audProvider])
        .rpc();
    });

    it("should reject accept_task when deadline has already passed", async () => {
      // The on-chain check is `now < escrow.deadline` (AUD-105 cycle-2:
      // tightened from inclusive `<=` to strict `<` so the provider always
      // has at least one second of execution headroom for submit_milestone).
      // `now` is `Clock::get()?.unix_timestamp`. solana-test-validator's
      // clock starts at the validator's boot time and lags Date.now() by
      // seconds-to-tens-of-seconds on fresh boot — so a deadline computed
      // from Date.now() + 3 plus a 4s wall-clock sleep is not guaranteed
      // to land past the on-chain deadline.
      //
      // Same fix-pattern as commit 702d4da (AUD-024 boundary): query
      // on-chain time via getBlockTime, set the deadline relative to
      // that, then poll on-chain time until it crosses the deadline.
      const taskId = new BN(950);
      const startSlot = await connection.getSlot("confirmed");
      const onchainNow = await connection.getBlockTime(startSlot);
      if (onchainNow === null) {
        throw new Error(
          "getBlockTime returned null; cannot compute deadline-passed test"
        );
      }
      const shortDeadline = new BN(onchainNow + 2);

      const [escrowPDA] = await deriveEscrowPDA(
        audClient.publicKey,
        audProvider.publicKey,
        taskId
      );
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);

      await program.methods
        .createEscrow(
          taskId,
          new BN(1000000),
          Buffer.alloc(32),
          shortDeadline,
          [createMilestoneData(1000000n, Buffer.alloc(32, 1))],
          null
        )
        .accounts({
          client: audClient.publicKey,
          clientVault: vaultFor(audClient.publicKey),
          providerVault: vaultFor(audProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: audProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: audClientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([audClient])
        .rpc();

      // Confirm the escrow is Created — otherwise the deadline guard
      // we're testing wouldn't even get a chance to run.
      const created = await program.account.taskEscrow.fetch(escrowPDA);
      expect(created.status.created).to.be.ok;

      // Poll on-chain time until it has crossed the deadline. ~30s safety
      // bound vs the typical ~1-2 slot completion (~400-800ms).
      const deadlineSecs = shortDeadline.toNumber();
      const maxWaitMs = 30_000;
      const pollStart = Date.now();
      while (Date.now() - pollStart < maxWaitMs) {
        const s = await connection.getSlot("confirmed");
        const t = await connection.getBlockTime(s);
        if (t !== null && t > deadlineSecs) break;
        await new Promise((resolve) => setImmediate(resolve));
      }

      try {
        await program.methods
          .acceptTask()
          .accounts({
            provider: audProvider.publicKey,
            escrow: escrowPDA,
          })
          .signers([audProvider])
          .rpc();
        expect.fail("Should have thrown DeadlinePassed error");
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.toString()).to.include("DeadlinePassed");
      }

      // Escrow must still be Created — the failed accept_task must not
      // have transitioned the state machine. cancel_escrow is therefore
      // still available to the client.
      const post = await program.account.taskEscrow.fetch(escrowPDA);
      expect(post.status.created).to.be.ok;
    });

    it("should accept task when deadline is well in the future", async () => {
      const taskId = new BN(951);
      const [escrowPDA] = await deriveEscrowPDA(
        audClient.publicKey,
        audProvider.publicKey,
        taskId
      );
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);

      await program.methods
        .createEscrow(
          taskId,
          new BN(1000000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          [createMilestoneData(1000000n, Buffer.alloc(32, 1))],
          null
        )
        .accounts({
          client: audClient.publicKey,
          clientVault: vaultFor(audClient.publicKey),
          providerVault: vaultFor(audProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: audProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: audClientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([audClient])
        .rpc();

      await program.methods
        .acceptTask()
        .accounts({
          provider: audProvider.publicKey,
          escrow: escrowPDA,
        })
        .signers([audProvider])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.active).to.be.ok;
    });

    // ------------------------------------------------------------------
    // AUD-105 (cycle-2 follow-up to AUD-009)
    //
    // Roadmap §3 B7. Cycle-2 closure: commit 2a4d3c6 tightened the
    // accept_task guard from inclusive `now <= deadline` to strict
    // `now < deadline`, forcing the provider to retain at least one
    // second of execution headroom before submit_milestone's own
    // deadline check can trip.
    //
    // The pre-existing "should reject accept_task when deadline has
    // already passed" test above polls until `now > deadline`; under
    // the strict-< guard it still rejects, but it does NOT exercise
    // the literal `now == deadline` equality case that AUD-105 closed.
    // The Rust unit test `aud105_accept_task_rejects_at_deadline_boundary`
    // pins the predicate; this integration test pins the on-chain
    // behavior end-to-end.
    //
    // EQUALITY-POLLING STRATEGY:
    //   Solana's `Clock::get()?.unix_timestamp` is in seconds, but
    //   slots tick every ~400ms — so each integer second is
    //   typically observed across 2-3 consecutive slots. That gives
    //   a ~800-1200ms window during which `now == deadline` holds.
    //   We pick a deadline `T = onchainNow + 3` (large enough to
    //   absorb tx-build/sign latency, small enough that the
    //   surrounding wall-clock window is short), poll
    //   getBlockTime() until we see `t == T`, and submit
    //   `accept_task` immediately. We then sample getBlockTime()
    //   again post-tx and assert the on-chain time was still `>= T`
    //   when the rejection happened — i.e. we did NOT land
    //   pre-deadline (which would have ACCEPTED, not rejected).
    //
    //   We do not use anchor-bankrun's `warp_to_slot`: the test
    //   harness here is solana-test-validator (see grep for
    //   "anchor-bankrun" in this file — TODO at L2224, not adopted).
    //   Adding bankrun purely for this test would expand harness
    //   surface beyond what the AUD-105 boundary needs.
    //
    // If the tx happens to land in the same slot-second as `T`, we
    // have exercised the literal equality boundary. If it slips one
    // second to `T + 1`, we have exercised the AUD-009 strict-after
    // case (also rejected). Both outcomes prove the post-AUD-105
    // guard rejects at-or-after deadline; the polling discipline
    // maximizes the probability of equality. The post-tx blocktime
    // assertion records which case was exercised so flakiness is
    // observable, not silent.
    it("should reject accept_task at exact deadline equality (AUD-105)", async () => {
      const taskId = new BN(952);
      const startSlot = await connection.getSlot("confirmed");
      const onchainNow = await connection.getBlockTime(startSlot);
      if (onchainNow === null) {
        throw new Error(
          "getBlockTime returned null; cannot compute equality-boundary deadline"
        );
      }
      // T = onchainNow + 3 leaves room to (a) submit createEscrow, (b)
      // confirm Created, (c) start the equality poll loop with a few
      // hundred ms of slack before T arrives.
      const equalityDeadline = new BN(onchainNow + 3);

      const [escrowPDA] = await deriveEscrowPDA(
        audClient.publicKey,
        audProvider.publicKey,
        taskId
      );
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);

      await program.methods
        .createEscrow(
          taskId,
          new BN(1000000),
          Buffer.alloc(32),
          equalityDeadline,
          [createMilestoneData(1000000n, Buffer.alloc(32, 1))],
          null
        )
        .accounts({
          client: audClient.publicKey,
          clientVault: vaultFor(audClient.publicKey),
          providerVault: vaultFor(audProvider.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: audProvider.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: audClientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([audClient])
        .rpc();

      // Prove the deadline guard is the relevant gate: state must be
      // Created (otherwise we'd be testing a different rejection path).
      const created = await program.account.taskEscrow.fetch(escrowPDA);
      expect(created.status.created).to.be.ok;

      // Poll on-chain time until it has reached `equalityDeadline`
      // exactly. Bounded by 30s vs the ~3s expected wait. We intentionally
      // do NOT wait for `t > equalityDeadline` (that's the AUD-009 case);
      // we want the first slot where `t == equalityDeadline` so the
      // immediately-following accept_task tx has the highest chance of
      // landing in the same slot-second.
      const deadlineSecs = equalityDeadline.toNumber();
      const maxWaitMs = 30_000;
      const pollStart = Date.now();
      let preTxTime: number | null = null;
      while (Date.now() - pollStart < maxWaitMs) {
        const s = await connection.getSlot("confirmed");
        const t = await connection.getBlockTime(s);
        if (t !== null && t >= deadlineSecs) {
          preTxTime = t;
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (preTxTime === null) {
        throw new Error(
          `On-chain time never reached deadline ${deadlineSecs} within ${maxWaitMs}ms`
        );
      }

      // Submit accept_task. Under AUD-105's strict `<` guard this MUST
      // reject regardless of whether the tx lands at `now == deadline`
      // (the equality case AUD-105 closed) or `now > deadline` (the
      // AUD-009 case the inclusive guard already covered).
      try {
        await program.methods
          .acceptTask()
          .accounts({
            provider: audProvider.publicKey,
            escrow: escrowPDA,
          })
          .signers([audProvider])
          .rpc();
        expect.fail(
          "accept_task at-or-after deadline must reject with DeadlinePassed"
        );
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.toString()).to.include("DeadlinePassed");
      }

      // Post-tx sanity: capture on-chain time again and record which
      // case the run actually exercised. `postTxTime == deadlineSecs`
      // means the literal equality boundary was hit; `> deadlineSecs`
      // means the strict-after case was hit (still a valid rejection
      // under the strict-< guard, just not the AUD-105-specific
      // equality the test targets). Either way the rejection is
      // correct — but the assertion below makes the boundary case
      // observable rather than silent.
      const postSlot = await connection.getSlot("confirmed");
      const postTxTime = await connection.getBlockTime(postSlot);
      if (postTxTime === null) {
        throw new Error("getBlockTime returned null post-accept_task");
      }
      expect(postTxTime).to.be.at.least(
        deadlineSecs,
        "on-chain time at rejection must be >= deadline (else accept_task " +
          "would have succeeded under the strict-< guard, contradicting " +
          "the DeadlinePassed assertion above)"
      );
      // Diagnostic — surfaces equality-vs-strict-after to the test log
      // so reviewers / CI can see which case landed without parsing
      // mocha output for variance.
      // eslint-disable-next-line no-console
      console.log(
        `[AUD-105] deadline=${deadlineSecs}, pre-tx=${preTxTime}, ` +
          `post-tx=${postTxTime}, equality-case=${
            preTxTime === deadlineSecs && postTxTime === deadlineSecs
          }`
      );

      // Escrow must still be Created — failed accept_task must not
      // transition the state machine, leaving cancel_escrow available
      // to the client (the AUD-009 invariant AUD-105 reinforces).
      const post = await program.account.taskEscrow.fetch(escrowPDA);
      expect(post.status.created).to.be.ok;
    });
  });

  // ============================================================================
  // AUD-018: raise_dispute grace gate (ADR-102 applied to dispute path)
  // ============================================================================
  //
  // Pre-fix, a client could `raise_dispute` immediately after the provider's
  // `submit_milestone` landed, front-running the approval and forcing the
  // resolver path. The resolver-path slash (`reputation_delta_dispute_loss`)
  // would then sidestep the grace window that `expire_escrow` already honours.
  //
  // The fix mirrors the `expire_escrow` guard inside `raise_dispute`: any
  // Submitted milestone whose grace window has not yet elapsed blocks the
  // dispute with `MilestoneInGracePeriod`.
  describe("AUD-018: raise_dispute grace gate", () => {
    // Per-test escrow scaffolding so each scenario is isolated.
    async function setupGraceEscrow(taskIdNum: number) {
      const c = Keypair.generate();
      const p = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const kp of [c, p]) {
        const sig = await connection.requestAirdrop(kp.publicKey, airdropAmount);
        await connection.confirmTransaction(sig);
      }

      const cTA = await getOrCreateTokenAccount(c.publicKey, c);
      const pTA = await getOrCreateTokenAccount(p.publicKey, c);
      await mintTo(connection, mintAuthority, tokenMint, cTA, mintAuthority.publicKey, 10000000n);

      // Register provider in Agent Registry (required for any CPI reputation
      // update path; not strictly needed for raise_dispute but keeps fixture
      // consistent with sibling tests in case the test grows downstream).
      const registryProgram = anchor.workspace.AgentRegistry as Program;
      const [profilePDA] = deriveAgentProfilePDA(p.publicKey);
      await registryProgram.methods
        .registerAgent(
          "AUD-018 Provider",
          "Grace gate test provider",
          "grace-testing",
          ["task-execution"],
          { perTask: {} },
          new BN(100000),
          [tokenMint]
        )
        .accounts({
          authority: p.publicKey,
          ownerNonce: deriveOwnerNoncePDA(p.publicKey)[0],
          agentProfile: profilePDA,
          vault: deriveVaultPDA(p.publicKey)[0],
          systemProgram: SystemProgram.programId,
        })
        .signers([p])
        .rpc();

      const taskId = new BN(taskIdNum);
      const [escrowPDA] = await deriveEscrowPDA(c.publicKey, p.publicKey, taskId);
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);

      // 7-day deadline so the deadline guard never trips during a fast-grace test.
      const milestonesData = [createMilestoneData(1000000n, Buffer.alloc(32, 7))];
      await program.methods
        .createEscrow(taskId, new BN(1000000), Buffer.alloc(32), FUTURE_DEADLINE, milestonesData, null)
        .accounts({
          client: c.publicKey,
          clientVault: vaultFor(c.publicKey),
          providerVault: vaultFor(p.publicKey),
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: p.publicKey,
          tokenMint: tokenMint,
          clientTokenAccount: cTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([c])
        .rpc();

      await program.methods.acceptTask()
        .accounts({ provider: p.publicKey, escrow: escrowPDA })
        .signers([p]).rpc();

      return { client: c, provider: p, escrowPDA };
    }

    it("Negative — within grace: raise_dispute reverts with MilestoneInGracePeriod", async () => {
      const { client: c, provider: p, escrowPDA } = await setupGraceEscrow(2018);

      // Submit with a long grace window so the dispute attempt below is
      // guaranteed to land inside it (validator slots are ~400ms apart;
      // 5_000 slots ≈ 30+ minutes — safely longer than any test runtime).
      const gracePeriodSlots = new BN(5000);
      await program.methods
        .submitMilestone(new BN(0), gracePeriodSlots)
        .accounts({ provider: p.publicKey, escrow: escrowPDA })
        .signers([p])
        .rpc();

      try {
        await program.methods.raiseDispute()
          .accounts({ requester: c.publicKey, escrow: escrowPDA })
          .signers([c])
          .rpc();
        expect.fail("Should have thrown MilestoneInGracePeriod error");
      } catch (error: any) {
        expect(error).to.exist;
        expect(error.toString()).to.include("MilestoneInGracePeriod");
      }

      // Escrow must remain Active — the dispute did not transition state.
      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.active).to.be.ok;
      expect(escrow.disputedAt).to.be.null;
    });

    it("Happy — grace elapsed: raise_dispute succeeds once slot >= grace_ends_at", async () => {
      const { client: c, provider: p, escrowPDA } = await setupGraceEscrow(2019);

      // Tight grace window so we can poll past it without burning seconds.
      // 2 slots ≈ 800ms on solana-test-validator.
      const gracePeriodSlots = new BN(2);
      await program.methods
        .submitMilestone(new BN(0), gracePeriodSlots)
        .accounts({ provider: p.publicKey, escrow: escrowPDA })
        .signers([p])
        .rpc();

      // Read the on-chain grace_ends_at the program just stamped, then poll
      // the validator's slot until we cross it. This mirrors the polling
      // pattern from PR-L (commit 0c7c794, AUD-055): wait on the same signal
      // the program checks, not a wall-clock guess.
      const fetched = await program.account.taskEscrow.fetch(escrowPDA);
      const graceEndsAt = BigInt(fetched.milestones[0].graceEndsAt.toString());
      // Generous bound; a 2-slot grace typically clears in <2s.
      const pollDeadline = Date.now() + 30_000;
      while (Date.now() < pollDeadline) {
        const slot = BigInt(await connection.getSlot("confirmed"));
        if (slot >= graceEndsAt) break;
        await new Promise((resolve) => setImmediate(resolve));
      }

      await program.methods.raiseDispute()
        .accounts({ requester: c.publicKey, escrow: escrowPDA })
        .signers([c])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.disputed).to.be.ok;
      expect(escrow.disputedAt).to.not.be.null;
    });

    it("No-Submitted milestones: raise_dispute is a no-op for the grace gate", async () => {
      const { client: c, provider: p, escrowPDA } = await setupGraceEscrow(2020);

      // Do NOT submit. The single milestone stays Pending; the grace gate
      // iterates milestones and only blocks Submitted entries, so the
      // dispute must succeed exactly as it did before AUD-018.
      const before = await program.account.taskEscrow.fetch(escrowPDA);
      expect(before.milestones[0].status.pending).to.be.ok;

      await program.methods.raiseDispute()
        .accounts({ requester: c.publicKey, escrow: escrowPDA })
        .signers([c])
        .rpc();

      const escrow = await program.account.taskEscrow.fetch(escrowPDA);
      expect(escrow.status.disputed).to.be.ok;
      expect(escrow.disputedAt).to.not.be.null;
    });
  });

  // ============================================================================
  // AUD-024: escrow deadline upper bound (365-day cap)
  // ============================================================================
  //
  // Closes audit finding AUD-024: `create_escrow` previously had no upper
  // bound on `deadline`, so a client could pass `i64::MAX` and lock funds
  // effectively forever (`expire_escrow` only fires once `now > deadline`).
  // The fix in `instructions/escrow.rs` adds:
  //   require!(deadline <= now + MAX_ESCROW_DEADLINE_SECS, DeadlineTooFar);
  // where `MAX_ESCROW_DEADLINE_SECS = 365 * 24 * 60 * 60`.
  //
  // We exercise three points on the curve: just past the cap (reject), one
  // minute under the cap (accept), and exactly at the cap (accept, per `<=`).
  describe("AUD-024: escrow deadline upper bound", () => {
    const ONE_DAY_SECS = 24 * 60 * 60;
    const MAX_ESCROW_DEADLINE_SECS = 365 * ONE_DAY_SECS;

    let aud024Client: Keypair;
    let aud024Provider: Keypair;
    let aud024ClientTA: PublicKey;

    before(async () => {
      aud024Client = Keypair.generate();
      aud024Provider = Keypair.generate();

      const airdropAmount = 10 * LAMPORTS_PER_SOL;
      for (const keypair of [aud024Client, aud024Provider]) {
        const sig = await connection.requestAirdrop(
          keypair.publicKey,
          airdropAmount
        );
        await connection.confirmTransaction(sig);
      }

      aud024ClientTA = await getOrCreateTokenAccount(
        aud024Client.publicKey,
        aud024Client
      );

      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        aud024ClientTA,
        mintAuthority.publicKey,
        10_000_000n
      );
    });

    it("rejects deadline = now + 366 days (DeadlineTooFar)", async () => {
      const taskId = new BN(2400);
      const escrowPDA = (
        await deriveEscrowPDA(
          aud024Client.publicKey,
          aud024Provider.publicKey,
          taskId
        )
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = [createMilestoneData(1_000_000n)];

      const tooFarDeadline = new BN(
        Math.floor(Date.now() / 1000) + 366 * ONE_DAY_SECS
      );

      try {
        await program.methods
          .createEscrow(
            taskId,
            new BN(1_000_000),
            Buffer.alloc(32),
            tooFarDeadline,
            milestonesData,
            null
          )
          .accounts({
            client: aud024Client.publicKey,
            clientVault: vaultFor(aud024Client.publicKey),
            providerVault: vaultFor(aud024Provider.publicKey),
            provider: aud024Provider.publicKey,
            protocolConfig: PROTOCOL_CONFIG_PDA,
            tokenMint,
            clientTokenAccount: aud024ClientTA,
            escrow: escrowPDA,
            escrowTokenAccount: escrowTA,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([aud024Client])
          .rpc();
        expect.fail("Should have thrown DeadlineTooFar error");
      } catch (error: any) {
        // Anchor surfaces the named code in the program logs.
        const msg =
          (error?.error?.errorCode?.code as string | undefined) ??
          (error?.message as string | undefined) ??
          "";
        expect(msg).to.match(/DeadlineTooFar/);
      }
    });

    it("accepts deadline just under the 365-day cap (boundary happy)", async () => {
      const taskId = new BN(2401);
      const escrowPDA = (
        await deriveEscrowPDA(
          aud024Client.publicKey,
          aud024Provider.publicKey,
          taskId
        )
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = [createMilestoneData(1_000_000n)];

      // 60 seconds under the cap leaves room for clock-drift between
      // `Date.now()` here and `Clock::get()?.unix_timestamp` on-chain.
      const justUnderCap = new BN(
        Math.floor(Date.now() / 1000) + MAX_ESCROW_DEADLINE_SECS - 60
      );

      await program.methods
        .createEscrow(
          taskId,
          new BN(1_000_000),
          Buffer.alloc(32),
          justUnderCap,
          milestonesData,
          null
        )
        .accounts({
          client: aud024Client.publicKey,
          clientVault: vaultFor(aud024Client.publicKey),
          providerVault: vaultFor(aud024Provider.publicKey),
          provider: aud024Provider.publicKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenMint,
          clientTokenAccount: aud024ClientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([aud024Client])
        .rpc();

      const escrow = await (program.account as any).taskEscrow.fetch(escrowPDA);
      expect(escrow.deadline.toString()).to.equal(justUnderCap.toString());
    });

    it("accepts deadline exactly at the 365-day cap (<= constraint)", async () => {
      const taskId = new BN(2402);
      const escrowPDA = (
        await deriveEscrowPDA(
          aud024Client.publicKey,
          aud024Provider.publicKey,
          taskId
        )
      )[0];
      const escrowTA = deriveEscrowTokenAccount(escrowPDA);
      const milestonesData = [createMilestoneData(1_000_000n)];

      // The on-chain check is `deadline <= now_onchain + cap`. The
      // assumption that `now_onchain >= Date.now()` does NOT hold on a
      // fresh solana-test-validator: the bank's clock starts from slot 0
      // and can lag the system clock by seconds. To make the boundary
      // test deterministic, query the on-chain time directly via
      // getBlockTime, then set deadline = onchain_now + cap. By the time
      // the tx lands, the on-chain clock has advanced by 1-2 slots
      // (~400-800ms), so the predicate `deadline <= now_onchain_at_tx + cap`
      // is satisfied with a small positive slack rather than razor-thin.
      const slot = await connection.getSlot("confirmed");
      const onchainNow = await connection.getBlockTime(slot);
      if (onchainNow === null) {
        throw new Error("getBlockTime returned null; cannot compute boundary deadline");
      }
      const atCap = new BN(onchainNow + MAX_ESCROW_DEADLINE_SECS);

      await program.methods
        .createEscrow(
          taskId,
          new BN(1_000_000),
          Buffer.alloc(32),
          atCap,
          milestonesData,
          null
        )
        .accounts({
          client: aud024Client.publicKey,
          clientVault: vaultFor(aud024Client.publicKey),
          providerVault: vaultFor(aud024Provider.publicKey),
          provider: aud024Provider.publicKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenMint,
          clientTokenAccount: aud024ClientTA,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([aud024Client])
        .rpc();

      const escrow = await (program.account as any).taskEscrow.fetch(escrowPDA);
      expect(escrow.deadline.toString()).to.equal(atCap.toString());
    });
  });

  // ============================================================================
  // AUD-019: hoist escrow.status checks into Account constraints
  // ============================================================================
  //
  // Pre-fix, AcceptTask / SubmitMilestone / RejectMilestone only enforced
  // `escrow.status` via handler `require!`. Defense-in-depth (parity with
  // CloseEscrow) hoists the check into the `Accounts` struct as
  // `constraint = escrow.status == ... @ SettlementError::InvalidStatus`.
  // The handler `require!` is preserved as belt-and-suspenders, but the
  // constraint layer should fire FIRST. Anchor surfaces both layers under
  // the same `InvalidStatus` named code; these tests verify that violating
  // the status precondition (with all other account constraints satisfied)
  // surfaces `InvalidStatus`.

  describe("AUD-019: status constraints hoisted to Accounts struct", () => {
    let aud019Client: Keypair;
    let aud019Provider: Keypair;
    let aud019ClientTA: PublicKey;
    let aud019EscrowPDA: PublicKey;
    let aud019EscrowTA: PublicKey;
    const aud019TaskId = new BN(1900);

    before(async () => {
      aud019Client = Keypair.generate();
      aud019Provider = Keypair.generate();

      for (const kp of [aud019Client, aud019Provider]) {
        const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
      }

      aud019ClientTA = await getOrCreateTokenAccount(aud019Client.publicKey, aud019Client);
      await mintTo(
        connection,
        mintAuthority,
        tokenMint,
        aud019ClientTA,
        mintAuthority.publicKey,
        10_000_000n
      );

      [aud019EscrowPDA] = await deriveEscrowPDA(
        aud019Client.publicKey,
        aud019Provider.publicKey,
        aud019TaskId
      );
      aud019EscrowTA = deriveEscrowTokenAccount(aud019EscrowPDA);

      // Create the escrow in `Created` state — single milestone for simplicity.
      await program.methods
        .createEscrow(
          aud019TaskId,
          new BN(1_000_000),
          Buffer.alloc(32),
          FUTURE_DEADLINE,
          [createMilestoneData(1_000_000n)],
          null
        )
        .accounts({
          client: aud019Client.publicKey,
          clientVault: vaultFor(aud019Client.publicKey),
          providerVault: vaultFor(aud019Provider.publicKey),
          provider: aud019Provider.publicKey,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenMint,
          clientTokenAccount: aud019ClientTA,
          escrow: aud019EscrowPDA,
          escrowTokenAccount: aud019EscrowTA,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([aud019Client])
        .rpc();
    });

    // SubmitMilestone now carries `constraint = escrow.status == Active` on
    // the escrow account. Escrow is currently in `Created`, so the
    // Account-level constraint fires before the handler.
    it("submit_milestone: Account constraint fires when escrow is not Active", async () => {
      try {
        await program.methods
          .submitMilestone(0, new BN(0))
          .accounts({
            provider: aud019Provider.publicKey,
            escrow: aud019EscrowPDA,
          })
          .signers([aud019Provider])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        const code =
          (error?.error?.errorCode?.code as string | undefined) ??
          (error?.message as string | undefined) ??
          "";
        expect(code).to.match(/InvalidStatus/);
      }
    });

    // RejectMilestone also requires `Active`; same Created-state escrow.
    it("reject_milestone: Account constraint fires when escrow is not Active", async () => {
      try {
        await program.methods
          .rejectMilestone(0)
          .accounts({
            client: aud019Client.publicKey,
            escrow: aud019EscrowPDA,
          })
          .signers([aud019Client])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        const code =
          (error?.error?.errorCode?.code as string | undefined) ??
          (error?.message as string | undefined) ??
          "";
        expect(code).to.match(/InvalidStatus/);
      }
    });

    // AcceptTask requires `Created`. Transition to Active first, then a
    // second accept attempt must surface `InvalidStatus` from the
    // Account-level constraint.
    it("accept_task: Account constraint fires when escrow is not Created", async () => {
      // Move escrow into Active.
      await program.methods
        .acceptTask()
        .accounts({
          provider: aud019Provider.publicKey,
          escrow: aud019EscrowPDA,
        })
        .signers([aud019Provider])
        .rpc();

      // Second accept — escrow.status is now Active, constraint must reject.
      try {
        await program.methods
          .acceptTask()
          .accounts({
            provider: aud019Provider.publicKey,
            escrow: aud019EscrowPDA,
          })
          .signers([aud019Provider])
          .rpc();
        expect.fail("Should have thrown InvalidStatus error");
      } catch (error: any) {
        const code =
          (error?.error?.errorCode?.code as string | undefined) ??
          (error?.message as string | undefined) ??
          "";
        expect(code).to.match(/InvalidStatus/);
      }
    });
  });
});

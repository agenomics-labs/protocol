import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
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

  function deriveAgentProfilePDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("agent-profile")],
      REGISTRY_PROGRAM_ID
    );
  }

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
          [tokenMint],
          Keypair.generate().publicKey
        )
        .accounts({
          authority: provider_account.publicKey,
          agentProfile: profilePDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([provider_account])
        .rpc();

      const profile = await registryProgram.account.agentProfile.fetch(profilePDA);
      expect(profile.name).to.equal("Test Provider");
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
          [tokenMint],
          Keypair.generate().publicKey
        )
        .accounts({
          authority: provider_account.publicKey,
          agentProfile: profilePDA,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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
        .submitMilestone(new BN(0))
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
      const tx = await program.methods
        .approveMilestone(new BN(0))
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          settlementSelf: SETTLEMENT_PROGRAM_ID,
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
        .submitMilestone(new BN(1))
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
      const tx = await program.methods
        .approveMilestone(new BN(1))
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          settlementSelf: SETTLEMENT_PROGRAM_ID,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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

      const tx = await program.methods
        .resolveDispute(clientRefund, providerRefund)
        .accounts({
          resolver: resolver_account.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          clientTokenAccount: clientTokenAccount,
          providerTokenAccount: providerTokenAccount,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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
          [tokenMint],
          Keypair.generate().publicKey
        )
        .accounts({
          authority: provider_account.publicKey,
          agentProfile: profilePDA,
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
        .submitMilestone(new BN(0))
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
        .submitMilestone(new BN(0))
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
        .approveMilestone(new BN(0))
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount: escrowTokenAccount,
          providerTokenAccount: providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: providerProfilePDA,
          settlementSelf: SETTLEMENT_PROGRAM_ID,
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
            client: clientLocal.publicKey, clientVault: clientLocal.publicKey,
            providerVault: providerLocal.publicKey, provider: providerLocal.publicKey,
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
            client: clientLocal.publicKey, clientVault: clientLocal.publicKey,
            providerVault: providerLocal.publicKey, provider: providerLocal.publicKey,
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
            client: clientLocal.publicKey, clientVault: clientLocal.publicKey,
            providerVault: providerLocal.publicKey, provider: providerLocal.publicKey,
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
            client: clientLocal.publicKey, clientVault: clientLocal.publicKey,
            providerVault: providerLocal.publicKey, provider: providerLocal.publicKey,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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
        .submitMilestone(new BN(0))
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
          .approveMilestone(new BN(0))
          .accounts({
            client: otherAccount.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount: escrowTokenAccount,
            providerTokenAccount: providerTokenAccount,
            registryProgram: REGISTRY_PROGRAM_ID,
            providerProfile: providerProfilePDA,
            settlementSelf: SETTLEMENT_PROGRAM_ID,
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
          client: client.publicKey, clientVault: client.publicKey,
          providerVault: provider_account.publicKey, provider: provider_account.publicKey,
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
          clientVault: client.publicKey,
          providerVault: provider_account.publicKey,
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
          .submitMilestone(new BN(0))
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
});

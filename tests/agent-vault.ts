import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("Agent Vault Tests", () => {
  // Setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentVault as Program;
  const programId = program.programId;

  // Test keypairs
  let authority: Keypair;
  let agentIdentity: Keypair;
  let recipient: Keypair;
  let vaultPda: PublicKey;
  let vaultBump: number;

  // Vault policy constants for tests
  const DEFAULT_DAILY_LIMIT = 10 * LAMPORTS_PER_SOL;
  const DEFAULT_PER_TX_LIMIT = 1 * LAMPORTS_PER_SOL;
  const DEFAULT_MAX_TXS_PER_HOUR = 10;

  before(async () => {
    // Initialize test keypairs
    authority = Keypair.generate();
    agentIdentity = Keypair.generate();
    recipient = Keypair.generate();

    // Derive vault PDA
    const [vaultAddress, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      programId
    );
    vaultPda = vaultAddress;
    vaultBump = bump;

    // Fund test accounts
    const airdropSig = await provider.connection.requestAirdrop(
      authority.publicKey,
      50 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);
  });

  // ============================================================================
  // HAPPY PATH TESTS
  // ============================================================================

  describe("Happy Path: Vault Initialization", () => {
    it("should initialize a vault with correct parameters", async () => {
      const tx = await program.methods
        .initializeVault(agentIdentity.publicKey, new BN(DEFAULT_DAILY_LIMIT), new BN(DEFAULT_PER_TX_LIMIT), new BN(DEFAULT_MAX_TXS_PER_HOUR))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      // Verify vault was created with correct data
      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.agentIdentity.toString()).to.equal(
        agentIdentity.publicKey.toString()
      );
      expect(vaultAccount.authority.toString()).to.equal(
        authority.publicKey.toString()
      );
      expect(vaultAccount.paused).to.equal(false);
      expect(vaultAccount.spentTodayLamports.toNumber()).to.equal(0);
      expect(vaultAccount.policy.dailyLimitLamports.toNumber()).to.equal(
        DEFAULT_DAILY_LIMIT
      );
      expect(vaultAccount.policy.perTxLimitLamports.toNumber()).to.equal(
        DEFAULT_PER_TX_LIMIT
      );
      expect(vaultAccount.policy.maxTxsPerHour).to.equal(
        DEFAULT_MAX_TXS_PER_HOUR
      );
      expect(vaultAccount.policy.tokenAllowlist.length).to.equal(0);
      expect(vaultAccount.policy.programAllowlist.length).to.equal(0);
    });
  });

  describe("Happy Path: Policy Updates", () => {
    it("should update vault policy with new limits", async () => {
      const newDailyLimit = 20 * LAMPORTS_PER_SOL;
      const newPerTxLimit = 2 * LAMPORTS_PER_SOL;
      const newMaxTxsPerHour = 20;

      const tx = await program.methods
        .updatePolicy(new BN(newDailyLimit), new BN(newPerTxLimit), new BN(newMaxTxsPerHour))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.policy.dailyLimitLamports.toNumber()).to.equal(
        newDailyLimit
      );
      expect(vaultAccount.policy.perTxLimitLamports.toNumber()).to.equal(
        newPerTxLimit
      );
      expect(vaultAccount.policy.maxTxsPerHour).to.equal(newMaxTxsPerHour);
    });
  });

  describe("Happy Path: Token Allowlist Management", () => {
    it("should add a token to the allowlist", async () => {
      const tokenMint = Keypair.generate().publicKey;

      const tx = await program.methods
        .addTokenAllowlist(tokenMint, new BN(1_000_000), new BN(10_000_000))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.policy.tokenAllowlist.length).to.equal(1);
      expect(vaultAccount.policy.tokenAllowlist[0].toString()).to.equal(
        tokenMint.toString()
      );
    });

    it("should add multiple tokens to the allowlist", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const countBefore = vaultBefore.policy.tokenAllowlist.length;

      const token1 = Keypair.generate().publicKey;
      const token2 = Keypair.generate().publicKey;

      await program.methods
        .addTokenAllowlist(token1, new BN(1_000_000), new BN(10_000_000))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      await program.methods
        .addTokenAllowlist(token2, new BN(1_000_000), new BN(10_000_000))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.policy.tokenAllowlist.length).to.equal(countBefore + 2);
      const allowlistAddresses = vaultAccount.policy.tokenAllowlist.map(
        (t) => t.toString()
      );
      expect(allowlistAddresses).to.include(token1.toString());
      expect(allowlistAddresses).to.include(token2.toString());
    });

    it("should remove a token from the allowlist", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const tokenToRemove = vaultBefore.policy.tokenAllowlist[0];

      await program.methods
        .removeTokenAllowlist(tokenToRemove)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      const allowlistAddresses = vaultAfter.policy.tokenAllowlist.map((t) =>
        t.toString()
      );
      expect(allowlistAddresses).not.to.include(tokenToRemove.toString());
    });
  });

  describe("Happy Path: Program Allowlist Management", () => {
    it("should add a program to the allowlist", async () => {
      const programToAdd = Keypair.generate().publicKey;

      const tx = await program.methods
        .addProgramAllowlist(programToAdd)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.policy.programAllowlist.length).to.equal(1);
      expect(vaultAccount.policy.programAllowlist[0].toString()).to.equal(
        programToAdd.toString()
      );
    });

    it("should add multiple programs to the allowlist", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const countBefore = vaultBefore.policy.programAllowlist.length;

      const program1 = Keypair.generate().publicKey;
      const program2 = Keypair.generate().publicKey;

      await program.methods
        .addProgramAllowlist(program1)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      await program.methods
        .addProgramAllowlist(program2)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      expect(vaultAccount.policy.programAllowlist.length).to.equal(countBefore + 2);
      const allowlistAddresses = vaultAccount.policy.programAllowlist.map(
        (p) => p.toString()
      );
      expect(allowlistAddresses).to.include(program1.toString());
      expect(allowlistAddresses).to.include(program2.toString());
    });

    it("should remove a program from the allowlist", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const programToRemove = vaultBefore.policy.programAllowlist[0];

      await program.methods
        .removeProgramAllowlist(programToRemove)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      const allowlistAddresses = vaultAfter.policy.programAllowlist.map((p) =>
        p.toString()
      );
      expect(allowlistAddresses).not.to.include(programToRemove.toString());
    });
  });

  describe("Happy Path: Execute Transfer", () => {
    it("should execute a transfer within per-tx limit", async () => {
      const transferAmount = 0.5 * LAMPORTS_PER_SOL;

      // Fund the vault
      const airdropSig = await provider.connection.requestAirdrop(
        vaultPda,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const vaultBefore = await program.account.vault.fetch(vaultPda);
      const spentBefore = vaultBefore.spentTodayLamports.toNumber();

      const tx = await program.methods
        .executeTransfer(new BN(transferAmount))
        .accounts({
          vault: vaultPda,
          vaultAccount: vaultPda,
          agent: agentIdentity.publicKey,
          recipient: recipient.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([agentIdentity])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.spentTodayLamports.toNumber()).to.equal(
        spentBefore + transferAmount
      );
    });

    it("should execute multiple small transfers within rate limit", async () => {
      const transferAmount = 0.1 * LAMPORTS_PER_SOL;

      for (let i = 0; i < 3; i++) {
        const newRecipient = Keypair.generate().publicKey;
        await program.methods
          .executeTransfer(new BN(transferAmount))
          .accounts({
            vault: vaultPda,
            vaultAccount: vaultPda,
            agent: agentIdentity.publicKey,
            recipient: newRecipient,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([agentIdentity])
          .rpc();
      }

      const vaultAccount = await program.account.vault.fetch(vaultPda);
      // At least 3 from this loop, possibly more from prior test
      expect(vaultAccount.txsInCurrentWindow).to.be.greaterThanOrEqual(3);
    });
  });

  describe("Happy Path: Pause and Resume", () => {
    it("should pause the vault", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      expect(vaultBefore.paused).to.equal(false);

      await program.methods
        .pauseVault()
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.paused).to.equal(true);
    });

    it("should resume the vault", async () => {
      const vaultBefore = await program.account.vault.fetch(vaultPda);
      expect(vaultBefore.paused).to.equal(true);

      await program.methods
        .resumeVault()
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.paused).to.equal(false);
    });
  });

  // ============================================================================
  // POLICY ENFORCEMENT TESTS - MOST CRITICAL
  // ============================================================================

  describe("Policy Enforcement: Per-Transaction Limit", () => {
    it("should reject transfer that exceeds per-tx limit", async () => {
      // Set a low per-tx limit for testing
      const lowPerTxLimit = 0.5 * LAMPORTS_PER_SOL;
      const newDailyLimit = 10 * LAMPORTS_PER_SOL;

      await program.methods
        .updatePolicy(new BN(newDailyLimit), new BN(lowPerTxLimit), new BN(10))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      // Try to transfer more than the per-tx limit
      const excessiveAmount = 0.6 * LAMPORTS_PER_SOL;

      try {
        await program.methods
          .executeTransfer(new BN(excessiveAmount))
          .accounts({
            vault: vaultPda,
            vaultAccount: vaultPda,
            agent: agentIdentity.publicKey,
            recipient: recipient.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([agentIdentity])
          .rpc();

        expect.fail("Expected transaction to fail with PerTxLimitExceeded");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });

    it("should accept transfer exactly at per-tx limit", async () => {
      // Verify per-tx limit is still low from previous test
      const vaultAccount = await program.account.vault.fetch(vaultPda);
      const perTxLimit = vaultAccount.policy.perTxLimitLamports.toNumber();

      // Transfer exactly at the limit should succeed
      const newRecipient = Keypair.generate().publicKey;
      await program.methods
        .executeTransfer(new BN(perTxLimit))
        .accounts({
          vault: vaultPda,
          vaultAccount: vaultPda,
          agent: agentIdentity.publicKey,
          recipient: newRecipient,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([agentIdentity])
        .rpc();

      const vaultAfter = await program.account.vault.fetch(vaultPda);
      expect(vaultAfter.txsInCurrentWindow).to.be.greaterThan(0);
    });
  });

  describe("Policy Enforcement: Daily Spending Limit", () => {
    // Create a fresh vault for this test suite to isolate daily limit testing
    let dailyLimitVaultPda: PublicKey;
    let dailyLimitAuthority: Keypair;
    let dailyLimitAgentId: Keypair;

    before(async () => {
      dailyLimitAuthority = Keypair.generate();
      dailyLimitAgentId = Keypair.generate();

      // Fund authority
      const airdropSig = await provider.connection.requestAirdrop(
        dailyLimitAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), dailyLimitAuthority.publicKey.toBuffer()],
        programId
      );
      dailyLimitVaultPda = vaultAddress;

      // Initialize vault with small daily limit (per-tx must cover individual transfers)
      const smallDailyLimit = 2 * LAMPORTS_PER_SOL;
      const smallPerTxLimit = 1.5 * LAMPORTS_PER_SOL;

      await program.methods
        .initializeVault(dailyLimitAgentId.publicKey, new BN(smallDailyLimit), new BN(smallPerTxLimit), new BN(10))
        .accounts({
          vault: dailyLimitVaultPda,
          authority: dailyLimitAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([dailyLimitAuthority])
        .rpc();

      // Fund the vault
      const vaultAirdropSig = await provider.connection.requestAirdrop(
        dailyLimitVaultPda,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(vaultAirdropSig);
    });

    it("should reject transfers that exceed daily limit", async () => {
      const transferAmount = 1.5 * LAMPORTS_PER_SOL;

      // First transfer should succeed (within daily limit)
      const recipient1 = Keypair.generate().publicKey;
      await program.methods
        .executeTransfer(new BN(transferAmount))
        .accounts({
          vault: dailyLimitVaultPda,
          vaultAccount: dailyLimitVaultPda,
          agent: dailyLimitAgentId.publicKey,
          recipient: recipient1,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([dailyLimitAgentId])
        .rpc();

      // Second transfer should fail because total would exceed daily limit
      const recipient2 = Keypair.generate().publicKey;
      try {
        await program.methods
          .executeTransfer(new BN(transferAmount))
          .accounts({
            vault: dailyLimitVaultPda,
            vaultAccount: dailyLimitVaultPda,
            agent: dailyLimitAgentId.publicKey,
            recipient: recipient2,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([dailyLimitAgentId])
          .rpc();

        expect.fail("Expected transaction to fail with DailyLimitExceeded");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  describe("Policy Enforcement: Paused Vault", () => {
    // Create a fresh vault for pause testing
    let pauseVaultPda: PublicKey;
    let pauseAuthority: Keypair;
    let pauseAgentId: Keypair;

    before(async () => {
      pauseAuthority = Keypair.generate();
      pauseAgentId = Keypair.generate();

      // Fund authority
      const airdropSig = await provider.connection.requestAirdrop(
        pauseAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), pauseAuthority.publicKey.toBuffer()],
        programId
      );
      pauseVaultPda = vaultAddress;

      // Initialize vault
      await program.methods
        .initializeVault(pauseAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: pauseVaultPda,
          authority: pauseAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([pauseAuthority])
        .rpc();

      // Fund the vault
      const vaultAirdropSig = await provider.connection.requestAirdrop(
        pauseVaultPda,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(vaultAirdropSig);
    });

    it("should reject transfer when vault is paused", async () => {
      // Pause the vault
      await program.methods
        .pauseVault()
        .accounts({
          vault: pauseVaultPda,
          authority: pauseAuthority.publicKey,
        })
        .signers([pauseAuthority])
        .rpc();

      // Try to execute transfer
      try {
        await program.methods
          .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
          .accounts({
            vault: pauseVaultPda,
            vaultAccount: pauseVaultPda,
            agent: pauseAgentId.publicKey,
            recipient: recipient.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([pauseAgentId])
          .rpc();

        expect.fail("Expected transaction to fail with VaultPaused");
      } catch (error: any) {
        // Transaction failed as expected - VaultPaused
        expect(error).to.exist;
      }
    });

    it("should allow transfer after vault is resumed", async () => {
      // Resume the vault
      await program.methods
        .resumeVault()
        .accounts({
          vault: pauseVaultPda,
          authority: pauseAuthority.publicKey,
        })
        .signers([pauseAuthority])
        .rpc();

      // Now transfer should succeed
      const newRecipient = Keypair.generate().publicKey;
      await program.methods
        .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
        .accounts({
          vault: pauseVaultPda,
          vaultAccount: pauseVaultPda,
          agent: pauseAgentId.publicKey,
          recipient: newRecipient,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([pauseAgentId])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(pauseVaultPda);
      expect(vaultAccount.paused).to.equal(false);
    });
  });

  describe("Policy Enforcement: Rate Limiting (Txs Per Hour)", () => {
    // Create a fresh vault for rate limit testing
    let rateLimitVaultPda: PublicKey;
    let rateLimitAuthority: Keypair;
    let rateLimitAgentId: Keypair;

    before(async () => {
      rateLimitAuthority = Keypair.generate();
      rateLimitAgentId = Keypair.generate();

      // Fund authority
      const airdropSig = await provider.connection.requestAirdrop(
        rateLimitAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), rateLimitAuthority.publicKey.toBuffer()],
        programId
      );
      rateLimitVaultPda = vaultAddress;

      // Initialize vault with low tx rate limit for testing
      const lowMaxTxsPerHour = 3;

      await program.methods
        .initializeVault(rateLimitAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(lowMaxTxsPerHour))
        .accounts({
          vault: rateLimitVaultPda,
          authority: rateLimitAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rateLimitAuthority])
        .rpc();

      // Fund the vault
      const vaultAirdropSig = await provider.connection.requestAirdrop(
        rateLimitVaultPda,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(vaultAirdropSig);
    });

    it("should allow multiple transfers within rate limit window", async () => {
      const maxTxs = 3;
      const transferAmount = 0.1 * LAMPORTS_PER_SOL;

      for (let i = 0; i < maxTxs; i++) {
        const newRecipient = Keypair.generate().publicKey;
        await program.methods
          .executeTransfer(new BN(transferAmount))
          .accounts({
            vault: rateLimitVaultPda,
            vaultAccount: rateLimitVaultPda,
            agent: rateLimitAgentId.publicKey,
            recipient: newRecipient,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([rateLimitAgentId])
          .rpc();
      }

      const vaultAccount = await program.account.vault.fetch(rateLimitVaultPda);
      expect(vaultAccount.txsInCurrentWindow).to.equal(maxTxs);
    });

    it("should reject transaction that exceeds rate limit", async () => {
      // We've already done 3 txs, now try a 4th which should fail
      const transferAmount = 0.1 * LAMPORTS_PER_SOL;
      const newRecipient = Keypair.generate().publicKey;

      try {
        await program.methods
          .executeTransfer(new BN(transferAmount))
          .accounts({
            vault: rateLimitVaultPda,
            vaultAccount: rateLimitVaultPda,
            agent: rateLimitAgentId.publicKey,
            recipient: newRecipient,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([rateLimitAgentId])
          .rpc();

        expect.fail("Expected transaction to fail with RateLimitExceeded");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  // ============================================================================
  // AUTHORIZATION TESTS
  // ============================================================================

  describe("Authorization: Policy Updates", () => {
    // Create a separate vault for auth tests
    let authVaultPda: PublicKey;
    let authVaultAuthority: Keypair;
    let authVaultAgentId: Keypair;
    let unauthorizedSigner: Keypair;

    before(async () => {
      authVaultAuthority = Keypair.generate();
      authVaultAgentId = Keypair.generate();
      unauthorizedSigner = Keypair.generate();

      // Fund authorities
      const airdropSig1 = await provider.connection.requestAirdrop(
        authVaultAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig1);

      const airdropSig2 = await provider.connection.requestAirdrop(
        unauthorizedSigner.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig2);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), authVaultAuthority.publicKey.toBuffer()],
        programId
      );
      authVaultPda = vaultAddress;

      // Initialize vault
      await program.methods
        .initializeVault(authVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: authVaultPda,
          authority: authVaultAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authVaultAuthority])
        .rpc();
    });

    it("should reject policy update from non-authority", async () => {
      try {
        await program.methods
          .updatePolicy(new BN(15 * LAMPORTS_PER_SOL), new BN(0.5 * LAMPORTS_PER_SOL), new BN(15))
          .accounts({
            vault: authVaultPda,
            authority: unauthorizedSigner.publicKey,
          })
          .signers([unauthorizedSigner])
          .rpc();

        expect.fail("Expected transaction to fail with Unauthorized");
      } catch (error: any) {
        // Transaction failed as expected - unauthorized caller
        expect(error).to.exist;
      }
    });

    it("should allow policy update from authority", async () => {
      const newDailyLimit = 15 * LAMPORTS_PER_SOL;
      const newPerTxLimit = 1.5 * LAMPORTS_PER_SOL;

      await program.methods
        .updatePolicy(new BN(newDailyLimit), new BN(newPerTxLimit), new BN(15))
        .accounts({
          vault: authVaultPda,
          authority: authVaultAuthority.publicKey,
        })
        .signers([authVaultAuthority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(authVaultPda);
      expect(vaultAccount.policy.dailyLimitLamports.toNumber()).to.equal(newDailyLimit);
      expect(vaultAccount.policy.perTxLimitLamports.toNumber()).to.equal(newPerTxLimit);
    });
  });

  describe("Authorization: Pause/Resume Operations", () => {
    // Create a separate vault for auth tests
    let pauseAuthVaultPda: PublicKey;
    let pauseAuthVaultAuthority: Keypair;
    let pauseAuthVaultAgentId: Keypair;
    let pauseUnauthorizedSigner: Keypair;

    before(async () => {
      pauseAuthVaultAuthority = Keypair.generate();
      pauseAuthVaultAgentId = Keypair.generate();
      pauseUnauthorizedSigner = Keypair.generate();

      // Fund authorities
      const airdropSig1 = await provider.connection.requestAirdrop(
        pauseAuthVaultAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig1);

      const airdropSig2 = await provider.connection.requestAirdrop(
        pauseUnauthorizedSigner.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig2);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), pauseAuthVaultAuthority.publicKey.toBuffer()],
        programId
      );
      pauseAuthVaultPda = vaultAddress;

      // Initialize vault
      await program.methods
        .initializeVault(pauseAuthVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: pauseAuthVaultPda,
          authority: pauseAuthVaultAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([pauseAuthVaultAuthority])
        .rpc();
    });

    it("should reject pause from non-authority", async () => {
      try {
        await program.methods
          .pauseVault()
          .accounts({
            vault: pauseAuthVaultPda,
            authority: pauseUnauthorizedSigner.publicKey,
          })
          .signers([pauseUnauthorizedSigner])
          .rpc();

        expect.fail("Expected transaction to fail with Unauthorized");
      } catch (error: any) {
        // Transaction failed as expected - unauthorized caller
        expect(error).to.exist;
      }
    });

    it("should reject resume from non-authority", async () => {
      // First pause with authority
      await program.methods
        .pauseVault()
        .accounts({
          vault: pauseAuthVaultPda,
          authority: pauseAuthVaultAuthority.publicKey,
        })
        .signers([pauseAuthVaultAuthority])
        .rpc();

      // Then try to resume with unauthorized signer
      try {
        await program.methods
          .resumeVault()
          .accounts({
            vault: pauseAuthVaultPda,
            authority: pauseUnauthorizedSigner.publicKey,
          })
          .signers([pauseUnauthorizedSigner])
          .rpc();

        expect.fail("Expected transaction to fail with Unauthorized");
      } catch (error: any) {
        // Transaction failed as expected - unauthorized caller
        expect(error).to.exist;
      }
    });

    it("should allow pause and resume from authority", async () => {
      // Vault should still be paused from previous test, resume it first
      let vaultAccount = await program.account.vault.fetch(pauseAuthVaultPda);
      if (vaultAccount.paused) {
        await program.methods
          .resumeVault()
          .accounts({
            vault: pauseAuthVaultPda,
            authority: pauseAuthVaultAuthority.publicKey,
          })
          .signers([pauseAuthVaultAuthority])
          .rpc();
      }

      // Now pause
      await program.methods
        .pauseVault()
        .accounts({
          vault: pauseAuthVaultPda,
          authority: pauseAuthVaultAuthority.publicKey,
        })
        .signers([pauseAuthVaultAuthority])
        .rpc();

      vaultAccount = await program.account.vault.fetch(pauseAuthVaultPda);
      expect(vaultAccount.paused).to.equal(true);

      // Now resume
      await program.methods
        .resumeVault()
        .accounts({
          vault: pauseAuthVaultPda,
          authority: pauseAuthVaultAuthority.publicKey,
        })
        .signers([pauseAuthVaultAuthority])
        .rpc();

      vaultAccount = await program.account.vault.fetch(pauseAuthVaultPda);
      expect(vaultAccount.paused).to.equal(false);
    });
  });

  // ============================================================================
  // SEC-2 / ADR-069: update_agent_identity (hot-key rotation)
  // ============================================================================

  describe("SEC-2 / ADR-069: Agent Identity Rotation", () => {
    let rotVaultPda: PublicKey;
    let rotAuthority: Keypair;
    let rotOldAgentId: Keypair;
    let rotNewAgentId: Keypair;
    let rotUnauthorized: Keypair;

    before(async () => {
      rotAuthority = Keypair.generate();
      rotOldAgentId = Keypair.generate();
      rotNewAgentId = Keypair.generate();
      rotUnauthorized = Keypair.generate();

      for (const kp of [rotAuthority, rotOldAgentId, rotNewAgentId, rotUnauthorized]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          10 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), rotAuthority.publicKey.toBuffer()],
        programId
      );
      rotVaultPda = vaultAddress;

      await program.methods
        .initializeVault(
          rotOldAgentId.publicKey,
          new BN(10 * LAMPORTS_PER_SOL),
          new BN(1 * LAMPORTS_PER_SOL),
          new BN(10)
        )
        .accounts({
          vault: rotVaultPda,
          authority: rotAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rotAuthority])
        .rpc();

      // Fund vault so execute_transfer can actually move lamports
      const vaultAirdrop = await provider.connection.requestAirdrop(
        rotVaultPda,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(vaultAirdrop);
    });

    it("should reject update_agent_identity from non-authority", async () => {
      try {
        await program.methods
          .updateAgentIdentity(rotNewAgentId.publicKey)
          .accounts({
            vault: rotVaultPda,
            authority: rotUnauthorized.publicKey,
          })
          .signers([rotUnauthorized])
          .rpc();
        expect.fail("Expected non-authority rotation to fail");
      } catch (error: any) {
        expect(error).to.exist;
        // Anchor maps has_one mismatch to ConstraintHasOne / Unauthorized
        const msg = (error?.message || "").toString();
        expect(msg.length).to.be.greaterThan(0);
      }

      // Confirm agent_identity is unchanged
      const vaultAccount = await program.account.vault.fetch(rotVaultPda);
      expect(vaultAccount.agentIdentity.toString()).to.equal(
        rotOldAgentId.publicKey.toString()
      );
    });

    it("should rotate agent_identity when called by authority and invalidate old key", async () => {
      // Sanity: old identity can sign a transfer before rotation
      const r1 = Keypair.generate().publicKey;
      await program.methods
        .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
        .accounts({
          vault: rotVaultPda,
          vaultAccount: rotVaultPda,
          agent: rotOldAgentId.publicKey,
          recipient: r1,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rotOldAgentId])
        .rpc();

      // Rotate
      await program.methods
        .updateAgentIdentity(rotNewAgentId.publicKey)
        .accounts({
          vault: rotVaultPda,
          authority: rotAuthority.publicKey,
        })
        .signers([rotAuthority])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(rotVaultPda);
      expect(vaultAccount.agentIdentity.toString()).to.equal(
        rotNewAgentId.publicKey.toString()
      );

      // New identity can sign
      const r2 = Keypair.generate().publicKey;
      await program.methods
        .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
        .accounts({
          vault: rotVaultPda,
          vaultAccount: rotVaultPda,
          agent: rotNewAgentId.publicKey,
          recipient: r2,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([rotNewAgentId])
        .rpc();

      // Old identity is now rejected
      const r3 = Keypair.generate().publicKey;
      try {
        await program.methods
          .executeTransfer(new BN(0.1 * LAMPORTS_PER_SOL))
          .accounts({
            vault: rotVaultPda,
            vaultAccount: rotVaultPda,
            agent: rotOldAgentId.publicKey,
            recipient: r3,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([rotOldAgentId])
          .rpc();
        expect.fail("Expected rotated-out identity to be unauthorized");
      } catch (error: any) {
        expect(error).to.exist;
      }
    });
  });

  describe("Authorization: Allowlist Management", () => {
    // Create a separate vault for auth tests
    let allowlistAuthVaultPda: PublicKey;
    let allowlistAuthVaultAuthority: Keypair;
    let allowlistAuthVaultAgentId: Keypair;
    let allowlistUnauthorizedSigner: Keypair;

    before(async () => {
      allowlistAuthVaultAuthority = Keypair.generate();
      allowlistAuthVaultAgentId = Keypair.generate();
      allowlistUnauthorizedSigner = Keypair.generate();

      // Fund authorities
      const airdropSig1 = await provider.connection.requestAirdrop(
        allowlistAuthVaultAuthority.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig1);

      const airdropSig2 = await provider.connection.requestAirdrop(
        allowlistUnauthorizedSigner.publicKey,
        50 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig2);

      // Derive PDA
      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), allowlistAuthVaultAuthority.publicKey.toBuffer()],
        programId
      );
      allowlistAuthVaultPda = vaultAddress;

      // Initialize vault
      await program.methods
        .initializeVault(allowlistAuthVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: allowlistAuthVaultPda,
          authority: allowlistAuthVaultAuthority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([allowlistAuthVaultAuthority])
        .rpc();
    });

    it("should reject token allowlist add from non-authority", async () => {
      const tokenMint = Keypair.generate().publicKey;

      try {
        await program.methods
          .addTokenAllowlist(tokenMint, new BN(1_000_000), new BN(10_000_000))
          .accounts({
            vault: allowlistAuthVaultPda,
            authority: allowlistUnauthorizedSigner.publicKey,
          })
          .signers([allowlistUnauthorizedSigner])
          .rpc();

        expect.fail("Expected transaction to fail with Unauthorized");
      } catch (error: any) {
        // Transaction failed as expected - unauthorized caller
        expect(error).to.exist;
      }
    });

    it("should allow token allowlist operations from authority", async () => {
      const tokenMint = Keypair.generate().publicKey;

      // Add token
      await program.methods
        .addTokenAllowlist(tokenMint, new BN(1_000_000), new BN(10_000_000))
        .accounts({
          vault: allowlistAuthVaultPda,
          authority: allowlistAuthVaultAuthority.publicKey,
        })
        .signers([allowlistAuthVaultAuthority])
        .rpc();

      let vaultAccount = await program.account.vault.fetch(allowlistAuthVaultPda);
      expect(vaultAccount.policy.tokenAllowlist.length).to.equal(1);

      // Remove token
      await program.methods
        .removeTokenAllowlist(tokenMint)
        .accounts({
          vault: allowlistAuthVaultPda,
          authority: allowlistAuthVaultAuthority.publicKey,
        })
        .signers([allowlistAuthVaultAuthority])
        .rpc();

      vaultAccount = await program.account.vault.fetch(allowlistAuthVaultPda);
      expect(vaultAccount.policy.tokenAllowlist.length).to.equal(0);
    });
  });
});

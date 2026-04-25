import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Agent Vault Tests", () => {
  // Setup
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentVault as Program;
  const programId = program.programId;

  // ADR-095: agent_profile from the registry is required by execute_transfer /
  // execute_token_transfer for the cross-program suspension check.
  const registryProgram = anchor.workspace.AgentRegistry as Program;

  // ADR-097: owner-nonce PDA `[authority, b"owner-nonce"]` in the registry
  // program. Needed for every `register_agent` call in test setup.
  function deriveOwnerNoncePDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("owner-nonce")],
      registryProgram.programId
    );
  }

  // ADR-097: agent_profile PDA seeds = [authority, b"agent-profile", nonce-le].
  function deriveAgentProfilePDA(
    authority: PublicKey,
    nonce: bigint = 0n
  ): [PublicKey, number] {
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(nonce);
    return PublicKey.findProgramAddressSync(
      [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
      registryProgram.programId
    );
  }

  // Test-harness helper: register a minimal agent profile under `authority`
  // so ADR-095's suspension gate on execute_transfer has a valid account to
  // deserialize. Returns the profile PDA.
  //
  // AUD-008 (PR-J): MUST be called BEFORE `initializeVault` for any
  // `authority`. The vault context now requires the Registry's `OwnerNonce`
  // PDA to already exist — this helper creates it as a side-effect of
  // `registerAgent` (Registry uses `init_if_needed` on the nonce account).
  async function registerMinimalAgent(
    authority: Keypair,
    vaultPda: PublicKey
  ): Promise<PublicKey> {
    const [profilePda] = deriveAgentProfilePDA(authority.publicKey);
    const [noncePda] = deriveOwnerNoncePDA(authority.publicKey);
    await registryProgram.methods
      .registerAgent(
        "t",
        "t",
        "t",
        ["t"],
        { perTask: {} },
        new BN(0),
        [new PublicKey("11111111111111111111111111111112")]
      )
      .accounts({
        authority: authority.publicKey,
        ownerNonce: noncePda,
        agentProfile: profilePda,
        vault: vaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    return profilePda;
  }

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
      // AUD-008 (PR-J): register-first. The vault context now requires the
      // Registry's `OwnerNonce` PDA to exist before init.
      await registerMinimalAgent(authority, vaultPda);

      const tx = await program.methods
        .initializeVault(agentIdentity.publicKey, new BN(DEFAULT_DAILY_LIMIT), new BN(DEFAULT_PER_TX_LIMIT), new BN(DEFAULT_MAX_TXS_PER_HOUR))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(authority.publicKey)[0],
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

      // AUD-008 (PR-J): verify vault.profile_nonce was sourced from the
      // Registry's OwnerNonce — the only on-chain link between the vault
      // and the agent profile for the suspension gate (ADR-095).
      const noncePda = deriveOwnerNoncePDA(authority.publicKey)[0];
      const ownerNonce: any = await (registryProgram.account as any).ownerNonce.fetch(noncePda);
      expect(vaultAccount.profileNonce.toString()).to.equal(
        ownerNonce.nonce.toString()
      );
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
          agent: agentIdentity.publicKey,
          authority: authority.publicKey,
          agentProfile: deriveAgentProfilePDA(authority.publicKey)[0],
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
            agent: agentIdentity.publicKey,
            authority: authority.publicKey,
            agentProfile: deriveAgentProfilePDA(authority.publicKey)[0],
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
            agent: agentIdentity.publicKey,
            authority: authority.publicKey,
            agentProfile: deriveAgentProfilePDA(authority.publicKey)[0],
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
          agent: agentIdentity.publicKey,
          authority: authority.publicKey,
          agentProfile: deriveAgentProfilePDA(authority.publicKey)[0],
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

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(dailyLimitAuthority, dailyLimitVaultPda);
      await program.methods
        .initializeVault(dailyLimitAgentId.publicKey, new BN(smallDailyLimit), new BN(smallPerTxLimit), new BN(10))
        .accounts({
          vault: dailyLimitVaultPda,
          authority: dailyLimitAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(dailyLimitAuthority.publicKey)[0],
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
          agent: dailyLimitAgentId.publicKey,
          authority: dailyLimitAuthority.publicKey,
          agentProfile: deriveAgentProfilePDA(dailyLimitAuthority.publicKey)[0],
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
            agent: dailyLimitAgentId.publicKey,
            authority: dailyLimitAuthority.publicKey,
            agentProfile: deriveAgentProfilePDA(dailyLimitAuthority.publicKey)[0],
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

      // Initialize vault — AUD-008 (PR-J): register-first.
      await registerMinimalAgent(pauseAuthority, pauseVaultPda);
      await program.methods
        .initializeVault(pauseAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: pauseVaultPda,
          authority: pauseAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(pauseAuthority.publicKey)[0],
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
            agent: pauseAgentId.publicKey,
            authority: pauseAuthority.publicKey,
            agentProfile: deriveAgentProfilePDA(pauseAuthority.publicKey)[0],
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
          agent: pauseAgentId.publicKey,
          authority: pauseAuthority.publicKey,
          agentProfile: deriveAgentProfilePDA(pauseAuthority.publicKey)[0],
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

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(rateLimitAuthority, rateLimitVaultPda);
      await program.methods
        .initializeVault(rateLimitAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(lowMaxTxsPerHour))
        .accounts({
          vault: rateLimitVaultPda,
          authority: rateLimitAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(rateLimitAuthority.publicKey)[0],
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
            agent: rateLimitAgentId.publicKey,
            authority: rateLimitAuthority.publicKey,
            agentProfile: deriveAgentProfilePDA(rateLimitAuthority.publicKey)[0],
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
            agent: rateLimitAgentId.publicKey,
            authority: rateLimitAuthority.publicKey,
            agentProfile: deriveAgentProfilePDA(rateLimitAuthority.publicKey)[0],
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

      // Initialize vault — AUD-008 (PR-J): register-first.
      await registerMinimalAgent(authVaultAuthority, authVaultPda);
      await program.methods
        .initializeVault(authVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: authVaultPda,
          authority: authVaultAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(authVaultAuthority.publicKey)[0],
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

      // Initialize vault — AUD-008 (PR-J): register-first.
      await registerMinimalAgent(pauseAuthVaultAuthority, pauseAuthVaultPda);
      await program.methods
        .initializeVault(pauseAuthVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: pauseAuthVaultPda,
          authority: pauseAuthVaultAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(pauseAuthVaultAuthority.publicKey)[0],
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
  // SEC-5 / ADR-071: Token rate-limit ordering (validate BEFORE increment)
  // ============================================================================

  describe("SEC-5 / ADR-071: Token Rate-Limit Ordering", () => {
    let sec5VaultPda: PublicKey;
    let sec5Authority: Keypair;
    let sec5AgentId: Keypair;
    let sec5Payer: Keypair;
    let configuredMint: PublicKey;
    let vaultAtaConfigured: PublicKey;
    let recipientAtaConfigured: PublicKey;

    before(async () => {
      sec5Authority = Keypair.generate();
      sec5AgentId = Keypair.generate();
      sec5Payer = Keypair.generate();

      for (const kp of [sec5Authority, sec5Payer]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          20 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), sec5Authority.publicKey.toBuffer()],
        programId
      );
      sec5VaultPda = vaultAddress;

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(sec5Authority, sec5VaultPda);
      await program.methods
        .initializeVault(
          sec5AgentId.publicKey,
          new BN(10 * LAMPORTS_PER_SOL),
          new BN(1 * LAMPORTS_PER_SOL),
          new BN(5)
        )
        .accounts({
          vault: sec5VaultPda,
          authority: sec5Authority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(sec5Authority.publicKey)[0],
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([sec5Authority])
        .rpc();

      configuredMint = await createMint(
        provider.connection,
        sec5Payer,
        sec5Payer.publicKey,
        null,
        6
      );

      const vaultAtaAcc = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec5Payer,
        configuredMint,
        sec5VaultPda,
        true // allowOwnerOffCurve — vault PDA is program-owned
      );
      vaultAtaConfigured = vaultAtaAcc.address;

      await mintTo(
        provider.connection,
        sec5Payer,
        configuredMint,
        vaultAtaConfigured,
        sec5Payer.publicKey,
        1_000_000n
      );

      const recipientOwner = Keypair.generate();
      const recAcc = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec5Payer,
        configuredMint,
        recipientOwner.publicKey
      );
      recipientAtaConfigured = recAcc.address;

      // Allowlist + configure the good mint. add_token_allowlist both
      // inserts into policy.token_allowlist AND creates a TokenSpendRecord.
      await program.methods
        .addTokenAllowlist(configuredMint, new BN(500_000), new BN(1_000_000))
        .accounts({
          vault: sec5VaultPda,
          authority: sec5Authority.publicKey,
        })
        .signers([sec5Authority])
        .rpc();
    });

    it("should NOT burn rate-limit bucket on TokenNotConfigured failure", async () => {
      // Core SEC-5 / ADR-071 invariant: a tx that fails validation must not
      // increment `txs_in_current_window`. We exercise the TokenNotConfigured
      // branch by using a fresh vault with an EMPTY allowlist (default
      // "all tokens allowed" per state.rs:110-114) plus a mint that was never
      // run through add_token_allowlist — so the allowlist check passes but
      // the TokenSpendRecord lookup must fail.
      //
      // Pre-ADR-071 ordering incremented the rate-limit counter between the
      // allowlist check and the record lookup; post-fix, no counter touch
      // happens before the record lookup so the state is pristine.
      const emptyAuth = Keypair.generate();
      const emptyAgent = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        emptyAuth.publicKey,
        20 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [emptyVaultPda] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), emptyAuth.publicKey.toBuffer()],
        programId
      );

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(emptyAuth, emptyVaultPda);
      await program.methods
        .initializeVault(
          emptyAgent.publicKey,
          new BN(10 * LAMPORTS_PER_SOL),
          new BN(1 * LAMPORTS_PER_SOL),
          new BN(5)
        )
        .accounts({
          vault: emptyVaultPda,
          authority: emptyAuth.publicKey,
          ownerNonce: deriveOwnerNoncePDA(emptyAuth.publicKey)[0],
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([emptyAuth])
        .rpc();

      const badMint = await createMint(
        provider.connection,
        sec5Payer,
        sec5Payer.publicKey,
        null,
        6
      );
      const emptyVaultAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec5Payer,
        badMint,
        emptyVaultPda,
        true
      );
      await mintTo(
        provider.connection,
        sec5Payer,
        badMint,
        emptyVaultAta.address,
        sec5Payer.publicKey,
        1_000_000n
      );
      const badRecipientOwner = Keypair.generate();
      const badRecipientAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec5Payer,
        badMint,
        badRecipientOwner.publicKey
      );

      const before = await program.account.vault.fetch(emptyVaultPda);
      const txsBefore = before.txsInCurrentWindow;

      let threw = false;
      try {
        await program.methods
          .executeTokenTransfer(new BN(100))
          .accounts({
            vault: emptyVaultPda,
            agent: emptyAgent.publicKey,
            authority: emptyAuth.publicKey,
            agentProfile: deriveAgentProfilePDA(emptyAuth.publicKey)[0],
            vaultTokenAccount: emptyVaultAta.address,
            recipientTokenAccount: badRecipientAta.address,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([emptyAgent])
          .rpc();
      } catch (error: any) {
        threw = true;
        expect(error).to.exist;
      }
      expect(threw, "bad-mint token transfer must fail").to.equal(true);

      const after = await program.account.vault.fetch(emptyVaultPda);
      expect(after.txsInCurrentWindow).to.equal(
        txsBefore,
        "txs_in_current_window must not change when execute_token_transfer fails validation"
      );
    });

    it("should still increment rate-limit bucket on a successful transfer (positive control)", async () => {
      const before = await program.account.vault.fetch(sec5VaultPda);
      const txsBefore = before.txsInCurrentWindow;

      await program.methods
        .executeTokenTransfer(new BN(100))
        .accounts({
          vault: sec5VaultPda,
          agent: sec5AgentId.publicKey,
          authority: sec5Authority.publicKey,
          agentProfile: deriveAgentProfilePDA(sec5Authority.publicKey)[0],
          vaultTokenAccount: vaultAtaConfigured,
          recipientTokenAccount: recipientAtaConfigured,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sec5AgentId])
        .rpc();

      const after = await program.account.vault.fetch(sec5VaultPda);
      expect(after.txsInCurrentWindow).to.equal(txsBefore + 1);
    });
  });

  // ============================================================================
  // SEC-6 / ADR-072: Recipient guards (self-transfer DoS mitigation)
  // ============================================================================

  describe("SEC-6 / ADR-072: Recipient Guards", () => {
    let sec6VaultPda: PublicKey;
    let sec6Authority: Keypair;
    let sec6AgentId: Keypair;
    let sec6Payer: Keypair;
    let sec6Mint: PublicKey;
    let sec6VaultAta: PublicKey;
    let sec6ExternalRecipientAta: PublicKey;
    let sec6SecondVaultOwnedAta: PublicKey;

    before(async () => {
      sec6Authority = Keypair.generate();
      sec6AgentId = Keypair.generate();
      sec6Payer = Keypair.generate();

      for (const kp of [sec6Authority, sec6Payer]) {
        const sig = await provider.connection.requestAirdrop(
          kp.publicKey,
          20 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(sig);
      }

      const [vaultAddress] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), sec6Authority.publicKey.toBuffer()],
        programId
      );
      sec6VaultPda = vaultAddress;

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(sec6Authority, sec6VaultPda);
      await program.methods
        .initializeVault(
          sec6AgentId.publicKey,
          new BN(10 * LAMPORTS_PER_SOL),
          new BN(1 * LAMPORTS_PER_SOL),
          new BN(10)
        )
        .accounts({
          vault: sec6VaultPda,
          authority: sec6Authority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(sec6Authority.publicKey)[0],
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([sec6Authority])
        .rpc();

      sec6Mint = await createMint(
        provider.connection,
        sec6Payer,
        sec6Payer.publicKey,
        null,
        6
      );

      // Vault's own ATA (owned by the vault PDA).
      const vaultAtaAcc = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec6Payer,
        sec6Mint,
        sec6VaultPda,
        true
      );
      sec6VaultAta = vaultAtaAcc.address;
      await mintTo(
        provider.connection,
        sec6Payer,
        sec6Mint,
        sec6VaultAta,
        sec6Payer.publicKey,
        1_000_000n
      );

      // A SECOND token account also owned by the vault PDA — used to exercise
      // the "recipient.owner == vault" branch of the SEC-6 guard. We can't
      // have two ATAs for the same mint+owner, so we create a non-ATA token
      // account owned by the vault PDA via direct SPL instructions. For the
      // purpose of this test, using any account whose owner == vault suffices.
      // The easiest reproducible path: the vault's own ATA IS an account
      // whose owner is vault, so passing it as recipient exercises BOTH the
      // self-account and self-owner constraints simultaneously.
      sec6SecondVaultOwnedAta = sec6VaultAta;

      // A legitimate external recipient ATA.
      const recipientOwner = Keypair.generate();
      const recAcc = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        sec6Payer,
        sec6Mint,
        recipientOwner.publicKey
      );
      sec6ExternalRecipientAta = recAcc.address;

      // Allowlist + configure the mint.
      await program.methods
        .addTokenAllowlist(sec6Mint, new BN(500_000), new BN(1_000_000))
        .accounts({
          vault: sec6VaultPda,
          authority: sec6Authority.publicKey,
        })
        .signers([sec6Authority])
        .rpc();
    });

    it("should reject self-transfer where recipient_token_account == vault_token_account", async () => {
      const before = await program.account.vault.fetch(sec6VaultPda);
      const txsBefore = before.txsInCurrentWindow;

      let threw = false;
      try {
        await program.methods
          .executeTokenTransfer(new BN(100))
          .accounts({
            vault: sec6VaultPda,
            agent: sec6AgentId.publicKey,
            authority: sec6Authority.publicKey,
            agentProfile: deriveAgentProfilePDA(sec6Authority.publicKey)[0],
            vaultTokenAccount: sec6VaultAta,
            recipientTokenAccount: sec6VaultAta, // <-- self-transfer
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([sec6AgentId])
          .rpc();
      } catch (error: any) {
        threw = true;
        expect(error).to.exist;
        // Anchor maps the constraint @ mapping to the named VaultError.
        // Don't pin the exact message (fragile across Anchor versions) — just
        // confirm the tx rejected and no state advanced.
      }
      expect(threw, "self-transfer to same token account must be rejected").to.equal(true);

      const after = await program.account.vault.fetch(sec6VaultPda);
      expect(after.txsInCurrentWindow).to.equal(
        txsBefore,
        "rejected self-transfer must not advance rate-limit window"
      );
    });

    it("should accept an external-recipient transfer (positive control)", async () => {
      await program.methods
        .executeTokenTransfer(new BN(100))
        .accounts({
          vault: sec6VaultPda,
          agent: sec6AgentId.publicKey,
          authority: sec6Authority.publicKey,
          agentProfile: deriveAgentProfilePDA(sec6Authority.publicKey)[0],
          vaultTokenAccount: sec6VaultAta,
          recipientTokenAccount: sec6ExternalRecipientAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sec6AgentId])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(sec6VaultPda);
      expect(vaultAccount.txsInCurrentWindow).to.be.greaterThan(0);
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

      // AUD-008 (PR-J): register-first.
      await registerMinimalAgent(rotAuthority, rotVaultPda);
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
          ownerNonce: deriveOwnerNoncePDA(rotAuthority.publicKey)[0],
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
          agent: rotOldAgentId.publicKey,
          authority: rotAuthority.publicKey,
          agentProfile: deriveAgentProfilePDA(rotAuthority.publicKey)[0],
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
          agent: rotNewAgentId.publicKey,
          authority: rotAuthority.publicKey,
          agentProfile: deriveAgentProfilePDA(rotAuthority.publicKey)[0],
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
            agent: rotOldAgentId.publicKey,
            authority: rotAuthority.publicKey,
            agentProfile: deriveAgentProfilePDA(rotAuthority.publicKey)[0],
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

    // PR-X / AUD-023: After the rotation in the previous test consumed
    // today's 24h slot, an immediate second rotation must revert with
    // `RotationRateLimited`. The boundary case (rotate, wait 24h+,
    // rotate again succeeds) is covered by the Rust unit tests
    // `rotation_exact_24h_boundary_allowed` and
    // `rotation_two_rotations_one_day_apart_both_succeed` in lib.rs —
    // bank-clock advancement of 24h+ on a localnet is impractical here.
    it("should reject immediate re-rotation within 24h with RotationRateLimited (PR-X / AUD-023)", async () => {
      // The previous test successfully rotated to rotNewAgentId, so the
      // vault's `last_rotation_at` is now within the last few seconds.
      const yetAnotherAgentId = Keypair.generate();

      // Sanity: vault really did rotate and `last_rotation_at` is set.
      const before = await program.account.vault.fetch(rotVaultPda);
      expect(before.agentIdentity.toString()).to.equal(
        rotNewAgentId.publicKey.toString()
      );
      expect((before.lastRotationAt as BN).toNumber()).to.be.greaterThan(0);

      try {
        await program.methods
          .updateAgentIdentity(yetAnotherAgentId.publicKey)
          .accounts({
            vault: rotVaultPda,
            authority: rotAuthority.publicKey,
          })
          .signers([rotAuthority])
          .rpc();
        expect.fail("Expected immediate re-rotation to be rate-limited");
      } catch (error: any) {
        // Anchor surfaces VaultError::RotationRateLimited as either
        // an AnchorError with the matching name, or a generic error
        // whose message contains the error name. Accept either shape
        // so we are not coupled to anchor's exact mapping.
        const msg = (error?.message || "").toString();
        const isAnchorErr = error instanceof AnchorError;
        const errorName: string = isAnchorErr
          ? error.error?.errorCode?.code ?? ""
          : "";
        expect(
          errorName === "RotationRateLimited" ||
            msg.includes("RotationRateLimited") ||
            msg.includes("rate-limited"),
          `expected RotationRateLimited, got: ${msg}`
        ).to.equal(true);
      }

      // State must be unchanged — checks-effects-interactions guarantees
      // the rejected rotation does not mutate `agent_identity` or
      // `last_rotation_at`.
      const after = await program.account.vault.fetch(rotVaultPda);
      expect(after.agentIdentity.toString()).to.equal(
        rotNewAgentId.publicKey.toString()
      );
      expect((after.lastRotationAt as BN).toString()).to.equal(
        (before.lastRotationAt as BN).toString()
      );
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

      // Initialize vault — AUD-008 (PR-J): register-first.
      await registerMinimalAgent(allowlistAuthVaultAuthority, allowlistAuthVaultPda);
      await program.methods
        .initializeVault(allowlistAuthVaultAgentId.publicKey, new BN(10 * LAMPORTS_PER_SOL), new BN(1 * LAMPORTS_PER_SOL), new BN(10))
        .accounts({
          vault: allowlistAuthVaultPda,
          authority: allowlistAuthVaultAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(allowlistAuthVaultAuthority.publicKey)[0],
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

  // ============================================================================
  // AUD-008 / PR-J: register-first vault initialization
  // ============================================================================
  //
  // The vault context now requires the Registry's `OwnerNonce` PDA at
  // `initialize_vault` time, replacing the user-supplied `profile_nonce: u64`
  // argument. The seeds constraint enforces both existence and binding to
  // the calling `authority`, closing AUD-008's brick-via-wrong-nonce hole.
  // See `docs/audits/DESIGN-DECISIONS-2026-04-25.md` AUD-008 for rationale.
  describe("AUD-008 / PR-J: Register-first OwnerNonce Sourcing", () => {
    it("happy path: vault.profile_nonce equals OwnerNonce.nonce on chain", async () => {
      const a = Keypair.generate();
      const aId = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        a.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [aVaultPda] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), a.publicKey.toBuffer()],
        programId
      );

      // Register first — initializes the OwnerNonce PDA in Registry.
      await registerMinimalAgent(a, aVaultPda);

      const [aNoncePda] = deriveOwnerNoncePDA(a.publicKey);
      const beforeNonce: any = await (registryProgram.account as any).ownerNonce.fetch(aNoncePda);

      await program.methods
        .initializeVault(
          aId.publicKey,
          new BN(LAMPORTS_PER_SOL),
          new BN(LAMPORTS_PER_SOL / 10),
          new BN(10)
        )
        .accounts({
          vault: aVaultPda,
          authority: a.publicKey,
          ownerNonce: aNoncePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([a])
        .rpc();

      const vaultAccount = await program.account.vault.fetch(aVaultPda);
      expect(vaultAccount.profileNonce.toString()).to.equal(
        beforeNonce.nonce.toString()
      );
    });

    it("rejects vault init when authority has not registered (OwnerNonce missing)", async () => {
      const noReg = Keypair.generate();
      const noRegId = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        noReg.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      const [noRegVaultPda] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), noReg.publicKey.toBuffer()],
        programId
      );
      const [noRegNoncePda] = deriveOwnerNoncePDA(noReg.publicKey);

      // Sanity: OwnerNonce PDA does NOT exist on chain.
      const acc = await provider.connection.getAccountInfo(noRegNoncePda);
      expect(acc).to.be.null;

      let threw = false;
      try {
        await program.methods
          .initializeVault(
            noRegId.publicKey,
            new BN(LAMPORTS_PER_SOL),
            new BN(LAMPORTS_PER_SOL / 10),
            new BN(10)
          )
          .accounts({
            vault: noRegVaultPda,
            authority: noReg.publicKey,
            ownerNonce: noRegNoncePda,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([noReg])
          .rpc();
      } catch (error: any) {
        threw = true;
        // Anchor raises AccountNotInitialized (or similar) when the PDA
        // backing a non-init account constraint has no on-chain data.
        // Don't pin the exact error code — message stability across Anchor
        // versions is fragile. Just confirm the tx rejected.
        expect(error).to.exist;
      }
      expect(threw, "vault init must fail when OwnerNonce is missing").to.equal(true);

      // Confirm the vault PDA was NOT created.
      const vaultAcc = await provider.connection.getAccountInfo(noRegVaultPda);
      expect(vaultAcc).to.be.null;
    });

    it("rejects vault init when caller passes another authority's OwnerNonce", async () => {
      // Alice registers; Bob attempts vault init using Alice's OwnerNonce
      // PDA in his accounts struct. The seeds derivation under Bob's
      // authority cannot produce Alice's OwnerNonce address, so Anchor
      // raises a seeds-constraint failure.
      const alice = Keypair.generate();
      const bob = Keypair.generate();
      const bobAgentId = Keypair.generate();

      for (const kp of [alice, bob]) {
        const s = await provider.connection.requestAirdrop(
          kp.publicKey,
          5 * LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(s);
      }

      const [aliceVaultPda] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), alice.publicKey.toBuffer()],
        programId
      );
      await registerMinimalAgent(alice, aliceVaultPda);
      const [aliceNoncePda] = deriveOwnerNoncePDA(alice.publicKey);

      const [bobVaultPda] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("vault"), bob.publicKey.toBuffer()],
        programId
      );

      let threw = false;
      try {
        await program.methods
          .initializeVault(
            bobAgentId.publicKey,
            new BN(LAMPORTS_PER_SOL),
            new BN(LAMPORTS_PER_SOL / 10),
            new BN(10)
          )
          .accounts({
            vault: bobVaultPda,
            authority: bob.publicKey,
            ownerNonce: aliceNoncePda, // <-- Alice's nonce account
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([bob])
          .rpc();
      } catch (error: any) {
        threw = true;
        expect(error).to.exist;
      }
      expect(threw, "cross-authority OwnerNonce reuse must be rejected").to.equal(true);

      const bobVaultAcc = await provider.connection.getAccountInfo(bobVaultPda);
      expect(bobVaultAcc).to.be.null;
    });
  });
});

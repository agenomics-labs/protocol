import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import { expect } from "chai";

const program = anchor.workspace.AgentRegistry as Program;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// PDA seed constants
const AGENT_PROFILE_SEED = "agent-profile";
const OWNER_NONCE_SEED = "owner-nonce";

// Finding #9: Canonical Agent Vault program ID; `register_agent` now
// validates `AgentProfile.vault_address` matches the PDA derived from
// `[b"vault", authority]` under this program. No more caller-supplied
// impostor vault addresses.
const VAULT_PROGRAM_ID = new web3.PublicKey(
  "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
);

// ADR-097: owner-nonce PDA `[authority, b"owner-nonce"]`. Init_if_needed'd
// by `register_agent`; its `.nonce` field feeds the agent_profile PDA seed.
function deriveOwnerNoncePDA(authority: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from(OWNER_NONCE_SEED)],
    program.programId
  );
}

// ADR-097: agent_profile PDA seeds = [authority, b"agent-profile", nonce-le].
// For fresh authorities nonce is 0; for tests that deregister + re-register
// pass the incremented value explicitly.
function deriveAgentProfilePDA(
  authority: web3.PublicKey,
  nonce: bigint = 0n
): [web3.PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return web3.PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from(AGENT_PROFILE_SEED), nonceBuf],
    program.programId
  );
}

// Finding #9: canonical vault PDA helper for registry tests.
function deriveVaultPDA(authority: web3.PublicKey): [web3.PublicKey, number] {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    VAULT_PROGRAM_ID
  );
}
const vaultFor = (pk: web3.PublicKey) => deriveVaultPDA(pk)[0];

describe("Agent Registry Program Tests", () => {
  // Test accounts
  let agentAuthority: web3.Keypair;
  let otherUser: web3.Keypair;
  let agentProfilePDA: web3.PublicKey;
  let agentProfileBump: number;

  // Test data
  const testAgentName = "AI Data Analyst";
  const testDescription = "Specialized in data analysis and visualization with machine learning expertise";
  const testCategory = "data-analysis";
  const testCapabilities = ["data-cleaning", "statistical-analysis", "visualization"];
  const testPricingAmount = web3.LAMPORTS_PER_SOL;
  // Finding #9: computed post-keypair-generation in `before()` — must match
  // the canonical vault PDA for the happy-path authority.
  let testVaultAddress: web3.PublicKey;

  before(async () => {
    // Generate test keypairs
    agentAuthority = web3.Keypair.generate();
    otherUser = web3.Keypair.generate();

    // Derive PDAs
    [agentProfilePDA, agentProfileBump] = deriveAgentProfilePDA(agentAuthority.publicKey);
    testVaultAddress = vaultFor(agentAuthority.publicKey);

    // Airdrop SOL to test accounts
    const airdropAmount = 2 * web3.LAMPORTS_PER_SOL;
    const agentSig = await provider.connection.requestAirdrop(agentAuthority.publicKey, airdropAmount);
    const otherSig = await provider.connection.requestAirdrop(otherUser.publicKey, airdropAmount);

    await provider.connection.confirmTransaction(agentSig);
    await provider.connection.confirmTransaction(otherSig);
  });

  describe("register_agent - Happy Path", () => {
    it("should register an agent with valid parameters", async () => {
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      const tx = await program.methods
        .registerAgent(
          testAgentName,
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, // PricingModel::PerTask
          new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
          vault: testVaultAddress,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([agentAuthority])
        .rpc();

      // Verify account was created
      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);

      expect(agentProfile.authority.toString()).to.equal(agentAuthority.publicKey.toString());
      expect(agentProfile.name).to.equal(testAgentName);
      expect(agentProfile.description).to.equal(testDescription);
      expect(agentProfile.category).to.equal(testCategory);
      expect(agentProfile.capabilities).to.deep.equal(testCapabilities);
      expect(agentProfile.pricingModel).to.have.property("perTask");
      expect(agentProfile.pricingAmount.toString()).to.equal(testPricingAmount.toString());
      expect(agentProfile.acceptedTokens.length).to.equal(1);
      expect(agentProfile.vaultAddress.toString()).to.equal(testVaultAddress.toString());
      expect(agentProfile.status).to.have.property("active");
      expect(agentProfile.reputationScore.toNumber()).to.equal(0);
      expect(agentProfile.totalTasksCompleted.toNumber()).to.equal(0);
      expect(agentProfile.totalEarnings.toNumber()).to.equal(0);
      expect(agentProfile.avgRating).to.equal(0);
      expect(agentProfile.bump).to.equal(agentProfileBump);
      expect(agentProfile.createdAt.toNumber()).to.be.greaterThan(0);
      expect(agentProfile.updatedAt.toNumber()).to.be.greaterThan(0);
    });

    it("should verify all stored fields match input exactly", async () => {
      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);

      expect(agentProfile.name).to.have.lengthOf(testAgentName.length);
      expect(agentProfile.description).to.have.lengthOf(testDescription.length);
      expect(agentProfile.capabilities.length).to.equal(testCapabilities.length);

      for (let i = 0; i < testCapabilities.length; i++) {
        expect(agentProfile.capabilities[i]).to.equal(testCapabilities[i]);
      }
    });

    it("should initialize timestamps correctly", async () => {
      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      const currentTime = Math.floor(Date.now() / 1000);

      expect(agentProfile.createdAt.toNumber()).to.be.closeTo(currentTime, 5);
      expect(agentProfile.updatedAt.toNumber()).to.be.closeTo(currentTime, 5);
      expect(agentProfile.createdAt.toNumber()).to.equal(agentProfile.updatedAt.toNumber());
    });

    // Finding #9: vault_address must be the canonical PDA
    // `[b"vault", authority]` under the Agent Vault program. Supplying any
    // other pubkey is rejected by Anchor's seeds constraint at
    // deserialization — long before any instruction handler runs.
    it("should reject register_agent if vault is not the canonical vault PDA", async () => {
      const mismatchAuthority = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        mismatchAuthority.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      const [mismatchProfilePDA] = deriveAgentProfilePDA(mismatchAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      // Use the vault PDA of an UNRELATED authority — the seeds constraint
      // binds vault seeds to *this* authority, so the runtime must reject it.
      const impostorVault = vaultFor(web3.Keypair.generate().publicKey);

      try {
        await program.methods
          .registerAgent(
            "Impostor",
            testDescription,
            testCategory,
            testCapabilities,
            { perTask: {} },
            new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: mismatchAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(mismatchAuthority.publicKey)[0],
            agentProfile: mismatchProfilePDA,
            vault: impostorVault,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([mismatchAuthority])
          .rpc();

        expect.fail("Should have rejected a non-canonical vault PDA");
      } catch (err: any) {
        // Anchor raises ConstraintSeeds (code 2006) when seeds::program +
        // seeds don't re-derive the supplied account key.
        const msg = (err?.toString?.() ?? "") + JSON.stringify(err?.logs ?? "");
        expect(msg).to.match(/ConstraintSeeds|A seeds constraint was violated|2006/);
      }
    });

    // Finding #9: an arbitrary (off-curve) pubkey is just as invalid — the
    // Anchor seed check doesn't care whether it's on curve, only whether
    // `findProgramAddress([b"vault", authority], vault_program_id)` matches.
    it("should reject register_agent if vault is an arbitrary pubkey", async () => {
      const randomAuthority = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        randomAuthority.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      const [randomProfilePDA] = deriveAgentProfilePDA(randomAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      try {
        await program.methods
          .registerAgent(
            "Arbitrary",
            testDescription,
            testCategory,
            testCapabilities,
            { perTask: {} },
            new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: randomAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(randomAuthority.publicKey)[0],
            agentProfile: randomProfilePDA,
            // System Program is a known, definitely-not-a-vault pubkey.
            vault: web3.SystemProgram.programId,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([randomAuthority])
          .rpc();

        expect.fail("Should have rejected an arbitrary pubkey as vault");
      } catch (err: any) {
        const msg = (err?.toString?.() ?? "") + JSON.stringify(err?.logs ?? "");
        expect(msg).to.match(/ConstraintSeeds|A seeds constraint was violated|2006/);
      }
    });
  });

  describe("update_profile - Happy Path", () => {
    it("should update profile with partial fields", async () => {
      const newName = "Advanced Data Analyst Pro";
      const newPricingAmount = 2 * web3.LAMPORTS_PER_SOL;

      await program.methods
        .updateProfile(
          newName, // name
          null, // description
          null, // category
          null, // capabilities
          null, // pricing_model
          new BN(newPricingAmount), // pricing_amount
          null // accepted_tokens
        )
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);

      expect(agentProfile.name).to.equal(newName);
      expect(agentProfile.pricingAmount.toString()).to.equal(newPricingAmount.toString());
      // Verify unmodified fields remain the same
      expect(agentProfile.description).to.equal(testDescription);
      expect(agentProfile.category).to.equal(testCategory);
    });

    it("should update capabilities only", async () => {
      const newCapabilities = ["advanced-analytics", "ml-models", "predictive-analysis", "dashboarding"];

      await program.methods
        .updateProfile(
          null, // name
          null, // description
          null, // category
          newCapabilities, // capabilities
          null, // pricing_model
          null, // pricing_amount
          null // accepted_tokens
        )
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(agentProfile.capabilities).to.deep.equal(newCapabilities);
    });

    it("should update accepted tokens", async () => {
      const newTokens = [
        web3.Keypair.generate().publicKey,
        web3.Keypair.generate().publicKey,
      ];

      await program.methods
        .updateProfile(
          null, // name
          null, // description
          null, // category
          null, // capabilities
          null, // pricing_model
          null, // pricing_amount
          newTokens // accepted_tokens
        )
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(agentProfile.acceptedTokens.length).to.equal(newTokens.length);
      for (let i = 0; i < newTokens.length; i++) {
        expect(agentProfile.acceptedTokens[i].toString()).to.equal(newTokens[i].toString());
      }
    });

    it("should update timestamp when profile is modified", async () => {
      const beforeProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      const originalUpdatedAt = beforeProfile.updatedAt.toNumber();

      // Wait a moment to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 1000));

      await program.methods
        .updateProfile(
          null, // name
          "Updated description for testing", // description
          null, // category
          null, // capabilities
          null, // pricing_model
          null, // pricing_amount
          null // accepted_tokens
        )
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const afterProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(afterProfile.updatedAt.toNumber()).to.be.greaterThan(originalUpdatedAt);
    });
  });

  describe("update_status - Status Transitions", () => {
    it("should change status from Active to Paused", async () => {
      await program.methods
        .updateStatus({ paused: {} }) // AgentStatus::Paused
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(agentProfile.status).to.have.property("paused");
    });

    it("should change status from Paused to Active", async () => {
      await program.methods
        .updateStatus({ active: {} }) // AgentStatus::Active
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(agentProfile.status).to.have.property("active");
    });

    it("should change status to Retired", async () => {
      await program.methods
        .updateStatus({ retired: {} }) // AgentStatus::Retired
        .accounts({
          authority: agentAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
          agentProfile: agentProfilePDA,
        })
        .signers([agentAuthority])
        .rpc();

      const agentProfile = await program.account.agentProfile.fetch(agentProfilePDA);
      expect(agentProfile.status).to.have.property("retired");
    });

    it("should reject reactivation from Retired status", async () => {
      // Agent is currently Retired from previous test
      try {
        await program.methods
          .updateStatus({ active: {} })
          .accounts({
            authority: agentAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
            agentProfile: agentProfilePDA,
          })
          .signers([agentAuthority])
          .rpc();
        expect.fail("Should have thrown InvalidStatusTransition error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidStatusTransition");
        expect(err.error.errorCode.number).to.equal(6007);
      }
    });

    it("should reject pausing a Retired agent", async () => {
      try {
        await program.methods
          .updateStatus({ paused: {} })
          .accounts({
            authority: agentAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(agentAuthority.publicKey)[0],
            agentProfile: agentProfilePDA,
          })
          .signers([agentAuthority])
          .rpc();
        expect.fail("Should have thrown InvalidStatusTransition error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidStatusTransition");
        expect(err.error.errorCode.number).to.equal(6007);
      }
    });
  });

  describe("Validation - Name Constraints", () => {
    it("should reject name > 64 bytes with NameTooLong error", async () => {
      // Create a new agent to test validation
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const longName = "a".repeat(65); // 65 bytes, exceeds 64-byte limit
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      try {
        await program.methods
          .registerAgent(
            longName,
            testDescription,
            testCategory,
            testCapabilities,
            { perTask: {} }, new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown NameTooLong error");
      } catch (error) {
        expect(error.message).to.include("NameTooLong");
      }
    });

    it("should accept name exactly 64 bytes", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const exactName = "a".repeat(64); // Exactly 64 bytes
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          exactName,
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.name).to.have.lengthOf(64);
    });
  });

  describe("Validation - Description Constraints", () => {
    it("should reject description > 256 bytes with DescriptionTooLong error", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const longDescription = "a".repeat(257); // 257 bytes, exceeds 256-byte limit
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      try {
        await program.methods
          .registerAgent(
            "Test Agent",
            longDescription,
            testCategory,
            testCapabilities,
            { perTask: {} }, new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown DescriptionTooLong error");
      } catch (error) {
        expect(error.message).to.include("DescriptionTooLong");
      }
    });

    it("should accept description exactly 256 bytes", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const exactDescription = "a".repeat(256); // Exactly 256 bytes
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          exactDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.description).to.have.lengthOf(256);
    });
  });

  describe("Validation - Capabilities Constraints", () => {
    it("should reject empty capabilities array with InvalidCapabilitiesCount error", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      try {
        await program.methods
          .registerAgent(
            "Test Agent",
            testDescription,
            testCategory,
            [], // Empty capabilities
            { perTask: {} }, new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown InvalidCapabilitiesCount error");
      } catch (error) {
        expect(error.message).to.include("InvalidCapabilitiesCount");
      }
    });

    it("should reject > 10 capabilities with InvalidCapabilitiesCount error", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const tooManyCapabilities = Array.from({ length: 11 }, (_, i) => `capability-${i}`);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      try {
        await program.methods
          .registerAgent(
            "Test Agent",
            testDescription,
            testCategory,
            tooManyCapabilities,
            { perTask: {} }, new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown InvalidCapabilitiesCount error");
      } catch (error) {
        expect(error.message).to.include("InvalidCapabilitiesCount");
      }
    });

    it("should accept exactly 10 capabilities", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const tenCapabilities = Array.from({ length: 10 }, (_, i) => `capability-${i}`);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          tenCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.capabilities).to.have.lengthOf(10);
    });

    it("should accept single capability", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const singleCapability = ["single-capability"];
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          singleCapability,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.capabilities).to.have.lengthOf(1);
      expect(fetchedProfile.capabilities[0]).to.equal("single-capability");
    });
  });

  describe("Validation - Accepted Tokens Constraints", () => {
    it("should reject empty accepted_tokens array with InvalidTokensCount error", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      try {
        await program.methods
          .registerAgent(
            "Test Agent",
            testDescription,
            testCategory,
            testCapabilities,
            { perTask: {} }, new BN(testPricingAmount),
            [] // Empty accepted_tokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown InvalidTokensCount error");
      } catch (error) {
        expect(error.message).to.include("InvalidTokensCount");
      }
    });

    it("should reject > 5 accepted_tokens with InvalidTokensCount error", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const tooManyTokens = Array.from({ length: 6 }, (_, i) =>
        web3.Keypair.generate().publicKey
      );

      try {
        await program.methods
          .registerAgent(
            "Test Agent",
            testDescription,
            testCategory,
            testCapabilities,
            { perTask: {} }, new BN(testPricingAmount),
            tooManyTokens
          )
          .accounts({
            authority: testAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
            agentProfile: testPDA,
            vault: vaultFor(testAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([testAuthority])
          .rpc();

        expect.fail("Should have thrown InvalidTokensCount error");
      } catch (error) {
        expect(error.message).to.include("InvalidTokensCount");
      }
    });

    it("should accept exactly 5 accepted_tokens", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const fiveTokens = Array.from({ length: 5 }, (_, i) =>
        web3.Keypair.generate().publicKey
      );

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          fiveTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.acceptedTokens).to.have.lengthOf(5);
    });

    it("should accept single accepted_token", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);

      const singleToken = [web3.Keypair.generate().publicKey];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          singleToken
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const fetchedProfile = await program.account.agentProfile.fetch(testPDA);
      expect(fetchedProfile.acceptedTokens).to.have.lengthOf(1);
    });
  });

  describe("Authorization - Update Profile", () => {
    let authTestAuthority: web3.Keypair;
    let authTestPDA: web3.PublicKey;

    before(async () => {
      // Create a fresh active agent for auth tests (main agent is Retired)
      authTestAuthority = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(authTestAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(airdrop);

      [authTestPDA] = deriveAgentProfilePDA(authTestAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Auth Test Agent",
          "Test agent for auth",
          "testing",
          ["auth-testing"],
          { perTask: {} },
          new BN(100000),
          acceptedTokens
        )
        .accounts({
          authority: authTestAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(authTestAuthority.publicKey)[0],
          agentProfile: authTestPDA,
          vault: vaultFor(authTestAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authTestAuthority])
        .rpc();
    });

    it("should reject profile update from non-authority", async () => {
      try {
        await program.methods
          .updateProfile(
            "Hacked Name",
            null,
            null,
            null,
            null,
            null,
            null
          )
          .accounts({
            authority: otherUser.publicKey,
            ownerNonce: deriveOwnerNoncePDA(otherUser.publicKey)[0],
            agentProfile: authTestPDA,
          })
          .signers([otherUser])
          .rpc();

        expect.fail("Should have thrown authorization error");
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe("Authorization - Update Status", () => {
    it("should reject status update from non-authority", async () => {
      try {
        await program.methods
          .updateStatus({ paused: {} })
          .accounts({
            authority: otherUser.publicKey,
            ownerNonce: deriveOwnerNoncePDA(otherUser.publicKey)[0],
            agentProfile: agentProfilePDA,
          })
          .signers([otherUser])
          .rpc();

        expect.fail("Should have thrown authorization error");
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe("Deregister Agent - Happy Path", () => {
    it("should deregister agent and close account", async () => {
      // Create a new agent specifically for deregistration testing
      let deregisterAuthority = web3.Keypair.generate();
      const deregisterAirdrop = await provider.connection.requestAirdrop(
        deregisterAuthority.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(deregisterAirdrop);

      const [deregisterPDA] = deriveAgentProfilePDA(deregisterAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      // Register agent
      await program.methods
        .registerAgent(
          "Deregister Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: deregisterAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(deregisterAuthority.publicKey)[0],
          agentProfile: deregisterPDA,
          vault: vaultFor(deregisterAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([deregisterAuthority])
        .rpc();

      // Verify account exists
      let accountBefore = await program.account.agentProfile.fetch(deregisterPDA);
      expect(accountBefore).to.not.be.null;

      // Deregister agent
      await program.methods
        .deregisterAgent()
        .accounts({
          authority: deregisterAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(deregisterAuthority.publicKey)[0],
          agentProfile: deregisterPDA,
        })
        .signers([deregisterAuthority])
        .rpc();

      // Verify account is closed
      try {
        await program.account.agentProfile.fetch(deregisterPDA);
        expect.fail("Account should have been closed");
      } catch (error) {
        expect(error.message).to.include("Account does not exist");
      }
    });

    it("should return rent to authority on deregistration", async () => {
      let deregisterAuthority = web3.Keypair.generate();
      const deregisterAirdrop = await provider.connection.requestAirdrop(
        deregisterAuthority.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(deregisterAirdrop);

      const [deregisterPDA] = deriveAgentProfilePDA(deregisterAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      // Get balance before registration
      const balanceBefore = await provider.connection.getBalance(deregisterAuthority.publicKey);

      // Register agent
      const registerTx = await program.methods
        .registerAgent(
          "Deregister Test Agent 2",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: deregisterAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(deregisterAuthority.publicKey)[0],
          agentProfile: deregisterPDA,
          vault: vaultFor(deregisterAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([deregisterAuthority])
        .rpc();

      const balanceAfterRegister = await provider.connection.getBalance(deregisterAuthority.publicKey);

      // Deregister agent
      await program.methods
        .deregisterAgent()
        .accounts({
          authority: deregisterAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(deregisterAuthority.publicKey)[0],
          agentProfile: deregisterPDA,
        })
        .signers([deregisterAuthority])
        .rpc();

      const balanceAfterDeregister = await provider.connection.getBalance(deregisterAuthority.publicKey);

      // Verify rent was returned (balance increased after deregistration)
      expect(balanceAfterDeregister).to.be.greaterThan(balanceAfterRegister);
    });
  });

  describe("Authorization - Deregister Agent", () => {
    it("should reject deregistration from non-authority", async () => {
      // Create a new agent for this test
      let deregisterAuthority = web3.Keypair.generate();
      const deregisterAirdrop = await provider.connection.requestAirdrop(
        deregisterAuthority.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(deregisterAirdrop);

      const [deregisterPDA] = deriveAgentProfilePDA(deregisterAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      // Register agent
      await program.methods
        .registerAgent(
          "Auth Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: deregisterAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(deregisterAuthority.publicKey)[0],
          agentProfile: deregisterPDA,
          vault: vaultFor(deregisterAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([deregisterAuthority])
        .rpc();

      // Try to deregister as different user
      try {
        await program.methods
          .deregisterAgent()
          .accounts({
            authority: otherUser.publicKey,
            ownerNonce: deriveOwnerNoncePDA(otherUser.publicKey)[0],
            agentProfile: deregisterPDA,
          })
          .signers([otherUser])
          .rpc();

        expect.fail("Should have thrown authorization error");
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe("Discovery Simulation - Multiple Agents", () => {
    it("should register 3 agents with different categories", async () => {
      const categories = ["data-analysis", "trading", "content-generation"];
      const authorities = [agentAuthority];
      const pdas: web3.PublicKey[] = [agentProfilePDA];

      // Register 2 more agents
      for (let i = 1; i < 3; i++) {
        const newAuthority = web3.Keypair.generate();
        const airdropSig = await provider.connection.requestAirdrop(
          newAuthority.publicKey,
          web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(airdropSig);

        const [newPDA] = deriveAgentProfilePDA(newAuthority.publicKey);
        authorities.push(newAuthority);
        pdas.push(newPDA);

        const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

        await program.methods
          .registerAgent(
            `Agent ${i + 1}`,
            `Description for agent ${i + 1}`,
            categories[i],
            [`capability-${i}-1`, `capability-${i}-2`],
            { perTask: {} }, new BN(testPricingAmount),
            acceptedTokens
          )
          .accounts({
            authority: newAuthority.publicKey,
            ownerNonce: deriveOwnerNoncePDA(newAuthority.publicKey)[0],
            agentProfile: newPDA,
            vault: vaultFor(newAuthority.publicKey),
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([newAuthority])
          .rpc();
      }

      // Fetch all agents and verify they're distinct
      for (let i = 0; i < 3; i++) {
        const agentProfile = await program.account.agentProfile.fetch(pdas[i]);
        expect(agentProfile.authority.toString()).to.equal(authorities[i].publicKey.toString());
        expect(agentProfile.category).to.equal(categories[i]);
        // First agent's name may have been modified by earlier update tests
        if (i > 0) {
          expect(agentProfile.name).to.equal(`Agent ${i + 1}`);
        }
      }
    });

    it("should verify agents are distinct by authority", async () => {
      // Get all accounts for the program
      const allAccounts = await program.account.agentProfile.all();

      // Should have at least 3 agents from the previous test
      expect(allAccounts.length).to.be.greaterThanOrEqual(3);

      // Verify all authorities are unique
      const authorities = new Set(allAccounts.map(a => a.account.authority.toString()));
      expect(authorities.size).to.equal(allAccounts.length);
    });

    it("should retrieve agents by category for discovery", async () => {
      const allAccounts = await program.account.agentProfile.all();

      // Group agents by category
      const agentsByCategory: { [key: string]: any[] } = {};
      for (const account of allAccounts) {
        const category = account.account.category;
        if (!agentsByCategory[category]) {
          agentsByCategory[category] = [];
        }
        agentsByCategory[category].push(account);
      }

      // Should have at least 2 different categories
      const categories = Object.keys(agentsByCategory);
      expect(categories.length).to.be.greaterThanOrEqual(2);

      // Verify each category has at least one agent
      for (const category of categories) {
        expect(agentsByCategory[category].length).to.be.greaterThan(0);
      }
    });
  });

  describe("PDA Derivation - Deterministic Account Addresses", () => {
    it("should derive consistent PDA for the same authority", async () => {
      const [pda1] = deriveAgentProfilePDA(agentAuthority.publicKey);
      const [pda2] = deriveAgentProfilePDA(agentAuthority.publicKey);

      expect(pda1.toString()).to.equal(pda2.toString());
    });

    it("should derive different PDAs for different authorities", async () => {
      const authority1 = web3.Keypair.generate().publicKey;
      const authority2 = web3.Keypair.generate().publicKey;

      const [pda1] = deriveAgentProfilePDA(authority1);
      const [pda2] = deriveAgentProfilePDA(authority2);

      expect(pda1.toString()).to.not.equal(pda2.toString());
    });
  });

  describe("Enum Handling - Pricing Models", () => {
    it("should accept PerTask pricing model", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(testPDA);
      expect(profile.pricingModel).to.have.property("perTask");
    });

    it("should accept PerHour pricing model", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perHour: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(testPDA);
      expect(profile.pricingModel).to.have.property("perHour");
    });

    it("should accept PerToken pricing model", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perToken: {} }, new BN(testPricingAmount),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(testPDA);
      expect(profile.pricingModel).to.have.property("perToken");
    });
  });

  describe("Edge Cases and Data Integrity", () => {
    it("should handle maximum pricing amount", async () => {
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];
      const maxU64 = new BN("18446744073709551615"); // Max u64

      await program.methods
        .registerAgent(
          "Test Agent",
          testDescription,
          testCategory,
          testCapabilities,
          { perTask: {} },
          maxU64,
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const profile = await program.account.agentProfile.fetch(testPDA);
      expect(profile.pricingAmount.toString()).to.equal(maxU64.toString());
    });

    it("should preserve all field values after update", async () => {
      // Create test agent
      let testAuthority = web3.Keypair.generate();
      const testAirdrop = await provider.connection.requestAirdrop(testAuthority.publicKey, web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(testAirdrop);

      const [testPDA] = deriveAgentProfilePDA(testAuthority.publicKey);
      const acceptedTokens = [new web3.PublicKey("11111111111111111111111111111112")];

      await program.methods
        .registerAgent(
          "Original Name",
          "Original Description",
          "original-category",
          ["orig-cap-1", "orig-cap-2"],
          { perTask: {} },
          new BN(web3.LAMPORTS_PER_SOL),
          acceptedTokens
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
          vault: vaultFor(testAuthority.publicKey),
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([testAuthority])
        .rpc();

      const profileBefore = await program.account.agentProfile.fetch(testPDA);

      // Update only name
      await program.methods
        .updateProfile(
          "Updated Name",
          null,
          null,
          null,
          null,
          null,
          null
        )
        .accounts({
          authority: testAuthority.publicKey,
          ownerNonce: deriveOwnerNoncePDA(testAuthority.publicKey)[0],
          agentProfile: testPDA,
        })
        .signers([testAuthority])
        .rpc();

      const profileAfter = await program.account.agentProfile.fetch(testPDA);

      // Verify unchanged fields are preserved
      expect(profileAfter.description).to.equal(profileBefore.description);
      expect(profileAfter.category).to.equal(profileBefore.category);
      expect(profileAfter.capabilities).to.deep.equal(profileBefore.capabilities);
      expect(profileAfter.pricingModel).to.deep.equal(profileBefore.pricingModel);
      expect(profileAfter.pricingAmount.toString()).to.equal(profileBefore.pricingAmount.toString());
      expect(profileAfter.vaultAddress.toString()).to.equal(profileBefore.vaultAddress.toString());
    });
  });

  // ================================================================
  // AUD-004: Reputation laundering / status-laundering loop
  // ================================================================
  //
  // The full slash → suspend → clear escalation flow is only reachable
  // through Settlement CPI (the slash code path writes Suspended directly
  // without going through `update_status`), and is exercised end-to-end in
  // `tests/settlement.ts` and the Rust unit tests in
  // `programs/agent-registry/src/lib.rs::tests::aud_004_*`. Here we cover
  // the registry-only surface: the `update_status` self-suspension guard,
  // and zero-initialization of `cleared_count` on register.
  describe("AUD-004 - Self-suspension and cleared_count init", () => {
    it("should initialize cleared_count = 0 on register_agent", async () => {
      // Use the happy-path agent registered earlier in this file. After
      // register, cleared_count must be 0.
      const profile = await program.account.agentProfile.fetch(agentProfilePDA);
      // Cast: anchor may surface the field as a number or BN depending on the
      // size; cleared_count is u8 so it lands as a plain number in IDL.
      expect((profile as any).clearedCount).to.equal(0);
    });

    it("should reject self-issued update_status(Suspended)", async () => {
      // Fresh authority + profile so we have an Active agent to attempt the
      // self-suspend on (the happy-path agent has been Retired by the
      // update_status block earlier, and Retired blocks every transition).
      const selfSuspendAuth = web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        selfSuspendAuth.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const [profilePDA] = deriveAgentProfilePDA(selfSuspendAuth.publicKey);
      const [noncePDA] = deriveOwnerNoncePDA(selfSuspendAuth.publicKey);
      const vault = vaultFor(selfSuspendAuth.publicKey);

      // Register the agent.
      await program.methods
        .registerAgent(
          "Self-Suspend Test Agent",
          "Tries to self-suspend",
          "test",
          ["x"],
          { perTask: {} },
          new BN(web3.LAMPORTS_PER_SOL),
          [new web3.PublicKey("11111111111111111111111111111112")]
        )
        .accounts({
          authority: selfSuspendAuth.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          vault,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([selfSuspendAuth])
        .rpc();

      // Sanity: agent is Active and cleared_count is 0.
      const before = await program.account.agentProfile.fetch(profilePDA);
      expect(before.status).to.have.property("active");
      expect((before as any).clearedCount).to.equal(0);

      // Attempt self-suspend → must revert with InvalidStatusTransition.
      try {
        await program.methods
          .updateStatus({ suspended: {} })
          .accounts({
            authority: selfSuspendAuth.publicKey,
            ownerNonce: noncePDA,
            agentProfile: profilePDA,
          })
          .signers([selfSuspendAuth])
          .rpc();
        expect.fail("Should have thrown InvalidStatusTransition error");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidStatusTransition");
      }

      // State must be unchanged.
      const after = await program.account.agentProfile.fetch(profilePDA);
      expect(after.status).to.have.property("active");
      expect((after as any).clearedCount).to.equal(0);
    });

    it("should still allow legitimate status transitions (Active → Paused)", async () => {
      // Regression: the new guard must only block self-suspend, not other
      // transitions. We pause the same agent that just attempted self-suspend.
      const auth = web3.Keypair.generate();
      const airdropSig = await provider.connection.requestAirdrop(
        auth.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig);

      const [profilePDA] = deriveAgentProfilePDA(auth.publicKey);
      const [noncePDA] = deriveOwnerNoncePDA(auth.publicKey);
      const vault = vaultFor(auth.publicKey);

      await program.methods
        .registerAgent(
          "Legit Pause Agent",
          "Pauses normally",
          "test",
          ["x"],
          { perTask: {} },
          new BN(web3.LAMPORTS_PER_SOL),
          [new web3.PublicKey("11111111111111111111111111111112")]
        )
        .accounts({
          authority: auth.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          vault,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([auth])
        .rpc();

      await program.methods
        .updateStatus({ paused: {} })
        .accounts({
          authority: auth.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
        })
        .signers([auth])
        .rpc();

      const after = await program.account.agentProfile.fetch(profilePDA);
      expect(after.status).to.have.property("paused");
    });
  });
});

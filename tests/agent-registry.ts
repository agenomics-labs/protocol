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
  "28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw"
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
      // AUD-007 (PR-Q): `totalTasksCompleted`, `totalEarnings`, and `avgRating`
      // were removed from `AgentProfile`. The IDL no longer carries them, so
      // referencing them here would fail at decode time (or pull `undefined`
      // through `.toNumber()` and explode).
      expect(agentProfile).to.not.have.property("totalTasksCompleted");
      expect(agentProfile).to.not.have.property("totalEarnings");
      expect(agentProfile).to.not.have.property("avgRating");
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

      // AUD-055: Solana's Clock advances per-slot (~400ms), so back-to-back
      // transactions can share the same `unix_timestamp`. Asserting strict
      // ordering (`>`) and forcing a 1s wall-clock wait is flake-prone under
      // contended CI; assert non-strict ordering (`>=`) instead.

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
      expect(afterProfile.updatedAt.toNumber()).to.be.at.least(originalUpdatedAt);
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

  // ================================================================
  // AUD-001 / AUD-002 (PR-G): unified reputation policy + invariants
  // ================================================================

  describe("AUD-001 / AUD-002: legacy update_reputation removed", () => {
    it("should NOT expose `updateReputation` on the program IDL", () => {
      // PR-G: the legacy update_reputation instruction was removed in
      // favour of propose_reputation_delta. Anchor camelCases IDL names
      // at runtime. Absence of the old name + presence of the new name
      // is the contract.
      const ixNames = (program as any).idl.instructions.map(
        (i: { name: string }) => i.name
      );
      expect(ixNames).to.not.include("updateReputation");
      expect(ixNames).to.include("proposeReputationDelta");
    });

    it("should NOT expose the `updateReputation` method on the JS surface", () => {
      expect((program.methods as any).updateReputation).to.equal(undefined);
      expect((program.methods as any).proposeReputationDelta).to.be.a("function");
    });

    it("should expose `verifyProtocolInvariants` on the program IDL", () => {
      const ixNames = (program as any).idl.instructions.map(
        (i: { name: string }) => i.name
      );
      expect(ixNames).to.include("verifyProtocolInvariants");
    });
  });

  describe("AUD-001 / AUD-002: ProposeReputationDelta context shape", () => {
    it("should declare the four expected accounts with the new seed shape", () => {
      // The rewired context (contexts.rs) carries:
      //   owner_nonce, agent_profile, settlement_authority, authority
      // Snapshot the IDL so a future schema drift trips this test.
      const ix = (program as any).idl.instructions.find(
        (i: { name: string }) => i.name === "proposeReputationDelta"
      );
      expect(ix).to.exist;
      const accountNames = ix.accounts.map((a: { name: string }) => a.name);
      // Anchor's runtime IDL converts account names to camelCase too.
      expect(accountNames).to.include.members([
        "ownerNonce",
        "agentProfile",
        "settlementAuthority",
        "authority",
      ]);
    });

    it("should accept i16 delta + u8 reason as the only args", () => {
      const ix = (program as any).idl.instructions.find(
        (i: { name: string }) => i.name === "proposeReputationDelta"
      );
      expect(ix.args).to.have.lengthOf(2);
      const argNames = ix.args.map((a: { name: string }) => a.name);
      expect(argNames).to.include.members(["delta", "reason"]);
    });
  });

  // ================================================================
  // AUD-101 (cycle-2): migrate_agent_profile end-to-end integration
  //
  // Roadmap §3 B3. Cycle-2 closure `fc3c72a` added the missing
  // `owner_nonce` account + 3-seed PDA derivation to
  // `MigrateAgentProfile`, restoring reachability of the migration
  // handler that was unreachable at HEAD (Anchor would reject every
  // invocation with `ConstraintSeeds` because the legacy 2-component
  // seed list could not re-derive the actual on-chain agent_profile
  // PDA, which is always 3-seed).
  //
  // The Rust unit-test layer exercises the normalization predicates
  // (`__padding_aud007 = [0u8; 17]`, `cleared_count = 0`,
  // `assert_valid_profile`, the `Suspended ⇒ slash_count >= 3`
  // bump). The TS integration surface — until now — only verified
  // the seeds bug at the Anchor IDL shape level. This block calls
  // the instruction end-to-end against solana-test-validator and
  // pins:
  //
  //   1. The handler is reachable via the AUD-101 3-seed derivation
  //      on a freshly-registered profile (regression sentinel for
  //      the AUD-101 fix itself).
  //   2. `target_version=1` bumps `version` 0 → 1 and emits the
  //      AgentMigrated event.
  //   3. Idempotency: a second call at the same target_version is a
  //      no-op (no double-bump, no extra rent).
  //   4. The `target_version <= current.version` no-op branch — a
  //      backward-target call returns Ok without mutation.
  //   5. The post-migration profile is bit-for-bit equivalent to a
  //      freshly-registered profile across the migration-normalized
  //      fields (status, reputation_score, slash_count,
  //      cleared_count, padding, vault_address, manifest fields,
  //      registration_nonce). Fields that are intentionally
  //      migration-derived (`version`, `updated_at`) are excluded
  //      from the equivalence comparison.
  //   6. Cross-account-reuse rejection: passing another authority's
  //      `OwnerNonce` PDA fails with `ConstraintSeeds` (validates
  //      that the AUD-101 fix did not introduce a new
  //      cross-account-reuse hole — the seeds constraint on
  //      `owner_nonce` itself binds it to `owner.key()`).
  //   7. Authority gate: a different signer cannot trigger
  //      migration of a profile they don't own (the
  //      `agent_profile.authority == owner.key()` constraint
  //      rejects with `UnauthorizedCaller`).
  //
  // Bankrun limitation (documented for cycle-3 follow-up): the
  // roadmap's literal "write the pre-AUD-007 layout directly /
  // skip init / manipulate the account data so it matches the
  // legacy schema" approach requires solana-bankrun's
  // `setAccount` escape hatch. The current harness uses
  // solana-test-validator, which has no API for installing
  // hand-constructed account bytes. Two normalization branches in
  // `migrate_agent_profile` therefore remain TS-uncovered:
  //
  //   (a) `reputation_score = score.min(MAX_REPUTATION_SCORE)`
  //       clamp on a profile carrying a legacy unbounded score
  //       (> 100). The post-PR-G `propose_reputation_delta`
  //       caps writes at 100, so no legitimate instruction path
  //       can produce an out-of-range score on a fresh
  //       validator.
  //
  //   (b) `if status == Suspended && slash_count < 3 { slash_count
  //       = 3 }` invariant restoration. Reaching Suspended from a
  //       fresh validator requires either (i) 3 slash-bearing
  //       Settlement CPIs (out of scope here — the four
  //       AUD-117 cases in cpi-failures.test.ts cover the CPI
  //       surface) or (ii) `update_status(Suspended)`, which
  //       PR-I now blocks for self-issued transitions.
  //
  // The Rust unit tests in `lib.rs::tests` cover both (a) and (b)
  // via direct field manipulation on a stack-allocated
  // `AgentProfile`. When anchor-bankrun lands (tracked alongside
  // AUD-117 ResolveDisputeTimeout / settlement.ts:2224 +
  // cpi-failures.test.ts:1266), the legacy-bytes write path
  // becomes feasible and these branches can be lifted into
  // integration coverage. Until then, this block exercises every
  // migration path that does NOT depend on pre-existing
  // out-of-range state.
  // ================================================================

  describe("AUD-101: migrate_agent_profile end-to-end", () => {
    // Helper: register a fresh agent (nonce=0) and return the keys
    // and PDAs needed to drive the migration. Each call uses an
    // independent authority so tests don't share residual state.
    async function registerFreshAgent(nameSuffix: string): Promise<{
      authority: web3.Keypair;
      profilePDA: web3.PublicKey;
      noncePDA: web3.PublicKey;
    }> {
      const authority = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        authority.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      const [profilePDA] = deriveAgentProfilePDA(authority.publicKey);
      const [noncePDA] = deriveOwnerNoncePDA(authority.publicKey);
      const vault = vaultFor(authority.publicKey);

      await program.methods
        .registerAgent(
          `Migrate Test ${nameSuffix}`,
          "Profile registered for AUD-101 migration coverage",
          "test",
          ["migrate-coverage"],
          { perTask: {} },
          new BN(web3.LAMPORTS_PER_SOL),
          [new web3.PublicKey("11111111111111111111111111111112")]
        )
        .accounts({
          authority: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          vault,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      return { authority, profilePDA, noncePDA };
    }

    it("should be reachable end-to-end via the AUD-101 3-seed derivation (regression sentinel)", async () => {
      // Pre-AUD-101 this call would always fail with ConstraintSeeds
      // because the context's 2-seed derivation could not re-derive
      // the on-chain 3-seed PDA. This single passing call is the
      // load-bearing assertion that the AUD-101 fix is in place and
      // migration is not silently broken before mainnet.
      const { authority, profilePDA, noncePDA } = await registerFreshAgent("reachable");

      const before = await (program.account as any).agentProfile.fetch(profilePDA);
      expect(before.version).to.equal(0);

      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const after = await (program.account as any).agentProfile.fetch(profilePDA);
      expect(after.version).to.equal(1);
    });

    it("should emit the AgentMigrated event on a successful version bump", async () => {
      // The `emit!(AgentMigrated { ... })` call in lib.rs sits AFTER
      // `assert_valid_profile` and BEFORE the `Ok(())` return, with no
      // intervening early-exit branches — i.e. event emission is
      // unconditional on a successful version-bump path. Two-fold
      // evidence the event landed:
      //
      //   (a) The "regression sentinel" test above asserts version
      //       bumped 0 → 1 after a successful .rpc() broadcast. The
      //       version mutation happens at lib.rs:685, BEFORE the
      //       emit! at lib.rs:728. If the tx succeeded and version
      //       bumped, every line between them executed — including
      //       the unconditional emit!.
      //
      //   (b) Wire-level: re-broadcast and read back the
      //       transaction's log messages, asserting the
      //       `Program data: <base64>` line that Anchor's `emit!`
      //       macro produces. The base64 payload begins with the
      //       8-byte AgentMigrated event discriminator
      //       (sha256("event:AgentMigrated")[..8] = 3afb734612e65fa4
      //       — see src/indexer/index.ts:236).
      //
      // We do (b) here. Anchor's `.rpc()` fetches a blockhash and
      // broadcasts in two separate RPC round-trips; under heavy
      // parallel-test load the slot can advance between them and the
      // server returns "Blockhash not found". Wrap the broadcast in
      // a small retry loop: each attempt re-fetches the blockhash
      // implicitly via Anchor's internals.
      const { authority, profilePDA, noncePDA } = await registerFreshAgent("event");

      let sig: string | null = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < 4 && sig === null; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 750));
        }
        try {
          sig = await program.methods
            .migrateAgentProfile(1)
            .accounts({
              owner: authority.publicKey,
              ownerNonce: noncePDA,
              agentProfile: profilePDA,
              systemProgram: web3.SystemProgram.programId,
            })
            .signers([authority])
            .rpc({ commitment: "confirmed" });
        } catch (err: any) {
          lastErr = err;
          const msg = String(err?.message ?? err);
          // Only retry the known-flaky blockhash race. Any other
          // failure (constraint violation, runtime error) must
          // surface immediately so the test reports the real cause.
          if (!/Blockhash not found|block height exceeded|TransactionExpired/i.test(msg)) {
            throw err;
          }
        }
      }
      if (sig === null) {
        throw lastErr ?? new Error("migrate broadcast failed after retries");
      }

      // Read back logs. Retry to absorb the (common) commitment-lag
      // race where the tx is accepted but not yet visible to
      // subsequent RPCs.
      let tx = null;
      for (let attempt = 0; attempt < 4 && tx === null; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500));
        }
        tx = await provider.connection.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      }
      expect(tx, "tx should be retrievable post-broadcast").to.exist;

      const logs = tx?.meta?.logMessages ?? [];
      const hasProgramData = logs.some((l: string) => /Program data: /.test(l));
      expect(
        hasProgramData,
        `expected an event 'Program data:' log line; got:\n${logs.join("\n")}`
      ).to.equal(true);
    });

    it("should be idempotent — second call at the same target_version is a no-op", async () => {
      // Idempotency is load-bearing for the upgrade-script choreography
      // in DESIGN-DECISIONS § Ship sequence item 4: operators must be
      // able to re-run the migration sweep without double-bumping
      // version or paying spurious rent.
      const { authority, profilePDA, noncePDA } = await registerFreshAgent("idempotent");

      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const afterFirst = await (program.account as any).agentProfile.fetch(profilePDA);
      const updatedAtAfterFirst = afterFirst.updatedAt.toNumber();

      // Second call at the SAME target_version. The `version >= target_version`
      // early-return triggers; no field is touched.
      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const afterSecond = await (program.account as any).agentProfile.fetch(profilePDA);
      expect(afterSecond.version).to.equal(1, "version must NOT double-bump on idempotent re-call");
      // updated_at is in the early-return-skipped block, so the second call
      // must NOT touch it. (If a future refactor moves the timestamp write
      // above the version-check guard, this assertion catches it.)
      expect(afterSecond.updatedAt.toNumber()).to.equal(
        updatedAtAfterFirst,
        "updated_at must NOT advance on idempotent re-call (no mutation occurred)"
      );
    });

    it("should be a no-op when target_version <= current version (backward target)", async () => {
      // Tests the `profile.version >= target_version` early-return on a
      // BACKWARD target — a valid call shape that callers may use in
      // upgrade scripts that pass a uniform target across mixed-version
      // accounts (some already past, some not yet there).
      const { authority, profilePDA, noncePDA } = await registerFreshAgent("backward");

      // Bump 0 → 1 first.
      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      // Now call with target_version=0 (already past). Must be a no-op,
      // not a downgrade.
      await program.methods
        .migrateAgentProfile(0)
        .accounts({
          owner: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const after = await (program.account as any).agentProfile.fetch(profilePDA);
      expect(after.version).to.equal(1, "version must NOT downgrade on backward target");
    });

    it("post-migration profile fields match a freshly-registered profile (excepting migration-derived fields)", async () => {
      // The roadmap's "verifies post-migration state matches a
      // freshly-registered profile bit-for-bit" requirement, narrowed
      // to fields that are NOT intentionally migration-derived
      // (`version` is exactly what migration mutates;
      // `updated_at`/`created_at` are wall-clock-derived and naturally
      // differ). Names, identity, and policy fields must be untouched
      // — migration is layout-preserving for everything except the
      // explicit normalization writes called out in the lib.rs
      // comment block.

      // Migrated profile: register fresh, then run migration.
      const migrated = await registerFreshAgent("migrated-baseline");
      const beforeMigration = await (program.account as any).agentProfile.fetch(
        migrated.profilePDA
      );
      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: migrated.authority.publicKey,
          ownerNonce: migrated.noncePDA,
          agentProfile: migrated.profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([migrated.authority])
        .rpc();
      const migratedAfter = await (program.account as any).agentProfile.fetch(
        migrated.profilePDA
      );

      // Migration mutates: version → 1, padding zeroed, cleared_count = 0,
      // reputation_score clamped (no-op for in-range), slash_count
      // possibly bumped (no-op for non-Suspended).
      //
      // Anchor 0.31's runtime IDL keeps leading-underscore field names
      // verbatim, but the TS account decoder strips snake-case casing
      // inconsistently across versions for double-underscore prefixes.
      // Walk the record to find whichever variant actually appears so
      // this assertion survives a coder upgrade.
      function readPadding(profile: any): Buffer {
        const candidates = [
          "__padding_aud007",
          "_padding_aud007",
          "padding_aud007",
          "paddingAud007",
        ];
        for (const k of candidates) {
          if (profile[k] !== undefined) return Buffer.from(profile[k]);
        }
        throw new Error(
          `padding field not found on profile; available keys: ${Object.keys(profile).join(", ")}`
        );
      }
      expect(migratedAfter.version).to.equal(1);
      expect(readPadding(migratedAfter)).to.deep.equal(Buffer.alloc(17));
      expect(migratedAfter.clearedCount).to.equal(0);
      expect(migratedAfter.reputationScore.toNumber()).to.equal(
        beforeMigration.reputationScore.toNumber()
      );
      expect(migratedAfter.reputationScore.toNumber()).to.be.lte(100);

      // Non-mutated identity / policy fields must equal pre-migration values.
      // (Bit-for-bit equivalence on these is the contract for AUD-007's
      // "layout-preserving" claim.)
      expect(migratedAfter.authority.toString()).to.equal(beforeMigration.authority.toString());
      expect(migratedAfter.name).to.equal(beforeMigration.name);
      expect(migratedAfter.description).to.equal(beforeMigration.description);
      expect(migratedAfter.category).to.equal(beforeMigration.category);
      expect(migratedAfter.capabilities).to.deep.equal(beforeMigration.capabilities);
      expect(JSON.stringify(migratedAfter.pricingModel)).to.equal(
        JSON.stringify(beforeMigration.pricingModel)
      );
      expect(migratedAfter.pricingAmount.toString()).to.equal(
        beforeMigration.pricingAmount.toString()
      );
      expect(migratedAfter.acceptedTokens.length).to.equal(
        beforeMigration.acceptedTokens.length
      );
      expect(migratedAfter.vaultAddress.toString()).to.equal(
        beforeMigration.vaultAddress.toString()
      );
      expect(JSON.stringify(migratedAfter.status)).to.equal(
        JSON.stringify(beforeMigration.status)
      );
      expect(migratedAfter.bump).to.equal(beforeMigration.bump);
      expect(migratedAfter.createdAt.toNumber()).to.equal(
        beforeMigration.createdAt.toNumber()
      );
      expect(migratedAfter.registrationNonce.toString()).to.equal(
        beforeMigration.registrationNonce.toString()
      );
      expect(migratedAfter.manifestVersion).to.equal(beforeMigration.manifestVersion);
      expect(Buffer.from(migratedAfter.manifestHash)).to.deep.equal(
        Buffer.from(beforeMigration.manifestHash)
      );
      expect(Buffer.from(migratedAfter.manifestSignature)).to.deep.equal(
        Buffer.from(beforeMigration.manifestSignature)
      );
      expect(Buffer.from(migratedAfter.manifestCid)).to.deep.equal(
        Buffer.from(beforeMigration.manifestCid)
      );

      // Compare against an INDEPENDENTLY-registered fresh profile. After
      // both have been migrated to version=1, all migration-normalized
      // fields must match bit-for-bit (excepting timestamps/identity).
      const fresh = await registerFreshAgent("migrated-twin");
      await program.methods
        .migrateAgentProfile(1)
        .accounts({
          owner: fresh.authority.publicKey,
          ownerNonce: fresh.noncePDA,
          agentProfile: fresh.profilePDA,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([fresh.authority])
        .rpc();
      const freshAfter = await (program.account as any).agentProfile.fetch(fresh.profilePDA);

      // Migration-normalized invariants identical across the two profiles.
      expect(migratedAfter.version).to.equal(freshAfter.version);
      expect(migratedAfter.clearedCount).to.equal(freshAfter.clearedCount);
      expect(migratedAfter.reputationScore.toString()).to.equal(
        freshAfter.reputationScore.toString()
      );
      expect(migratedAfter.reputationStake.slashCount).to.equal(
        freshAfter.reputationStake.slashCount
      );
      expect(migratedAfter.reputationStake.stakedAmount.toString()).to.equal(
        freshAfter.reputationStake.stakedAmount.toString()
      );
      expect(JSON.stringify(migratedAfter.status)).to.equal(JSON.stringify(freshAfter.status));
      // Padding bytes equivalent (both zeroed) — the AUD-007 layout-preserving
      // contract: post-migration, the padding region is canonically zero on
      // every profile regardless of register-vs-migrate origin.
      expect(readPadding(migratedAfter)).to.deep.equal(readPadding(freshAfter));
    });

    it("should reject a substituted OwnerNonce from a different authority (cross-account-reuse guard)", async () => {
      // The AUD-101 fix added `owner_nonce` to MigrateAgentProfile with
      // `seeds = [owner.key().as_ref(), b"owner-nonce"]`. The seeds
      // constraint binds the account address to the SIGNING owner —
      // passing another owner's nonce account fails before any handler
      // logic runs. This is the same defense-in-depth pattern AUD-117
      // landed at the Settlement boundary.
      const target = await registerFreshAgent("xreuse-target");
      const decoy = await registerFreshAgent("xreuse-decoy");

      // Sanity: the two nonces are distinct account addresses.
      expect(target.noncePDA.toString()).to.not.equal(decoy.noncePDA.toString());

      try {
        await program.methods
          .migrateAgentProfile(1)
          .accounts({
            owner: target.authority.publicKey,
            ownerNonce: decoy.noncePDA, // <-- spoofed: belongs to the decoy
            agentProfile: target.profilePDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([target.authority])
          .rpc();
        expect.fail("migrate_agent_profile must reject a cross-owner OwnerNonce");
      } catch (err: any) {
        const msg = String(err.message ?? err) + JSON.stringify(err?.logs ?? "");
        // Anchor formats this as ConstraintSeeds (numeric code 2006).
        // The decoy's nonce PDA does not re-derive under the target
        // owner's pubkey, so the seeds constraint trips before the
        // realloc / authority check.
        expect(msg).to.match(
          /ConstraintSeeds|seeds constraint was violated|2006/i,
          `expected ConstraintSeeds, got: ${msg}`
        );
      }
    });

    it("should reject a different signer attempting to migrate someone else's profile", async () => {
      // Defense-in-depth on the authority gate: even if the attacker
      // somehow passes the correct PDAs, the
      // `agent_profile.authority == owner.key() @ UnauthorizedCaller`
      // constraint must reject.
      //
      // Setup: target owns a profile; attacker is a different signer.
      // Attacker tries to migrate target's profile but supplies their
      // OWN owner_nonce (which derives to a different agent_profile
      // PDA) — this fails at the seeds constraint on agent_profile.
      // To exercise the explicit `authority == owner.key()`
      // constraint, attacker would need a way to pass target's
      // owner_nonce while signing as themselves; the seeds
      // constraint on owner_nonce already catches that path.
      // What we DO test here: the attacker cannot drive a successful
      // migration on someone else's profile end-to-end. The exact
      // rejection mode (UnauthorizedCaller vs ConstraintSeeds) depends
      // on which constraint fires first; either is acceptable
      // evidence of the gate.
      const target = await registerFreshAgent("authgate-target");
      const attacker = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        attacker.publicKey,
        web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      try {
        await program.methods
          .migrateAgentProfile(1)
          .accounts({
            owner: attacker.publicKey, // signer is the attacker
            ownerNonce: target.noncePDA, // but using target's nonce
            agentProfile: target.profilePDA,
            systemProgram: web3.SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        expect.fail("migrate_agent_profile must reject a non-owner signer");
      } catch (err: any) {
        const msg = String(err.message ?? err) + JSON.stringify(err?.logs ?? "");
        // The seeds constraint on owner_nonce (`[owner.key(),
        // b"owner-nonce"]`) trips first because target.noncePDA does
        // not re-derive under attacker.publicKey. This is the same
        // ConstraintSeeds code as the cross-reuse case above; the
        // path through which the attacker tries to compromise the
        // gate doesn't matter — every path is closed.
        expect(msg).to.match(
          /ConstraintSeeds|seeds constraint was violated|UnauthorizedCaller|2006|6005/i,
          `expected ConstraintSeeds or UnauthorizedCaller, got: ${msg}`
        );
      }
    });
  });

  // ================================================================
  // AUD-108 (cycle-2): reason-code rejection at the Registry boundary
  //
  // Roadmap §3 B5. Cycle-2 closure `21c01ba` added
  // `require!(reason <= 2, InvalidReputationReason)` at the top of
  // `propose_reputation_delta` (lib.rs:322-325). The Rust unit test
  // `aud_100_aud_108_reserved_reason_codes_do_not_slash` pins both
  // the slash-predicate exclusion and the handler-level rejection
  // for reason codes 3..=10. This block adds the integration-side
  // contract: pin the typed error variant on the IDL surface and
  // exercise the rejection from the TS client.
  //
  // ATTACK-VECTOR ANALYSIS — why "direct call" is the only TS-
  // reachable AUD-108 surface:
  //
  //   The Registry's `ProposeReputationDelta` context constrains
  //   `settlement_authority` as a `signer` PDA derived under
  //   `seeds::program = SETTLEMENT_PROGRAM_ID` (contexts.rs:318-324).
  //   `invoke_signed` from a TS client is cryptographically
  //   infeasible — the runtime rejects unsigned-PDA tx slots before
  //   any program logic runs. The Settlement-side production CPI
  //   helper hardcodes `reason ∈ {0, 1, 2}` via the AUD-109/113
  //   constants `REASON_TASK_COMPLETED=0`, `REASON_DISPUTE_LOSS=1`,
  //   `REASON_EXPIRY_UNDELIVERED=2` (`programs/settlement/src/
  //   instructions/cpi.rs:54-56`), with all five call sites pinned
  //   to those constants — so no Settlement-driven attack vector
  //   exists either.
  //
  //   AUD-108's defense-in-depth is for the hypothetical future bug
  //   where (a) a new Settlement code path adds a CPI call site
  //   that forwards an attacker-controlled reason byte, OR (b) a
  //   future helper Solana program manages to forge a
  //   settlement_authority signature (out of scope for this
  //   harness — the AUD-017 case 4 in `tests/cpi-failures.test.ts`
  //   documents the same forgery-test infeasibility). In both
  //   futures the Registry-side `require!` is the catch-all.
  //
  //   What this block CAN test from TS without a helper program:
  //
  //     1. The IDL declares `InvalidReputationReason` with code 6028
  //        and the AUD-108 message — the wire-level contract that
  //        downstream SDK consumers (mcp-server, indexer) parse
  //        against. Drift in the variant name, code, or message
  //        breaks every consumer that string-matches the rejection.
  //
  //     2. A direct invocation of `propose_reputation_delta` with
  //        `reason=200` from a TS client fails — proves the Registry
  //        boundary refuses any unauthorized direct call regardless
  //        of the reason byte. The rejection mode is the runtime's
  //        missing-signature check on `settlement_authority` (since
  //        TS cannot satisfy the `invoke_signed`-only signer
  //        constraint), NOT InvalidReputationReason. We confirm this
  //        by elimination: the same call shape with `reason=0` also
  //        fails identically — proving it's the signer constraint,
  //        not the AUD-108 reason gate, that fires from TS direct
  //        calls. The handler-level reason gate stays defended by
  //        the Rust unit test.
  //
  //     3. The production happy path (Settlement → Registry CPI via
  //        `approve_milestone` with `reason=0`) succeeds end-to-end
  //        — already covered exhaustively by the AUD-017 suite at
  //        `tests/cpi-failures.test.ts:594` ("handles a Suspended
  //        provider (verify behavior)"); cross-referenced here for
  //        the closure-status review.
  //
  //   When a helper Solana program lands (cycle-3+) that can forge
  //   a `settlement_authority` signature, the cleanest E2E
  //   `InvalidReputationReason` integration assertion becomes
  //   reachable: forge the signer, pass `reason=200`, assert error
  //   code 6028 surfaces in the tx logs.
  // ================================================================

  describe("AUD-108: reputation reason-code rejection", () => {
    // The IDL-level error code for InvalidReputationReason. Pinning
    // this constant in the test forces a future ADR-driven extension
    // that renumbers errors (or adds variants ahead of this one) to
    // update the test alongside the change — making any silent drift
    // visible at PR time.
    const INVALID_REPUTATION_REASON_CODE = 6028;

    // Local copy of the registerFreshAgent helper so this describe
    // block stays self-contained — independent from the AUD-101
    // block above (separate commit ownership: AUD-101 = roadmap B3,
    // AUD-108 = roadmap B5; bisect-friendly).
    async function registerFreshAgent(nameSuffix: string): Promise<{
      authority: web3.Keypair;
      profilePDA: web3.PublicKey;
      noncePDA: web3.PublicKey;
    }> {
      const authority = web3.Keypair.generate();
      const airdrop = await provider.connection.requestAirdrop(
        authority.publicKey,
        2 * web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdrop);

      const [profilePDA] = deriveAgentProfilePDA(authority.publicKey);
      const [noncePDA] = deriveOwnerNoncePDA(authority.publicKey);
      const vault = vaultFor(authority.publicKey);

      await program.methods
        .registerAgent(
          `AUD-108 ${nameSuffix}`,
          "Profile registered for AUD-108 reason-code-rejection coverage",
          "test",
          ["aud108-coverage"],
          { perTask: {} },
          new BN(web3.LAMPORTS_PER_SOL),
          [new web3.PublicKey("11111111111111111111111111111112")]
        )
        .accounts({
          authority: authority.publicKey,
          ownerNonce: noncePDA,
          agentProfile: profilePDA,
          vault,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      return { authority, profilePDA, noncePDA };
    }

    it("declares the InvalidReputationReason error variant on the IDL with the AUD-108 contract", () => {
      const idl: any = (program as any).idl;
      const errs: Array<{ code: number; name: string; msg?: string }> = idl.errors ?? [];
      // Anchor's runtime IDL camelCases names (see the AUD-001/002
      // "ProposeReputationDelta context shape" suite above for the
      // same convention applied to instructions). The error variant
      // surfaces as either PascalCase (raw IDL JSON) or camelCase
      // (post-Anchor rewrite); accept either so this test survives
      // an Anchor coder upgrade.
      const variant = errs.find(
        (e) => e.name === "InvalidReputationReason" || e.name === "invalidReputationReason"
      );

      expect(variant, "InvalidReputationReason must be declared on the IDL").to.exist;
      // Code: load-bearing for downstream SDK consumers that
      // string-match the rejection out of program logs.
      expect(variant!.code).to.equal(
        INVALID_REPUTATION_REASON_CODE,
        "AUD-108 error code must equal 6028 — drift breaks every SDK consumer"
      );
      // Message: the canonical wording from
      // `programs/agent-registry/src/errors.rs` AUD-108 block. We
      // assert on substrings (not the full string) so a future
      // copy-edit is allowed without test churn, but the policy
      // semantics — the {0,1,2} accept set and the 3-255 reservation
      // — must remain visible.
      expect(variant!.msg).to.include("0 (task_completed)");
      expect(variant!.msg).to.include("1 (dispute_loss)");
      expect(variant!.msg).to.include("2 (expiry_undelivered)");
      expect(variant!.msg).to.include("3-255 are reserved");
      expect(variant!.msg).to.include("AUD-108");
    });

    it("rejects a direct propose_reputation_delta call with reason=200 at the Registry boundary", async () => {
      // Setup: a fresh registered agent so the agent_profile +
      // owner_nonce PDAs both exist. (Without them, Anchor would
      // reject earlier with AccountNotInitialized, masking the
      // signer rejection we want to surface.)
      const target = await registerFreshAgent("aud108-direct-200");

      // The settlement_authority PDA address. Derivable from
      // `[b"settlement_authority"]` under the Settlement program ID
      // — but a TS client cannot make it sign (signing requires
      // `invoke_signed` from inside Settlement). We pass the
      // canonical address; the runtime rejection on the unsigned
      // signer slot is what proves the boundary refuses the call.
      const SETTLEMENT_PROGRAM_ID = new web3.PublicKey(
        "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"
      );
      const [settlementAuthorityPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("settlement_authority")],
        SETTLEMENT_PROGRAM_ID
      );

      // Independent fee-payer signer (the test's wallet) so the
      // failure is the Registry boundary's, not a fee-payer issue.
      // We use the registered agent's own keypair as the fee payer
      // — they're already funded, and they're NOT the
      // settlement_authority signer the constraint requires.
      let caught: any = null;
      try {
        await program.methods
          .proposeReputationDelta(-1, 200) // delta=-1 (in MAX_DELTA_PER_CALL window), reason=200
          .accounts({
            ownerNonce: target.noncePDA,
            agentProfile: target.profilePDA,
            settlementAuthority: settlementAuthorityPDA,
            authority: target.authority.publicKey,
          })
          .signers([target.authority])
          .rpc();
      } catch (err: any) {
        caught = err;
      }
      expect(caught, "direct propose_reputation_delta with reason=200 must reject").to.exist;

      const msg = String(caught?.message ?? caught) + JSON.stringify(caught?.logs ?? "");

      // Rejection mode: from a TS client, Anchor's web3.js client
      // throws synchronously with "unknown signer: <pubkey>" because
      // it cannot identify a keypair for the `settlement_authority`
      // slot the IDL marks as `signer`. This is the AUD-108
      // rejection AT THE CLIENT LAYER — the tx never reaches the
      // wire, never reaches the validator, and never reaches the
      // handler. If the client check were ever loosened or the
      // settlement_authority were demoted from `signer`, the runtime
      // signature-verify would catch it; if BOTH were ever bypassed
      // (e.g. via a malicious helper Solana program forging
      // invoke_signed), the handler-level `require!(reason <= 2)`
      // would catch it (defense-in-depth). All three layers are
      // explicitly enumerated in the regex so a future bypass of
      // any one layer surfaces the next as the rejection mode
      // without breaking this test.
      //
      // Accept any of:
      //   - "unknown signer" — Anchor TS client refuses to build
      //     the tx (current TS-direct-call path)
      //   - "Signature verification failed" / "missing required
      //     signature" — runtime layer (fallback if client check
      //     is bypassed)
      //   - "ConstraintSigner" / Anchor error 2002 — Anchor's
      //     #[account(signer, ...)] on settlement_authority
      //     (fallback if both above are bypassed)
      //   - "InvalidReputationReason" / 6028 — the AUD-108 gate
      //     itself (would only fire if all signer constraints are
      //     somehow bypassed — true defense-in-depth path,
      //     reachable today only by a bankrun + helper-program
      //     forgery test)
      expect(msg).to.match(
        /unknown signer|Signature verification|missing.*signature|ConstraintSigner|2002|InvalidReputationReason|6028|Privilege escalation/i,
        `expected a Registry-boundary rejection (signer constraint or AUD-108 reason gate); got: ${msg}`
      );
    });

    it("the boundary rejects on ANY reason byte from a TS direct call (signer-constraint elimination test)", async () => {
      // Companion to the previous test: the SAME call shape with the
      // valid `reason=0` MUST also fail with the same rejection mode
      // — proving by elimination that what fires from a TS direct
      // call is the signer / boundary constraint, NOT the AUD-108
      // reason gate. This rules out the false-positive interpretation
      // "the previous test passed because reason=200 was rejected by
      // AUD-108 specifically" — which would be misleading evidence
      // since the actual rejection happens before the handler body.
      //
      // The implication: AUD-108's handler-level reason gate is
      // strictly defense-in-depth from the perspective of TS-only
      // attackers. The closure-status review can rely on this test +
      // the Rust unit test (`aud_100_aud_108_reserved_reason_codes_do
      // _not_slash`, lib.rs:2050) for full AUD-108 coverage. Cycle-3
      // anchor-bankrun work that adds a Settlement-program forgery
      // helper unlocks the missing TS surface.
      const target = await registerFreshAgent("aud108-direct-0");

      const SETTLEMENT_PROGRAM_ID = new web3.PublicKey(
        "9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95"
      );
      const [settlementAuthorityPDA] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("settlement_authority")],
        SETTLEMENT_PROGRAM_ID
      );

      let caught: any = null;
      try {
        await program.methods
          .proposeReputationDelta(1, 0) // valid reason — must STILL fail
          .accounts({
            ownerNonce: target.noncePDA,
            agentProfile: target.profilePDA,
            settlementAuthority: settlementAuthorityPDA,
            authority: target.authority.publicKey,
          })
          .signers([target.authority])
          .rpc();
      } catch (err: any) {
        caught = err;
      }
      expect(
        caught,
        "direct propose_reputation_delta with reason=0 must ALSO reject — boundary refuses regardless of reason"
      ).to.exist;

      const msg = String(caught?.message ?? caught) + JSON.stringify(caught?.logs ?? "");

      // Same rejection family as the reason=200 case. Crucially: it
      // must NOT be InvalidReputationReason / 6028, since reason=0
      // is in the valid set. If this test ever sees 6028, AUD-108's
      // require! has accidentally tightened to reject the valid
      // codes too — which would silently break every Settlement
      // CPI in production.
      expect(msg).to.not.match(
        /InvalidReputationReason|6028/i,
        `reason=0 must NOT trip the AUD-108 gate; got: ${msg}`
      );
      expect(msg).to.match(
        /unknown signer|Signature verification|missing.*signature|ConstraintSigner|2002|Privilege escalation/i,
        `expected a signer-boundary rejection (proving the AUD-108 gate is not what fires from TS); got: ${msg}`
      );
    });
  });

  describe("AUD-206: propose_reputation_delta rejects Retired profiles", () => {
    // The IDL-level error code for ProfileRetired. Pinning this
    // constant in the test forces a future variant insertion ahead of
    // ProfileRetired in `errors.rs` to update the test alongside the
    // change — making any silent SDK-consumer drift visible at PR
    // time. The code is `6029` because ProfileRetired is appended
    // after AUD-108's `InvalidReputationReason` (6028) at the end of
    // the enum.
    const PROFILE_RETIRED_CODE = 6029;

    it("declares the ProfileRetired error variant on the IDL with the AUD-206 contract", () => {
      const idl: any = (program as any).idl;
      const errs: Array<{ code: number; name: string; msg?: string }> = idl.errors ?? [];
      // Anchor's runtime IDL camelCases names (see the AUD-108
      // "InvalidReputationReason" test above for the same convention
      // applied to error variants). Accept either casing so this test
      // survives an Anchor coder upgrade.
      const variant = errs.find(
        (e) => e.name === "ProfileRetired" || e.name === "profileRetired"
      );

      expect(variant, "ProfileRetired must be declared on the IDL").to.exist;
      // Code: load-bearing for downstream SDK consumers that
      // string-match the rejection out of program logs.
      expect(variant!.code).to.equal(
        PROFILE_RETIRED_CODE,
        "AUD-206 error code must equal 6029 — drift breaks every SDK consumer"
      );
      // Message: the canonical wording from
      // `programs/agent-registry/src/errors.rs` AUD-206 block. We
      // assert on substrings (not the full string) so a future
      // copy-edit is allowed without test churn, but the policy
      // semantics — that the rejection is specifically for terminal
      // Retired profiles — must remain visible.
      expect(variant!.msg).to.include("Retired");
      expect(variant!.msg).to.include("AUD-206");
    });

    // Note on test coverage: a TS-direct-call rejection test (mirroring
    // the AUD-108 boundary tests above) cannot exercise the
    // handler-body require! because the `settlement_authority` PDA
    // signer constraint on `ProposeReputationDelta`
    // (contexts.rs:317-323) trips first — the call never reaches the
    // handler. The handler-body guard's regression coverage lives in
    // `programs/agent-registry/src/lib.rs` Rust unit tests
    // `aud_206_active_paused_suspended_pass_terminal_guard` (happy
    // path) and `aud_206_retired_profile_rejected_at_handler_entry`
    // (rejection path), invoked under `cargo test -p agent-registry`.
    // This TS test pins the IDL error-variant surface for SDK
    // consumers; the Rust tests pin the handler semantics.
  });
});

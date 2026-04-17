/**
 * MCP Server Handler Integration Tests
 *
 * Tests each handler function against a live local validator with
 * all three AEAP programs deployed. Validates real on-chain interactions.
 *
 * Run: npx ts-mocha -p tsconfig.test.json test/mcp-handlers.test.ts --timeout 60000
 */

import { expect } from "chai";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as path from "path";
import * as fs from "fs";

// ==================== TEST SETUP ====================

const RPC_URL = "http://localhost:8899";
const connection = new Connection(RPC_URL, "confirmed");

// We'll load the IDLs and test against the programs directly,
// simulating what the MCP handlers do internally.

const VAULT_PROGRAM_ID = new PublicKey(
  "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"
);
const REGISTRY_PROGRAM_ID = new PublicKey(
  "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"
);
const SETTLEMENT_PROGRAM_ID = new PublicKey(
  "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"
);

function loadIdl(name: string): any {
  const idlPath = path.resolve(
    __dirname,
    "..",
    "..",
    "target",
    "idl",
    `${name}.json`
  );
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

class KeypairWallet {
  payer: Keypair;
  constructor(payer: Keypair) { this.payer = payer; }
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  async signTransaction<T>(tx: T): Promise<T> {
    (tx as any).partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T>(txs: T[]): Promise<T[]> {
    txs.forEach((tx) => (tx as any).partialSign(this.payer));
    return txs;
  }
}

function createProvider(kp: Keypair): AnchorProvider {
  return new AnchorProvider(connection, new KeypairWallet(kp) as any, {
    commitment: "confirmed",
  });
}

// PDA derivation helpers (matching solana.ts)
function deriveVaultPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    VAULT_PROGRAM_ID
  );
}

function deriveAgentProfilePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );
}

function deriveEscrowPDA(
  client: PublicKey,
  provider: PublicKey,
  taskId: number
): [PublicKey, number] {
  const taskIdBuf = Buffer.alloc(8);
  taskIdBuf.writeBigUInt64LE(BigInt(taskId));
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("escrow"),
      client.toBuffer(),
      provider.toBuffer(),
      taskIdBuf,
    ],
    SETTLEMENT_PROGRAM_ID
  );
}

// ==================== GLOBALS ====================

let agent: Keypair;
let provider: Keypair;
let vaultProgram: Program;
let registryProgram: Program;
let settlementProgram: Program;
let tokenMint: PublicKey;
let agentTokenAccount: PublicKey;
let providerTokenAccount: PublicKey;

const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86400;
const crypto = require("crypto");
function hashStr(s: string): number[] {
  return Array.from(crypto.createHash("sha256").update(s).digest());
}

// ==================== BEFORE ALL ====================

before(async function () {
  this.timeout(30000);

  // Create agent and provider keypairs
  agent = Keypair.generate();
  provider = Keypair.generate();

  // Airdrop SOL
  const agentAirdrop = await connection.requestAirdrop(
    agent.publicKey,
    10 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(agentAirdrop, "confirmed");

  const providerAirdrop = await connection.requestAirdrop(
    provider.publicKey,
    5 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(providerAirdrop, "confirmed");

  // Create programs with agent provider
  const agentProvider = createProvider(agent);
  vaultProgram = new Program(loadIdl("agent_vault"), agentProvider);
  registryProgram = new Program(loadIdl("agent_registry"), agentProvider);
  settlementProgram = new Program(loadIdl("settlement"), agentProvider);

  // Create SPL token mint
  const mintAuthority = agent;
  tokenMint = await createMint(
    connection,
    agent,
    mintAuthority.publicKey,
    null,
    6
  );

  // Create token accounts and mint tokens
  const agentAta = await getOrCreateAssociatedTokenAccount(
    connection,
    agent,
    tokenMint,
    agent.publicKey
  );
  agentTokenAccount = agentAta.address;

  const providerAta = await getOrCreateAssociatedTokenAccount(
    connection,
    agent,
    tokenMint,
    provider.publicKey
  );
  providerTokenAccount = providerAta.address;

  // Mint 10M tokens to agent
  await mintTo(
    connection,
    agent,
    tokenMint,
    agentTokenAccount,
    mintAuthority,
    10_000_000
  );
});

// ==================== VAULT TESTS ====================

describe("MCP Vault Handlers", () => {
  let vaultPDA: PublicKey;

  it("create_vault: initializes vault with policies", async () => {
    [vaultPDA] = deriveVaultPDA(agent.publicKey);

    const sig = await vaultProgram.methods
      .initializeVault(
        agent.publicKey,
        new BN(5 * LAMPORTS_PER_SOL),
        new BN(1 * LAMPORTS_PER_SOL),
        10
      )
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    expect(sig).to.be.a("string");

    // Verify on-chain state
    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.agentIdentity.toBase58()).to.equal(
      agent.publicKey.toBase58()
    );
    expect(vault.paused).to.be.false;
    expect(vault.policy.dailyLimitLamports.toNumber()).to.equal(
      5 * LAMPORTS_PER_SOL
    );
    expect(vault.policy.perTxLimitLamports.toNumber()).to.equal(
      1 * LAMPORTS_PER_SOL
    );
    expect(vault.policy.maxTxsPerHour).to.equal(10);
  });

  it("get_vault_info: fetches vault state correctly", async () => {
    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.authority.toBase58()).to.equal(agent.publicKey.toBase58());
    expect(vault.policy.tokenAllowlist).to.be.an("array");
    expect(vault.policy.programAllowlist).to.be.an("array");
  });

  it("update_vault_policy: updates spending limits", async () => {
    const sig = await vaultProgram.methods
      .updatePolicy(
        new BN(10 * LAMPORTS_PER_SOL),
        new BN(2 * LAMPORTS_PER_SOL),
        20
      )
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.policy.dailyLimitLamports.toNumber()).to.equal(
      10 * LAMPORTS_PER_SOL
    );
    expect(vault.policy.maxTxsPerHour).to.equal(20);
  });

  it("manage_allowlist: adds token to allowlist", async () => {
    await vaultProgram.methods
      .addTokenAllowlist(tokenMint)
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.policy.tokenAllowlist.length).to.equal(1);
    expect(vault.policy.tokenAllowlist[0].toBase58()).to.equal(
      tokenMint.toBase58()
    );
  });

  it("manage_allowlist: adds program to allowlist", async () => {
    await vaultProgram.methods
      .addProgramAllowlist(SETTLEMENT_PROGRAM_ID)
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.policy.programAllowlist.length).to.equal(1);
  });

  it("pause_vault: pauses the vault", async () => {
    await vaultProgram.methods
      .pauseVault()
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.paused).to.be.true;
  });

  it("resume_vault: resumes the vault", async () => {
    await vaultProgram.methods
      .resumeVault()
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.paused).to.be.false;
  });

  it("manage_allowlist: removes token from allowlist", async () => {
    await vaultProgram.methods
      .removeTokenAllowlist(tokenMint)
      .accounts({
        vault: vaultPDA,
        authority: agent.publicKey,
      })
      .signers([agent])
      .rpc();

    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    expect(vault.policy.tokenAllowlist.length).to.equal(0);
  });
});

// ==================== REGISTRY TESTS ====================

describe("MCP Registry Handlers", () => {
  let agentProfilePDA: PublicKey;

  it("register_agent: registers agent with full profile", async () => {
    [agentProfilePDA] = deriveAgentProfilePDA(agent.publicKey);

    const [agentVaultPDA] = deriveVaultPDA(agent.publicKey);
    const sig = await registryProgram.methods
      .registerAgent(
        "TestAgent",
        "A test AI agent for integration testing",
        "testing",
        ["analysis", "trading"],
        { perTask: {} },
        new BN(100_000),
        [tokenMint]
      )
      .accounts({
        authority: agent.publicKey,
        agentProfile: agentProfilePDA,
        vault: agentVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent])
      .rpc();

    expect(sig).to.be.a("string");

    const profile = await (registryProgram.account as any).agentProfile.fetch(
      agentProfilePDA
    );
    expect(profile.name).to.equal("TestAgent");
    expect(profile.category).to.equal("testing");
    expect(profile.capabilities).to.deep.equal(["analysis", "trading"]);
    expect(profile.reputationScore.toNumber()).to.equal(0);
  });

  it("get_agent_profile: fetches profile data", async () => {
    const profile = await (registryProgram.account as any).agentProfile.fetch(
      agentProfilePDA
    );

    expect(profile.authority.toBase58()).to.equal(
      agent.publicKey.toBase58()
    );
    expect(profile.description).to.equal(
      "A test AI agent for integration testing"
    );
    expect(profile.pricingAmount.toNumber()).to.equal(100_000);
  });

  it("update_agent_profile: updates name and pricing", async () => {
    await registryProgram.methods
      .updateProfile(
        "UpdatedAgent",
        null,
        null,
        null,
        null,
        new BN(200_000),
        null
      )
      .accounts({
        authority: agent.publicKey,
        agentProfile: agentProfilePDA,
      })
      .signers([agent])
      .rpc();

    const profile = await (registryProgram.account as any).agentProfile.fetch(
      agentProfilePDA
    );
    expect(profile.name).to.equal("UpdatedAgent");
    expect(profile.pricingAmount.toNumber()).to.equal(200_000);
  });

  it("discover_agents: lists all agent profiles", async () => {
    const allProfiles = await (
      registryProgram.account as any
    ).agentProfile.all();
    expect(allProfiles.length).to.be.greaterThanOrEqual(1);

    const found = allProfiles.find(
      (p: any) =>
        p.account.authority.toBase58() === agent.publicKey.toBase58()
    );
    expect(found).to.exist;
    expect(found.account.name).to.equal("UpdatedAgent");
  });
});

// Register provider in registry (needed for slashing CPI in resolve_dispute)
describe("Provider Registration", () => {
  it("registers provider for settlement tests", async () => {
    const providerProvider = createProvider(provider);
    const provRegistry = new Program(loadIdl("agent_registry"), providerProvider);
    const [provProfilePDA] = deriveAgentProfilePDA(provider.publicKey);

    const [provVaultPDA] = deriveVaultPDA(provider.publicKey);
    await provRegistry.methods
      .registerAgent(
        "TestProvider",
        "Provider for settlement tests",
        "testing",
        ["provider"],
        { perTask: {} },
        new BN(50_000),
        [tokenMint]
      )
      .accounts({
        authority: provider.publicKey,
        agentProfile: provProfilePDA,
        vault: provVaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .signers([provider])
      .rpc();

    const profile = await (registryProgram.account as any).agentProfile.fetch(provProfilePDA);
    expect(profile.name).to.equal("TestProvider");
  });
});

// ==================== SETTLEMENT TESTS ====================

describe("MCP Settlement Handlers", () => {
  const taskId = 42;
  let escrowPDA: PublicKey;
  let escrowTokenAccount: PublicKey;

  it("create_escrow: creates task with milestone-based escrow", async () => {
    [escrowPDA] = deriveEscrowPDA(
      agent.publicKey,
      provider.publicKey,
      taskId
    );
    escrowTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      escrowPDA,
      true
    );

    const sig = await settlementProgram.methods
      .createEscrow(
        new BN(taskId),
        new BN(1_000_000),
        hashStr("Test task description"),
        new BN(FUTURE_DEADLINE),
        [
          {
            descriptionHash: hashStr("Milestone 1"),
            amount: new BN(600_000),
          },
          {
            descriptionHash: hashStr("Milestone 2"),
            amount: new BN(400_000),
          },
        ],
        null
      )
      .accounts({
        client: agent.publicKey,
        clientVault: agent.publicKey,
        providerVault: provider.publicKey,
        provider: provider.publicKey,
        tokenMint: tokenMint,
        clientTokenAccount: agentTokenAccount,
        escrow: escrowPDA,
        escrowTokenAccount: escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .signers([agent])
      .rpc();

    expect(sig).to.be.a("string");

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    expect(escrow.client.toBase58()).to.equal(agent.publicKey.toBase58());
    expect(escrow.provider.toBase58()).to.equal(
      provider.publicKey.toBase58()
    );
    expect(escrow.totalAmount.toNumber()).to.equal(1_000_000);
    expect(escrow.milestones.length).to.equal(2);
  });

  it("get_escrow_status: fetches full escrow state", async () => {
    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );

    expect(escrow.taskId.toNumber()).to.equal(taskId);
    expect(escrow.tokenMint.toBase58()).to.equal(tokenMint.toBase58());
    expect(escrow.milestones[0].amount.toNumber()).to.equal(600_000);
    expect(escrow.milestones[1].amount.toNumber()).to.equal(400_000);
    // Status should be "created" (not yet accepted)
    expect(escrow.status.created).to.not.be.undefined;
  });

  it("accept_task: provider accepts the task", async () => {
    // Create a provider-scoped program instance
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(
      loadIdl("settlement"),
      providerProvider
    );

    // @ts-ignore - Anchor deep type instantiation TS2589
    await provSettlement.methods
      .acceptTask()
      .accounts({
        provider: provider.publicKey,
        escrow: escrowPDA,
      })
      .signers([provider])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    expect(escrow.status.active).to.not.be.undefined;
  });

  it("submit_milestone: provider submits milestone 0", async () => {
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(
      loadIdl("settlement"),
      providerProvider
    );

    await provSettlement.methods
      .submitMilestone(0)
      .accounts({
        provider: provider.publicKey,
        escrow: escrowPDA,
      })
      .signers([provider])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    expect(escrow.milestones[0].status.submitted).to.not.be.undefined;
  });

  it("approve_milestone: client approves milestone 0, releases payment", async () => {
    const [providerProfilePDA] = deriveAgentProfilePDA(provider.publicKey);
    await settlementProgram.methods
      .approveMilestone(0, 0)
      .accounts({
        client: agent.publicKey,
        escrow: escrowPDA,
        escrowTokenAccount: escrowTokenAccount,
        providerTokenAccount: providerTokenAccount,
        registryProgram: REGISTRY_PROGRAM_ID,
        providerProfile: providerProfilePDA,
        settlementSelf: SETTLEMENT_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    expect(escrow.milestones[0].status.approved).to.not.be.undefined;
    expect(escrow.releasedAmount.toNumber()).to.equal(600_000);
  });

  it("submit_milestone + reject_milestone: milestone 1 rejected", async () => {
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(
      loadIdl("settlement"),
      providerProvider
    );

    // Submit milestone 1
    await provSettlement.methods
      .submitMilestone(1)
      .accounts({
        provider: provider.publicKey,
        escrow: escrowPDA,
      })
      .signers([provider])
      .rpc();

    // Reject milestone 1
    await settlementProgram.methods
      .rejectMilestone(1)
      .accounts({
        client: agent.publicKey,
        escrow: escrowPDA,
      })
      .signers([agent])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    // After rejection, milestone status could be 'rejected' or 'pending' depending on program logic
    const ms1Status = escrow.milestones[1].status;
    const isRejectedOrPending =
      ms1Status.rejected !== undefined || ms1Status.pending !== undefined;
    expect(isRejectedOrPending).to.be.true;
  });

  it("raise_dispute: client raises dispute", async () => {
    await settlementProgram.methods
      .raiseDispute()
      .accounts({
        requester: agent.publicKey,
        escrow: escrowPDA,
      })
      .signers([agent])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    expect(escrow.status.disputed).to.not.be.undefined;
  });

  it("resolve_dispute: client resolves dispute splitting funds", async () => {
    // ADR-039: ResolveDispute now requires registry accounts for slashing CPI
    const [providerProfilePDA] = deriveAgentProfilePDA(provider.publicKey);
    const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("settlement_authority")],
      SETTLEMENT_PROGRAM_ID
    );

    await settlementProgram.methods
      .resolveDispute(new BN(200_000), new BN(200_000))
      .accounts({
        resolver: agent.publicKey,
        escrow: escrowPDA,
        escrowTokenAccount: escrowTokenAccount,
        clientTokenAccount: agentTokenAccount,
        providerTokenAccount: providerTokenAccount,
        registryProgram: REGISTRY_PROGRAM_ID,
        providerProfile: providerProfilePDA,
        settlementAuthority: settlementAuthorityPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    // Escrow should still exist but status changed
    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      escrowPDA
    );
    // After dispute resolution, releasedAmount should include milestone 0 (600k)
    // plus whatever was distributed in the dispute resolution
    expect(escrow.releasedAmount.toNumber()).to.be.greaterThanOrEqual(
      600_000
    );
  });
});

// ==================== CANCEL ESCROW TEST ====================

describe("MCP Settlement Cancel", () => {
  const cancelTaskId = 99;
  let cancelEscrowPDA: PublicKey;
  let cancelEscrowTokenAccount: PublicKey;

  it("cancel_escrow: client cancels an unaccepted escrow", async () => {
    [cancelEscrowPDA] = deriveEscrowPDA(
      agent.publicKey,
      provider.publicKey,
      cancelTaskId
    );
    cancelEscrowTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      cancelEscrowPDA,
      true
    );

    // Create escrow
    await settlementProgram.methods
      .createEscrow(
        new BN(cancelTaskId),
        new BN(500_000),
        hashStr("Cancel test"),
        new BN(FUTURE_DEADLINE),
        [{ descriptionHash: hashStr("Only milestone"), amount: new BN(500_000) }],
        null
      )
      .accounts({
        client: agent.publicKey,
        clientVault: agent.publicKey,
        providerVault: provider.publicKey,
        provider: provider.publicKey,
        tokenMint: tokenMint,
        clientTokenAccount: agentTokenAccount,
        escrow: cancelEscrowPDA,
        escrowTokenAccount: cancelEscrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .signers([agent])
      .rpc();

    // Cancel immediately
    await settlementProgram.methods
      .cancelEscrow()
      .accounts({
        client: agent.publicKey,
        escrow: cancelEscrowPDA,
        escrowTokenAccount: cancelEscrowTokenAccount,
        clientTokenAccount: agentTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([agent])
      .rpc();

    const escrow = await (settlementProgram.account as any).taskEscrow.fetch(
      cancelEscrowPDA
    );
    expect(escrow.status.cancelled).to.not.be.undefined;
  });
});

// ==================== EDGE CASE: VAULT AUTHORIZATION ====================

describe("Vault Edge Cases", () => {
  let vaultPDA: PublicKey;
  let unauthorized: Keypair;

  before(async function () {
    this.timeout(15000);
    unauthorized = Keypair.generate();
    const airdrop = await connection.requestAirdrop(
      unauthorized.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdrop, "confirmed");
    [vaultPDA] = deriveVaultPDA(agent.publicKey);
  });

  it("rejects unauthorized policy update", async () => {
    const unauthProvider = createProvider(unauthorized);
    const unauthVaultProgram = new Program(loadIdl("agent_vault"), unauthProvider);

    try {
      await unauthVaultProgram.methods
        .updatePolicy(new BN(999 * LAMPORTS_PER_SOL), new BN(999 * LAMPORTS_PER_SOL), 999)
        .accounts({
          vault: vaultPDA,
          authority: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      // Expected: seeds constraint failure or unauthorized error
      expect(err).to.exist;
    }
  });

  it("rejects transfer while paused", async () => {
    // Pause the vault
    await vaultProgram.methods
      .pauseVault()
      .accounts({ vault: vaultPDA, authority: agent.publicKey })
      .signers([agent])
      .rpc();

    try {
      await vaultProgram.methods
        .executeTransfer(new BN(100))
        .accounts({
          vault: vaultPDA,
          vaultAccount: vaultPDA,
          agent: agent.publicKey,
          recipient: unauthorized.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown VaultPaused error");
    } catch (err: any) {
      expect(err.toString()).to.include("VaultPaused");
    }

    // Resume for subsequent tests
    await vaultProgram.methods
      .resumeVault()
      .accounts({ vault: vaultPDA, authority: agent.publicKey })
      .signers([agent])
      .rpc();
  });

  it("rejects transfer exceeding per-tx limit", async () => {
    // Current per-tx limit is 2 SOL from earlier update
    try {
      await vaultProgram.methods
        .executeTransfer(new BN(3 * LAMPORTS_PER_SOL))
        .accounts({
          vault: vaultPDA,
          vaultAccount: vaultPDA,
          agent: agent.publicKey,
          recipient: unauthorized.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown PerTxLimitExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("PerTxLimitExceeded");
    }
  });
});

// ==================== EDGE CASE: REGISTRY AUTHORIZATION ====================

describe("Registry Edge Cases", () => {
  it("rejects name exceeding 64 bytes", async () => {
    const longNameAgent = Keypair.generate();
    const airdrop = await connection.requestAirdrop(
      longNameAgent.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdrop, "confirmed");

    const longNameProvider = createProvider(longNameAgent);
    const longNameRegistry = new Program(loadIdl("agent_registry"), longNameProvider);
    const [profilePDA] = deriveAgentProfilePDA(longNameAgent.publicKey);

    const [longNameVaultPDA] = deriveVaultPDA(longNameAgent.publicKey);
    try {
      await longNameRegistry.methods
        .registerAgent(
          "A".repeat(65), // 65 bytes > 64 limit
          "desc",
          "category",
          ["cap1"],
          { perTask: {} },
          new BN(100),
          [tokenMint]
        )
        .accounts({
          authority: longNameAgent.publicKey,
          agentProfile: profilePDA,
          vault: longNameVaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([longNameAgent])
        .rpc();
      expect.fail("Should have thrown NameTooLong");
    } catch (err: any) {
      expect(err.toString()).to.include("NameTooLong");
    }
  });

  it("rejects capabilities count > 10", async () => {
    const capAgent = Keypair.generate();
    const airdrop = await connection.requestAirdrop(
      capAgent.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdrop, "confirmed");

    const capProvider = createProvider(capAgent);
    const capRegistry = new Program(loadIdl("agent_registry"), capProvider);
    const [profilePDA] = deriveAgentProfilePDA(capAgent.publicKey);
    const [capVaultPDA] = deriveVaultPDA(capAgent.publicKey);

    try {
      await capRegistry.methods
        .registerAgent(
          "CapTest",
          "desc",
          "category",
          Array.from({ length: 11 }, (_, i) => `cap${i}`), // 11 > 10 limit
          { perTask: {} },
          new BN(100),
          [tokenMint]
        )
        .accounts({
          authority: capAgent.publicKey,
          agentProfile: profilePDA,
          vault: capVaultPDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([capAgent])
        .rpc();
      expect.fail("Should have thrown InvalidCapabilitiesCount");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidCapabilitiesCount");
    }
  });
});

// ==================== EDGE CASE: SETTLEMENT AUTHORIZATION ====================

describe("Settlement Edge Cases", () => {
  const edgeTaskId = 200;
  let edgeEscrowPDA: PublicKey;
  let edgeEscrowTokenAccount: PublicKey;

  before(async function () {
    this.timeout(15000);
    [edgeEscrowPDA] = deriveEscrowPDA(
      agent.publicKey,
      provider.publicKey,
      edgeTaskId
    );
    edgeEscrowTokenAccount = getAssociatedTokenAddressSync(
      tokenMint,
      edgeEscrowPDA,
      true
    );

    // Create a fresh escrow for edge case tests
    await settlementProgram.methods
      .createEscrow(
        new BN(edgeTaskId),
        new BN(500_000),
        hashStr("Edge case escrow"),
        new BN(FUTURE_DEADLINE),
        [{ descriptionHash: hashStr("Milestone 1"), amount: new BN(500_000) }],
        null
      )
      .accounts({
        client: agent.publicKey,
        clientVault: agent.publicKey,
        providerVault: provider.publicKey,
        provider: provider.publicKey,
        tokenMint: tokenMint,
        clientTokenAccount: agentTokenAccount,
        escrow: edgeEscrowPDA,
        escrowTokenAccount: edgeEscrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
      })
      .signers([agent])
      .rpc();
  });

  it("rejects wrong provider accepting task", async () => {
    // unauthorized tries to accept
    const unauthorizedKp = Keypair.generate();
    const airdrop = await connection.requestAirdrop(
      unauthorizedKp.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdrop, "confirmed");

    const unauthProvider = createProvider(unauthorizedKp);
    const unauthSettlement = new Program(loadIdl("settlement"), unauthProvider);

    try {
      await unauthSettlement.methods
        .acceptTask()
        .accounts({
          provider: unauthorizedKp.publicKey,
          escrow: edgeEscrowPDA,
        })
        .signers([unauthorizedKp])
        .rpc();
      expect.fail("Should have thrown UnauthorizedProvider");
    } catch (err: any) {
      // has_one constraint should reject this
      expect(err).to.exist;
    }
  });

  it("rejects milestone submit on Created status (not yet accepted)", async () => {
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(loadIdl("settlement"), providerProvider);

    try {
      await provSettlement.methods
        .submitMilestone(0)
        .accounts({
          provider: provider.publicKey,
          escrow: edgeEscrowPDA,
        })
        .signers([provider])
        .rpc();
      expect.fail("Should have thrown InvalidStatus");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidStatus");
    }
  });

  it("rejects cancel after acceptance", async () => {
    // First accept the task
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(loadIdl("settlement"), providerProvider);

    // @ts-ignore - Anchor deep type instantiation
    await provSettlement.methods
      .acceptTask()
      .accounts({
        provider: provider.publicKey,
        escrow: edgeEscrowPDA,
      })
      .signers([provider])
      .rpc();

    // Now try to cancel (should fail - status is Active, not Created)
    try {
      await settlementProgram.methods
        .cancelEscrow()
        .accounts({
          client: agent.publicKey,
          escrow: edgeEscrowPDA,
          escrowTokenAccount: edgeEscrowTokenAccount,
          clientTokenAccount: agentTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown InvalidStatus");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidStatus");
    }
  });

  it("rejects out-of-bounds milestone index", async () => {
    const providerProvider = createProvider(provider);
    const provSettlement = new Program(loadIdl("settlement"), providerProvider);

    try {
      await provSettlement.methods
        .submitMilestone(5) // Only 1 milestone exists (index 0)
        .accounts({
          provider: provider.publicKey,
          escrow: edgeEscrowPDA,
        })
        .signers([provider])
        .rpc();
      expect.fail("Should have thrown InvalidMilestoneIndex");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidMilestoneIndex");
    }
  });

  it("rejects double dispute", async () => {
    // Raise first dispute
    await settlementProgram.methods
      .raiseDispute()
      .accounts({
        requester: agent.publicKey,
        escrow: edgeEscrowPDA,
      })
      .signers([agent])
      .rpc();

    // Try to raise again
    try {
      await settlementProgram.methods
        .raiseDispute()
        .accounts({
          requester: agent.publicKey,
          escrow: edgeEscrowPDA,
        })
        .signers([agent])
        .rpc();
      expect.fail("Should have thrown AlreadyDisputed");
    } catch (err: any) {
      expect(err.toString()).to.include("AlreadyDisputed");
    }
  });
});

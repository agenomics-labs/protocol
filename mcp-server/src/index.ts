import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, ToolName } from "./tools.js";
import {
  getConnection,
  loadWallet,
  getWalletPublicKey,
  getProvider,
  getVaultProgram,
  getRegistryProgram,
  getSettlementProgram,
  deriveVaultPDA,
  deriveAgentProfilePDA,
  deriveEscrowPDA,
  deriveEscrowTokenAccount,
  getAssociatedTokenAddressSync,
  isValidPublicKey,
  parsePublicKey,
  solToLamports,
  lamportsToSol,
  hashDescription,
  BN,
  PublicKey,
  LAMPORTS_PER_SOL,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  REGISTRY_PROGRAM_ID,
  SETTLEMENT_PROGRAM_ID,
} from "./solana.js";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

/**
 * Agenomics MCP Server - Main Entry Point
 *
 * Exposes the Agenomics Protocol on Solana
 * to any AI agent through the Model Context Protocol.
 *
 * Three on-chain programs are accessible:
 * 1. Agent Vault - Programmable wallets with spending policies
 * 2. Agent Registry - Discovery and reputation system
 * 3. Settlement Protocol - Escrow and milestone-based payments
 */

// ==================== INPUT VALIDATION HELPERS ====================

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected non-empty string)`);
  }
  return v;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || isNaN(v)) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected number)`);
  }
  return v;
}

function requirePositiveNumber(args: Record<string, unknown>, key: string): number {
  const v = requireNumber(args, key);
  if (v <= 0) {
    throw new Error(`Parameter ${key} must be greater than zero`);
  }
  return v;
}

function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`Missing or invalid required parameter: ${key} (expected non-empty array)`);
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") {
      throw new Error(`Parameter ${key}[${i}] must be a string`);
    }
  }
  return v as string[];
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`Parameter ${key} must be a string if provided`);
  return v;
}

const server = new Server(
  { name: "aeap-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ==================== TOOL LISTING ====================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

// ==================== TOOL DISPATCH ====================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name as ToolName;
  const args = request.params.arguments as Record<string, unknown>;

  try {
    let result: unknown;

    switch (toolName) {
      // Vault
      case "create_vault":
        result = await handleCreateVault(args);
        break;
      case "get_vault_info":
        result = await handleGetVaultInfo(args);
        break;
      case "vault_transfer":
        result = await handleVaultTransfer(args);
        break;
      case "vault_token_transfer":
        result = await handleVaultTokenTransfer(args);
        break;
      case "update_vault_policy":
        result = await handleUpdateVaultPolicy(args);
        break;
      case "pause_vault":
        result = await handlePauseVault();
        break;
      case "resume_vault":
        result = await handleResumeVault();
        break;
      case "manage_allowlist":
        result = await handleManageAllowlist(args);
        break;
      // Registry
      case "register_agent":
        result = await handleRegisterAgent(args);
        break;
      case "get_agent_profile":
        result = await handleGetAgentProfile(args);
        break;
      case "update_agent_profile":
        result = await handleUpdateAgentProfile(args);
        break;
      case "discover_agents":
        result = await handleDiscoverAgents(args);
        break;
      case "stake_reputation":
        result = await handleStakeReputation(args);
        break;
      // Settlement
      case "create_escrow":
        result = await handleCreateEscrow(args);
        break;
      case "accept_task":
        result = await handleAcceptTask(args);
        break;
      case "submit_milestone":
        result = await handleSubmitMilestone(args);
        break;
      case "approve_milestone":
        result = await handleApproveMilestone(args);
        break;
      case "reject_milestone":
        result = await handleRejectMilestone(args);
        break;
      case "get_escrow_status":
        result = await handleGetEscrowStatus(args);
        break;
      case "cancel_escrow":
        result = await handleCancelEscrow(args);
        break;
      case "raise_dispute":
        result = await handleRaiseDispute(args);
        break;
      case "resolve_dispute":
        result = await handleResolveDispute(args);
        break;
      case "resolve_dispute_timeout":
        result = await handleResolveDisputeTimeout(args);
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        } as TextContent,
      ],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage, tool: toolName }, null, 2),
        } as TextContent,
      ],
      isError: true,
    };
  }
});

// ==================== VAULT HANDLERS ====================

/**
 * Initialize a new vault for this agent.
 * Seeds: ["vault", authority] → vault PDA
 */
async function handleCreateVault(args: Record<string, unknown>) {
  const agentIdentity = parsePublicKey(requireString(args, "agentIdentity"));
  const dailyLimitSol = requirePositiveNumber(args, "dailyLimitSol");
  const perTxLimitSol = requirePositiveNumber(args, "perTxLimitSol");
  const maxTxsPerHour = requireNumber(args, "maxTxsPerHour");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .initializeVault(
      agentIdentity,
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour
    )
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    agentIdentity: agentIdentity.toBase58(),
    policies: { dailyLimitSol, perTxLimitSol, maxTxsPerHour },
    transactionSignature: sig,
  };
}

/**
 * Fetch vault account state from chain.
 */
async function handleGetVaultInfo(args: Record<string, unknown>) {
  const program = getVaultProgram();
  let vaultAddress: PublicKey;

  if (args.vaultAddress && typeof args.vaultAddress === "string") {
    vaultAddress = parsePublicKey(args.vaultAddress);
  } else {
    const wallet = loadWallet();
    [vaultAddress] = deriveVaultPDA(wallet.publicKey);
  }

  const vault = await (program.account as any).vault.fetch(vaultAddress);
  const conn = getConnection();
  const balanceLamports = await conn.getBalance(vaultAddress);

  return {
    vaultAddress: vaultAddress.toBase58(),
    balanceSol: lamportsToSol(balanceLamports),
    agentIdentity: (vault.agentIdentity as PublicKey).toBase58(),
    authority: (vault.authority as PublicKey).toBase58(),
    paused: vault.paused as boolean,
    spentTodaySol: lamportsToSol(
      (vault.spentTodayLamports as any).toNumber()
    ),
    lastSpendDay: (vault.lastSpendDay as any).toNumber(),
    policies: {
      dailyLimitSol: lamportsToSol(
        (vault.policy as any).dailyLimitLamports.toNumber()
      ),
      perTxLimitSol: lamportsToSol(
        (vault.policy as any).perTxLimitLamports.toNumber()
      ),
      maxTxsPerHour: (vault.policy as any).maxTxsPerHour,
      tokenAllowlist: (vault.policy as any).tokenAllowlist.map(
        (pk: PublicKey) => pk.toBase58()
      ),
      programAllowlist: (vault.policy as any).programAllowlist.map(
        (pk: PublicKey) => pk.toBase58()
      ),
    },
    txsInCurrentWindow: (vault.txsInCurrentWindow as any),
    rateLimitWindowStart: (vault.rateLimitWindowStart as any).toNumber(),
  };
}

/**
 * Transfer SOL from the vault to a recipient.
 */
async function handleVaultTransfer(args: Record<string, unknown>) {
  const recipientAddress = parsePublicKey(requireString(args, "recipientAddress"));
  const amountSol = requirePositiveNumber(args, "amountSol");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .executeTransfer(new BN(solToLamports(amountSol)))
    .accounts({
      vault: vaultPDA,
      agent: wallet.publicKey,
      recipient: recipientAddress,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    recipient: recipientAddress.toBase58(),
    amountSol,
    transactionSignature: sig,
  };
}

/**
 * Update the vault's spending policy.
 */
async function handleUpdateVaultPolicy(args: Record<string, unknown>) {
  const dailyLimitSol = requirePositiveNumber(args, "dailyLimitSol");
  const perTxLimitSol = requirePositiveNumber(args, "perTxLimitSol");
  const maxTxsPerHour = requireNumber(args, "maxTxsPerHour");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .updatePolicy(
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour
    )
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    newPolicies: { dailyLimitSol, perTxLimitSol, maxTxsPerHour },
    transactionSignature: sig,
  };
}

/**
 * Pause the vault.
 */
async function handlePauseVault() {
  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .pauseVault()
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    paused: true,
    transactionSignature: sig,
  };
}

/**
 * Resume the vault.
 */
async function handleResumeVault() {
  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .resumeVault()
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    paused: false,
    transactionSignature: sig,
  };
}

/**
 * Add/remove token or program from the vault's allowlist.
 */
async function handleManageAllowlist(args: Record<string, unknown>) {
  const action = requireString(args, "action");
  const address = parsePublicKey(requireString(args, "address"));

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  let sig: string;
  const accounts = {
    vault: vaultPDA,
    authority: wallet.publicKey,
  };

  switch (action) {
    case "add_token":
      sig = await program.methods
        .addTokenAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    case "remove_token":
      sig = await program.methods
        .removeTokenAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    case "add_program":
      sig = await program.methods
        .addProgramAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    case "remove_program":
      sig = await program.methods
        .removeProgramAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    default:
      throw new Error(
        `Unknown action: ${action}. Use add_token, remove_token, add_program, or remove_program.`
      );
  }

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    action,
    address: address.toBase58(),
    transactionSignature: sig,
  };
}

// ==================== REGISTRY HANDLERS ====================

/**
 * Register this agent in the on-chain registry.
 */
async function handleRegisterAgent(args: Record<string, unknown>) {
  const name = requireString(args, "name");
  const description = requireString(args, "description");
  const category = requireString(args, "category");
  const capabilities = requireStringArray(args, "capabilities");
  const pricingModelStr = requireString(args, "pricingModel");
  const pricingAmountSol = requirePositiveNumber(args, "pricingAmountSol");
  const acceptedTokens = requireStringArray(args, "acceptedTokens").map((t) =>
    parsePublicKey(t)
  );
  const vaultAddress = parsePublicKey(requireString(args, "vaultAddress"));

  // Map string to Anchor enum
  const pricingModel = mapPricingModel(pricingModelStr);

  const wallet = loadWallet();
  const program = getRegistryProgram();
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey);

  const sig = await program.methods
    .registerAgent(
      name,
      description,
      category,
      capabilities,
      pricingModel,
      new BN(solToLamports(pricingAmountSol)),
      acceptedTokens,
      vaultAddress
    )
    .accounts({
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    agentProfileAddress: agentProfilePDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    name,
    category,
    capabilities,
    transactionSignature: sig,
  };
}

/**
 * Fetch an agent's profile from the registry.
 */
async function handleGetAgentProfile(args: Record<string, unknown>) {
  const program = getRegistryProgram();

  let authorityKey: PublicKey;
  if (args.agentAddress && typeof args.agentAddress === "string") {
    authorityKey = parsePublicKey(args.agentAddress);
  } else {
    authorityKey = getWalletPublicKey();
  }

  const [agentProfilePDA] = deriveAgentProfilePDA(authorityKey);
  const profile = await (program.account as any).agentProfile.fetch(agentProfilePDA);

  return {
    agentProfileAddress: agentProfilePDA.toBase58(),
    authority: (profile.authority as PublicKey).toBase58(),
    name: profile.name as string,
    description: profile.description as string,
    category: profile.category as string,
    capabilities: profile.capabilities as string[],
    pricingModel: formatPricingModel(profile.pricingModel),
    pricingAmountSol: lamportsToSol(
      (profile.pricingAmount as any).toNumber()
    ),
    acceptedTokens: (profile.acceptedTokens as PublicKey[]).map((pk) =>
      pk.toBase58()
    ),
    vaultAddress: (profile.vaultAddress as PublicKey).toBase58(),
    status: formatAgentStatus(profile.status),
    reputationScore: (profile.reputationScore as any).toNumber(),
    totalTasksCompleted: (profile.totalTasksCompleted as any).toNumber(),
    totalEarningsSol: lamportsToSol(
      (profile.totalEarnings as any).toNumber()
    ),
    avgRating: profile.avgRating as number,
    createdAt: (profile.createdAt as any).toNumber(),
    updatedAt: (profile.updatedAt as any).toNumber(),
  };
}

/**
 * Update this agent's profile.
 */
async function handleUpdateAgentProfile(args: Record<string, unknown>) {
  const wallet = loadWallet();
  const program = getRegistryProgram();
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey);

  // Map optional fields — Anchor expects null for unset Options
  const name = (args.name as string) || null;
  const description = (args.description as string) || null;
  const category = (args.category as string) || null;
  const capabilities = (args.capabilities as string[]) || null;
  const pricingModel = args.pricingModel
    ? mapPricingModel(args.pricingModel as string)
    : null;
  const pricingAmount = args.pricingAmountSol
    ? new BN(solToLamports(args.pricingAmountSol as number))
    : null;
  const acceptedTokens = args.acceptedTokens
    ? (args.acceptedTokens as string[]).map((t) => parsePublicKey(t))
    : null;
  const vaultAddress = args.vaultAddress
    ? parsePublicKey(args.vaultAddress as string)
    : null;

  const sig = await program.methods
    .updateProfile(
      name,
      description,
      category,
      capabilities,
      pricingModel,
      pricingAmount,
      acceptedTokens,
      vaultAddress
    )
    .accounts({
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    agentProfileAddress: agentProfilePDA.toBase58(),
    transactionSignature: sig,
  };
}

/**
 * Discover agents in the registry.
 *
 * Fetches all agent profiles and applies client-side filtering.
 * Previous versions used a memcmp filter at offset 998 for the status field,
 * but the offset was fragile and broke across Anchor/schema changes (ADR-042).
 */
async function handleDiscoverAgents(args: Record<string, unknown>) {
  const program = getRegistryProgram();
  const limit = (args.limit as number) || 20;

  // Fetch all profiles — filtering is done client-side to avoid fragile memcmp offsets
  const allProfiles: any[] = await (program.account as any).agentProfile.all();

  let filtered = allProfiles.map((item: any) => {
    const p = item.account;
    return {
      address: item.publicKey.toBase58(),
      authority: (p.authority as PublicKey).toBase58(),
      name: p.name as string,
      description: p.description as string,
      category: p.category as string,
      capabilities: p.capabilities as string[],
      pricingModel: formatPricingModel(p.pricingModel),
      pricingAmountSol: lamportsToSol((p.pricingAmount as any).toNumber()),
      status: formatAgentStatus(p.status),
      reputationScore: (p.reputationScore as any).toNumber(),
      totalTasksCompleted: (p.totalTasksCompleted as any).toNumber(),
      avgRating: p.avgRating as number,
    };
  });

  // Filter to active agents by default (client-side, no fragile memcmp)
  if (!args.includeInactive) {
    filtered = filtered.filter((a) => a.status === "active");
  }

  // Apply client-side filters
  if (args.category && typeof args.category === "string") {
    filtered = filtered.filter((a) => a.category === args.category);
  }
  if (args.capability && typeof args.capability === "string") {
    const cap = (args.capability as string).toLowerCase();
    filtered = filtered.filter((a) =>
      a.capabilities.some((c: string) => c.toLowerCase().includes(cap))
    );
  }
  if (args.minReputation && typeof args.minReputation === "number") {
    filtered = filtered.filter(
      (a) => a.reputationScore >= (args.minReputation as number)
    );
  }

  // Sort by reputation descending
  filtered.sort((a, b) => b.reputationScore - a.reputationScore);

  return {
    agents: filtered.slice(0, limit),
    totalFound: filtered.length,
    limit,
  };
}

// ==================== SETTLEMENT HANDLERS ====================

/**
 * Create a new escrow for a task.
 * Locks payment tokens in escrow. The escrow uses an ATA derived from the escrow PDA.
 */
async function handleCreateEscrow(args: Record<string, unknown>) {
  const providerAddress = parsePublicKey(requireString(args, "providerAddress"));
  const providerVaultAddress = parsePublicKey(requireString(args, "providerVaultAddress"));
  const tokenMintAddress = parsePublicKey(requireString(args, "tokenMintAddress"));
  const taskId = requireNumber(args, "taskId");
  const totalAmountTokens = requirePositiveNumber(args, "totalAmountTokens");
  const taskDescription = requireString(args, "taskDescription");
  const deadlineUnix = requireNumber(args, "deadlineUnix");
  const milestones = args.milestones as Array<{
    description: string;
    amount: number;
  }>;
  if (!Array.isArray(milestones) || milestones.length === 0 || milestones.length > 5) {
    throw new Error("milestones must be an array with 1-5 entries");
  }
  const disputeResolverAddress = optionalString(args, "disputeResolverAddress")
    ? parsePublicKey(args.disputeResolverAddress as string)
    : null;

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // Derive PDAs
  const [escrowPDA] = deriveEscrowPDA(
    wallet.publicKey,
    providerAddress,
    taskId
  );
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowPDA,
    tokenMintAddress
  );

  // Build description hash
  const descriptionHash = hashDescription(taskDescription);

  // Build milestone data
  const milestonesData = milestones.map((m) => ({
    descriptionHash: hashDescription(m.description),
    amount: new BN(m.amount),
  }));

  // Derive client's ATA for the token mint
  const clientTokenAccount = getAssociatedTokenAddressSync(tokenMintAddress, wallet.publicKey);

  const sig = await program.methods
    .createEscrow(
      new BN(taskId),
      new BN(totalAmountTokens),
      descriptionHash,
      new BN(deadlineUnix),
      milestonesData,
      disputeResolverAddress
    )
    .accounts({
      client: wallet.publicKey,
      clientVault: wallet.publicKey,
      providerVault: providerVaultAddress,
      provider: providerAddress,
      tokenMint: tokenMintAddress,
      clientTokenAccount: clientTokenAccount,
      escrow: escrowPDA,
      escrowTokenAccount: escrowTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowPDA.toBase58(),
    escrowTokenAccount: escrowTokenAccount.toBase58(),
    client: wallet.publicKey.toBase58(),
    provider: providerAddress.toBase58(),
    taskId,
    totalAmountTokens,
    milestoneCount: milestones.length,
    deadline: new Date(deadlineUnix * 1000).toISOString(),
    transactionSignature: sig,
  };
}

/**
 * Accept a task as the provider.
 */
async function handleAcceptTask(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .acceptTask()
    .accounts({
      provider: wallet.publicKey,
      escrow: escrowAddress,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    provider: wallet.publicKey.toBase58(),
    status: "active",
    transactionSignature: sig,
  };
}

/**
 * Submit a milestone as the provider.
 */
async function handleSubmitMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .submitMilestone(milestoneIndex)
    .accounts({
      provider: wallet.publicKey,
      escrow: escrowAddress,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    milestoneIndex,
    status: "submitted",
    transactionSignature: sig,
  };
}

/**
 * Approve a milestone as the client. Releases payment to provider.
 */
async function handleApproveMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");
  const providerTokenAccount = parsePublicKey(
    requireString(args, "providerTokenAccount")
  );

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // Fetch escrow to get the token account info and provider
  const escrow = await (program.account as any).taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint as PublicKey;
  const provider = escrow.provider as PublicKey;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );

  // Derive provider's AgentProfile PDA for CPI reputation update
  const [providerProfilePDA] = deriveAgentProfilePDA(provider);

  // Derive settlement_authority PDA: seeds = ["settlement_authority"] from Settlement program
  const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  const sig = await program.methods
    .approveMilestone(milestoneIndex)
    .accounts({
      client: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      providerTokenAccount: providerTokenAccount,
      registryProgram: REGISTRY_PROGRAM_ID,
      providerProfile: providerProfilePDA,
      settlementAuthority: settlementAuthorityPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    milestoneIndex,
    status: "approved",
    transactionSignature: sig,
  };
}

/**
 * Reject a milestone as the client.
 */
async function handleRejectMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .rejectMilestone(milestoneIndex)
    .accounts({
      client: wallet.publicKey,
      escrow: escrowAddress,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    milestoneIndex,
    status: "rejected",
    transactionSignature: sig,
  };
}

/**
 * Fetch escrow account data.
 */
async function handleGetEscrowStatus(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const program = getSettlementProgram();

  const escrow = await (program.account as any).taskEscrow.fetch(escrowAddress);

  // Map milestone statuses
  const milestones = (escrow.milestones as any[]).map((m: any, i: number) => ({
    index: i,
    descriptionHash: Array.from(m.descriptionHash),
    amount: m.amount.toNumber(),
    status: formatMilestoneStatus(m.status),
  }));

  return {
    escrowAddress: escrowAddress.toBase58(),
    client: (escrow.client as PublicKey).toBase58(),
    provider: (escrow.provider as PublicKey).toBase58(),
    clientVault: (escrow.clientVault as PublicKey).toBase58(),
    providerVault: (escrow.providerVault as PublicKey).toBase58(),
    tokenMint: (escrow.tokenMint as PublicKey).toBase58(),
    totalAmount: (escrow.totalAmount as any).toNumber(),
    releasedAmount: (escrow.releasedAmount as any).toNumber(),
    status: formatEscrowStatus(escrow.status),
    taskId: (escrow.taskId as any).toNumber(),
    createdAt: (escrow.createdAt as any).toNumber(),
    deadline: (escrow.deadline as any).toNumber(),
    deadlineFormatted: new Date(
      (escrow.deadline as any).toNumber() * 1000
    ).toISOString(),
    disputeResolver: escrow.disputeResolver
      ? (escrow.disputeResolver as PublicKey).toBase58()
      : null,
    milestones,
  };
}

/**
 * Cancel an escrow (client only). Returns tokens to client.
 */
async function handleCancelEscrow(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // Fetch escrow to get token accounts
  const escrow = await (program.account as any).taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint as PublicKey;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );
  const clientTokenAccount = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

  const sig = await program.methods
    .cancelEscrow()
    .accounts({
      client: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      clientTokenAccount: clientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    status: "cancelled",
    transactionSignature: sig,
  };
}

/**
 * Raise a dispute on an active escrow.
 */
async function handleRaiseDispute(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .raiseDispute()
    .accounts({
      requester: wallet.publicKey,
      escrow: escrowAddress,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    requester: wallet.publicKey.toBase58(),
    status: "disputed",
    transactionSignature: sig,
  };
}

/**
 * Resolve a dispute by splitting escrowed funds.
 */
async function handleResolveDispute(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const clientRefund = new BN(requireNumber(args, "clientRefundTokens"));
  const providerRefund = new BN(requireNumber(args, "providerPaymentTokens"));
  const clientTokenAccount = parsePublicKey(
    requireString(args, "clientTokenAccount")
  );
  const providerTokenAccount = parsePublicKey(
    requireString(args, "providerTokenAccount")
  );

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // Get escrow token account and provider for PDA derivation
  const escrow = await (program.account as any).taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint as PublicKey;
  const provider = escrow.provider as PublicKey;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );

  // Derive provider's AgentProfile PDA for CPI reputation update
  const [providerProfilePDA] = PublicKey.findProgramAddressSync(
    [provider.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );

  // Derive settlement_authority PDA
  const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  const sig = await program.methods
    .resolveDispute(clientRefund, providerRefund)
    .accounts({
      resolver: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      clientTokenAccount: clientTokenAccount,
      providerTokenAccount: providerTokenAccount,
      registryProgram: REGISTRY_PROGRAM_ID,
      providerProfile: providerProfilePDA,
      settlementAuthority: settlementAuthorityPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    clientRefund: (args.clientRefundTokens as number),
    providerPayment: (args.providerPaymentTokens as number),
    status: "resolved",
    transactionSignature: sig,
  };
}

// ==================== ADDITIONAL VAULT HANDLERS ====================

/**
 * Execute an SPL token transfer from the vault.
 * Derives the vault's ATA for the given mint and transfers tokens to the recipient.
 */
async function handleVaultTokenTransfer(args: Record<string, unknown>) {
  const tokenMintAddress = parsePublicKey(requireString(args, "tokenMintAddress"));
  const recipientTokenAccount = parsePublicKey(requireString(args, "recipientTokenAccount"));
  const amount = requirePositiveNumber(args, "amount");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  // Derive the vault's ATA for this token mint
  const vaultTokenAccount = getAssociatedTokenAddressSync(tokenMintAddress, vaultPDA, true);

  const sig = await program.methods
    .executeTokenTransfer(new BN(amount))
    .accounts({
      vault: vaultPDA,
      agent: wallet.publicKey,
      vaultTokenAccount: vaultTokenAccount,
      recipientTokenAccount: recipientTokenAccount,
      tokenMint: tokenMintAddress,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    tokenMint: tokenMintAddress.toBase58(),
    recipientTokenAccount: recipientTokenAccount.toBase58(),
    amount,
    transactionSignature: sig,
  };
}

// ==================== ADDITIONAL REGISTRY HANDLERS ====================

/**
 * Stake SOL for agent reputation.
 * Derives a staking PDA from seeds=[authority, "reputation-stake"].
 */
async function handleStakeReputation(args: Record<string, unknown>) {
  const amount = requirePositiveNumber(args, "amount");

  const wallet = loadWallet();
  const program = getRegistryProgram();
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey);

  // Derive staking PDA: seeds=[authority, "reputation-stake"]
  const [stakingPDA] = PublicKey.findProgramAddressSync(
    [wallet.publicKey.toBuffer(), Buffer.from("reputation-stake")],
    REGISTRY_PROGRAM_ID
  );

  const sig = await program.methods
    .stakeReputation(new BN(solToLamports(amount)))
    .accounts({
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
      stakingAccount: stakingPDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    agentProfileAddress: agentProfilePDA.toBase58(),
    stakingAccount: stakingPDA.toBase58(),
    amountSol: amount,
    transactionSignature: sig,
  };
}

// ==================== ADDITIONAL SETTLEMENT HANDLERS ====================

/**
 * Auto-resolve a dispute that has exceeded the escrow deadline.
 * Anyone can call this once the timeout has elapsed.
 */
async function handleResolveDisputeTimeout(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // Fetch escrow to get token accounts and parties
  const escrow = await (program.account as any).taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint as PublicKey;
  const client = escrow.client as PublicKey;
  const provider = escrow.provider as PublicKey;
  const escrowTokenAccount = deriveEscrowTokenAccount(escrowAddress, tokenMint);

  // Derive ATAs for client and provider
  const clientTokenAccount = getAssociatedTokenAddressSync(tokenMint, client);
  const providerTokenAccount = getAssociatedTokenAddressSync(tokenMint, provider);

  const sig = await program.methods
    .resolveDisputeTimeout()
    .accounts({
      caller: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      clientTokenAccount: clientTokenAccount,
      providerTokenAccount: providerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    client: client.toBase58(),
    provider: provider.toBase58(),
    status: "resolved_timeout",
    transactionSignature: sig,
  };
}

// ==================== ENUM FORMATTERS ====================

function mapPricingModel(model: string): any {
  switch (model) {
    case "perTask":
      return { perTask: {} };
    case "perHour":
      return { perHour: {} };
    case "perToken":
      return { perToken: {} };
    default:
      throw new Error(
        `Unknown pricing model: ${model}. Use perTask, perHour, or perToken.`
      );
  }
}

function formatPricingModel(model: any): string {
  if (model.perTask !== undefined) return "perTask";
  if (model.perHour !== undefined) return "perHour";
  if (model.perToken !== undefined) return "perToken";
  return "unknown";
}

function formatAgentStatus(status: any): string {
  if (status.active !== undefined) return "active";
  if (status.paused !== undefined) return "paused";
  if (status.retired !== undefined) return "retired";
  return "unknown";
}

function formatEscrowStatus(status: any): string {
  if (status.created !== undefined) return "created";
  if (status.active !== undefined) return "active";
  if (status.completed !== undefined) return "completed";
  if (status.disputed !== undefined) return "disputed";
  if (status.cancelled !== undefined) return "cancelled";
  if (status.expired !== undefined) return "expired";
  return "unknown";
}

function formatMilestoneStatus(status: any): string {
  if (status.pending !== undefined) return "pending";
  if (status.submitted !== undefined) return "submitted";
  if (status.approved !== undefined) return "approved";
  if (status.rejected !== undefined) return "rejected";
  if (status.disputed !== undefined) return "disputed";
  return "unknown";
}

// ==================== SERVER STARTUP ====================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agenomics MCP Server started on stdio transport");
  console.error(`Agent wallet: ${getWalletPublicKey().toBase58()}`);
  console.error(`RPC: ${getConnection().rpcEndpoint}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

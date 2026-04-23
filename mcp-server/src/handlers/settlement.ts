/**
 * Settlement handler functions for the Agenomics MCP Server.
 * Manages escrow and milestone-based payments.
 */

import {
  loadWallet,
  getSettlementProgram,
  deriveEscrowPDA,
  deriveEscrowTokenAccount,
  deriveAgentProfilePDA,
  deriveOwnerNoncePDA,
  deriveProtocolConfigPDA,
  deriveVaultPDA,
  getAssociatedTokenAddressSync,
  parsePublicKey,
  hashDescription,
  BN,
  PublicKey,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  REGISTRY_PROGRAM_ID,
  SETTLEMENT_PROGRAM_ID,
} from "../solana.js";
import { SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  requireString,
  requireNumber,
  requirePositiveNumber,
  optionalString,
  optionalNumber,
} from "./validation.js";
import {
  formatEscrowStatus,
  formatMilestoneStatus,
} from "./formatters.js";

/**
 * Create a new escrow for a task.
 * Locks payment tokens in escrow. The escrow uses an ATA derived from the escrow PDA.
 */
export async function handleCreateEscrow(args: Record<string, unknown>) {
  const providerAddress = parsePublicKey(requireString(args, "providerAddress"));
  // Finding #21: providerVaultAddress is no longer accepted from callers.
  // The vault is canonically derived from the provider pubkey and validated
  // on-chain via seeds::program = AGENT_VAULT_PROGRAM_ID.
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

  // Finding #21: clientVault/providerVault must now be the canonical vault
  // PDAs derived from the Agent Vault program. Anchor's seeds::program
  // constraint will reject anything else — substituting the client pubkey
  // (the pre-fix placeholder) breaks here.
  const [clientVaultPDA] = deriveVaultPDA(wallet.publicKey);
  const [providerVaultPDA] = deriveVaultPDA(providerAddress);
  // Finding #19: pass the governance-owned ProtocolConfig PDA.
  const [protocolConfigPDA] = deriveProtocolConfigPDA();

  const sig = await program.methods
    .createEscrow(
      new BN(taskId),
      new BN(totalAmountTokens),
      descriptionHash,
      new BN(deadlineUnix),
      milestonesData,
      disputeResolverAddress
    )
    .accountsPartial({
      client: wallet.publicKey,
      clientVault: clientVaultPDA,
      providerVault: providerVaultPDA,
      provider: providerAddress,
      tokenMint: tokenMintAddress,
      clientTokenAccount: clientTokenAccount,
      escrow: escrowPDA,
      escrowTokenAccount: escrowTokenAccount,
      protocolConfig: protocolConfigPDA,
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
export async function handleAcceptTask(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .acceptTask()
    .accountsPartial({
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
export async function handleSubmitMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // ADR-102: grace_period_slots is the anti-front-running window for expire_escrow.
  // Default to 0 (opt out) unless the caller explicitly opts in.
  const gracePeriodSlots = new BN((args.gracePeriodSlots as number | undefined) ?? 0);
  const sig = await program.methods
    .submitMilestone(milestoneIndex, gracePeriodSlots)
    .accountsPartial({
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
export async function handleApproveMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");
  const providerTokenAccount = parsePublicKey(
    requireString(args, "providerTokenAccount")
  );
  // Finding #8: rating is plumbed into the reputation CPI so the registry's
  // avg_rating actually updates. Defaults to 0 (no rating) to keep the old
  // "approve without scoring" flow working.
  const ratingNum = optionalNumber(args, "rating") ?? 0;
  if (!Number.isInteger(ratingNum) || ratingNum < 0 || ratingNum > 5) {
    throw new Error("rating must be an integer in 0..=5 (0 = no rating)");
  }
  const rating = ratingNum;

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // ADR-088: typed via `Program<Settlement>.account.taskEscrow`.
  const escrow = await program.account.taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint;
  const provider = escrow.provider;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );

  // Derive provider's AgentProfile PDA for CPI reputation update
  const [providerProfilePDA] = deriveAgentProfilePDA(provider);
  // ADR-097: provider_owner_nonce is required for the agent_profile PDA seed
  // check on the CPI side.
  const [providerOwnerNoncePDA] = deriveOwnerNoncePDA(provider);

  // Derive settlement_authority PDA: seeds = ["settlement_authority"] from Settlement program
  const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  // Finding #19: governance-owned ProtocolConfig PDA.
  const [protocolConfigPDA] = deriveProtocolConfigPDA();

  const sig = await program.methods
    .approveMilestone(milestoneIndex, rating)
    .accountsPartial({
      client: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      providerTokenAccount: providerTokenAccount,
      registryProgram: REGISTRY_PROGRAM_ID,
      providerProfile: providerProfilePDA,
      providerOwnerNonce: providerOwnerNoncePDA,
      // SEC-1 (per ADR-068, in-flight): external authority anchor for the
      // Registry UpdateReputation CPI. Supplied as `escrow.provider` (the
      // only value that satisfies the Registry's new `has_one = authority`
      // + external-seeds constraint). Pre-fix Registry self-referenced the
      // PDA seed, which silently accepted any AgentProfile.
      providerAuthority: provider,
      settlementAuthority: settlementAuthorityPDA,
      protocolConfig: protocolConfigPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    escrowAddress: escrowAddress.toBase58(),
    milestoneIndex,
    rating,
    status: "approved",
    transactionSignature: sig,
  };
}

/**
 * Reject a milestone as the client.
 */
export async function handleRejectMilestone(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const milestoneIndex = requireNumber(args, "milestoneIndex");

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .rejectMilestone(milestoneIndex)
    .accountsPartial({
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
export async function handleGetEscrowStatus(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));
  const program = getSettlementProgram();

  // ADR-088: typed via `Program<Settlement>.account.taskEscrow`. Per the
  // settlement IDL: scalars u64 → BN, pubkey → PublicKey, status enum is
  // the Anchor-generated discriminated union.
  const escrow = await program.account.taskEscrow.fetch(escrowAddress);

  // Map milestone statuses. ADR-088: `m` arrives typed through
  // `Program<Settlement>.account.taskEscrow.fetch()` but Anchor's IDL type
  // narrowing doesn't cover nested struct arrays, so annotate explicitly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const milestones = escrow.milestones.map((m: any, i: number) => ({
    index: i,
    descriptionHash: Array.from(m.descriptionHash as ArrayLike<number>),
    amount: m.amount.toNumber(),
    status: formatMilestoneStatus(m.status),
  }));

  return {
    escrowAddress: escrowAddress.toBase58(),
    client: escrow.client.toBase58(),
    provider: escrow.provider.toBase58(),
    clientVault: escrow.clientVault.toBase58(),
    providerVault: escrow.providerVault.toBase58(),
    tokenMint: escrow.tokenMint.toBase58(),
    totalAmount: escrow.totalAmount.toNumber(),
    releasedAmount: escrow.releasedAmount.toNumber(),
    status: formatEscrowStatus(escrow.status),
    taskId: escrow.taskId.toNumber(),
    createdAt: escrow.createdAt.toNumber(),
    deadline: escrow.deadline.toNumber(),
    deadlineFormatted: new Date(escrow.deadline.toNumber() * 1000).toISOString(),
    disputeResolver: escrow.disputeResolver
      ? escrow.disputeResolver.toBase58()
      : null,
    milestones,
  };
}

/**
 * Cancel an escrow (client only). Returns tokens to client.
 */
export async function handleCancelEscrow(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // ADR-088: typed via `Program<Settlement>.account.taskEscrow`.
  const escrow = await program.account.taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );
  const clientTokenAccount = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

  const sig = await program.methods
    .cancelEscrow()
    .accountsPartial({
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
export async function handleRaiseDispute(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  const sig = await program.methods
    .raiseDispute()
    .accountsPartial({
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
export async function handleResolveDispute(args: Record<string, unknown>) {
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

  // ADR-088: typed via `Program<Settlement>.account.taskEscrow`.
  const escrow = await program.account.taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint;
  const provider = escrow.provider;
  const escrowTokenAccount = deriveEscrowTokenAccount(
    escrowAddress,
    tokenMint
  );

  // Derive provider's AgentProfile PDA + owner_nonce PDA for CPI reputation update.
  const [providerProfilePDA] = deriveAgentProfilePDA(provider);
  const [providerOwnerNoncePDA] = deriveOwnerNoncePDA(provider);

  // Derive settlement_authority PDA
  const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  // Finding #19: governance-owned ProtocolConfig PDA.
  const [protocolConfigPDA] = deriveProtocolConfigPDA();

  const sig = await program.methods
    .resolveDispute(clientRefund, providerRefund)
    .accountsPartial({
      resolver: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      clientTokenAccount: clientTokenAccount,
      providerTokenAccount: providerTokenAccount,
      registryProgram: REGISTRY_PROGRAM_ID,
      providerProfile: providerProfilePDA,
      providerOwnerNonce: providerOwnerNoncePDA,
      providerAuthority: provider,
      settlementAuthority: settlementAuthorityPDA,
      protocolConfig: protocolConfigPDA,
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

/**
 * Auto-resolve a dispute that has exceeded the escrow deadline.
 * Anyone can call this once the timeout has elapsed.
 */
export async function handleResolveDisputeTimeout(args: Record<string, unknown>) {
  const escrowAddress = parsePublicKey(requireString(args, "escrowAddress"));

  const wallet = loadWallet();
  const program = getSettlementProgram();

  // ADR-088: typed via `Program<Settlement>.account.taskEscrow`.
  const escrow = await program.account.taskEscrow.fetch(escrowAddress);
  const tokenMint = escrow.tokenMint;
  const client = escrow.client;
  const provider = escrow.provider;
  const escrowTokenAccount = deriveEscrowTokenAccount(escrowAddress, tokenMint);

  // ResolveDisputeTimeout refunds the client and slashes the provider's
  // reputation via CPI — it does NOT pay the provider, so no providerTokenAccount.
  const clientTokenAccount = getAssociatedTokenAddressSync(tokenMint, client);

  // Provider's AgentProfile PDA and settlement_authority PDA are required
  // by the on-chain context (ADR-050 slashing CPI).
  const [providerProfilePDA] = deriveAgentProfilePDA(provider);
  const [providerOwnerNoncePDA] = deriveOwnerNoncePDA(provider);
  const [settlementAuthorityPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("settlement_authority")],
    SETTLEMENT_PROGRAM_ID
  );

  // Finding #19: governance-owned ProtocolConfig PDA.
  const [protocolConfigPDA] = deriveProtocolConfigPDA();

  const sig = await program.methods
    .resolveDisputeTimeout()
    .accountsPartial({
      payer: wallet.publicKey,
      escrow: escrowAddress,
      escrowTokenAccount: escrowTokenAccount,
      clientTokenAccount: clientTokenAccount,
      registryProgram: REGISTRY_PROGRAM_ID,
      providerProfile: providerProfilePDA,
      providerOwnerNonce: providerOwnerNoncePDA,
      providerAuthority: provider,
      settlementAuthority: settlementAuthorityPDA,
      protocolConfig: protocolConfigPDA,
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

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
export async function handleAcceptTask(args: Record<string, unknown>) {
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
export async function handleSubmitMilestone(args: Record<string, unknown>) {
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
export async function handleApproveMilestone(args: Record<string, unknown>) {
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
export async function handleRejectMilestone(args: Record<string, unknown>) {
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
export async function handleGetEscrowStatus(args: Record<string, unknown>) {
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
export async function handleCancelEscrow(args: Record<string, unknown>) {
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
export async function handleRaiseDispute(args: Record<string, unknown>) {
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

/**
 * Auto-resolve a dispute that has exceeded the escrow deadline.
 * Anyone can call this once the timeout has elapsed.
 */
export async function handleResolveDisputeTimeout(args: Record<string, unknown>) {
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

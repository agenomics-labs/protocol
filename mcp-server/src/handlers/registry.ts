/**
 * Registry handler functions for the Agenomics MCP Server.
 * Manages agent discovery and reputation system.
 */

import {
  loadWallet,
  getWalletPublicKey,
  getRegistryProgram,
  deriveAgentProfilePDA,
  deriveVaultPDA,
  parsePublicKey,
  solToLamports,
  lamportsToSol,
  BN,
  PublicKey,
  REGISTRY_PROGRAM_ID,
} from "../solana.js";
import { SystemProgram } from "@solana/web3.js";
import {
  requireString,
  requirePositiveNumber,
  requireStringArray,
} from "./validation.js";
import {
  mapPricingModel,
  formatPricingModel,
  formatAgentStatus,
} from "./formatters.js";

/**
 * Register this agent in the on-chain registry.
 */
export async function handleRegisterAgent(args: Record<string, unknown>) {
  const name = requireString(args, "name");
  const description = requireString(args, "description");
  const category = requireString(args, "category");
  const capabilities = requireStringArray(args, "capabilities");
  const pricingModelStr = requireString(args, "pricingModel");
  const pricingAmountSol = requirePositiveNumber(args, "pricingAmountSol");
  const acceptedTokens = requireStringArray(args, "acceptedTokens").map((t) =>
    parsePublicKey(t)
  );

  // Map string to Anchor enum
  const pricingModel = mapPricingModel(pricingModelStr);

  const wallet = loadWallet();
  const program = getRegistryProgram();
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey);

  // Finding #9: Derive the canonical vault PDA from the authority. The
  // registry program validates this matches seeds `[b"vault", authority]`
  // under the Agent Vault program. The caller no longer supplies an
  // arbitrary pubkey.
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .registerAgent(
      name,
      description,
      category,
      capabilities,
      pricingModel,
      new BN(solToLamports(pricingAmountSol)),
      acceptedTokens
    )
    .accounts({
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
      vault: vaultPDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    agentProfileAddress: agentProfilePDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    vaultAddress: vaultPDA.toBase58(),
    name,
    category,
    capabilities,
    transactionSignature: sig,
  };
}

/**
 * Fetch an agent's profile from the registry.
 */
export async function handleGetAgentProfile(args: Record<string, unknown>) {
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
export async function handleUpdateAgentProfile(args: Record<string, unknown>) {
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

  // Finding #9: vault_address is no longer updatable — it is pinned to the
  // authority's canonical Agent Vault PDA at register time.

  const sig = await program.methods
    .updateProfile(
      name,
      description,
      category,
      capabilities,
      pricingModel,
      pricingAmount,
      acceptedTokens
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
export async function handleDiscoverAgents(args: Record<string, unknown>) {
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

/**
 * Stake SOL for agent reputation.
 * Derives a staking PDA from seeds=[authority, "reputation-stake"].
 */
export async function handleStakeReputation(args: Record<string, unknown>) {
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
      stakingPda: stakingPDA,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    agentProfileAddress: agentProfilePDA.toBase58(),
    stakingPda: stakingPDA.toBase58(),
    amountSol: amount,
    transactionSignature: sig,
  };
}

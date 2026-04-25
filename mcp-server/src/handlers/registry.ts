/**
 * Registry handler functions for the Agenomics MCP Server.
 * Manages agent discovery and reputation system.
 */

import {
  loadWallet,
  getWalletPublicKey,
  getRegistryProgram,
  deriveAgentProfilePDA,
  deriveOwnerNoncePDA,
  deriveVaultPDA,
  parsePublicKey,
  solToLamports,
  lamportsToSol,
  BN,
  PublicKey,
  REGISTRY_PROGRAM_ID,
} from "../solana.js";
import { SystemProgram } from "@solana/web3.js";
import type { IdlAccounts } from "@coral-xyz/anchor";
import type { AgentRegistry } from "../idl/types.js";

// ADR-088: Anchor decodes `AgentProfile` into this exact shape (BN for u64,
// PublicKey for pubkey, etc.). The alias keeps internal hydration helpers
// from re-typing the same surface.
type AgentProfileAccount = IdlAccounts<AgentRegistry>["agentProfile"];
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
import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ handler: "registry" });

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

  // ADR-088: Anchor 0.31's typed `.accounts()` rejects accounts whose PDA
  // can be resolved from the IDL seeds (e.g. `agentProfile`, `vault` here
  // both declare `pda: { seeds: [...] }`). We use `.accountsPartial()` to
  // explicitly pass them — the on-chain Anchor will still re-derive and
  // verify them, so behaviour is identical.
  // ADR-097: register_agent now requires the owner_nonce PDA. For first-time
  // users it's init_if_needed'd and `nonce` starts at 0; for re-registrations
  // after deregister it already exists with an incremented nonce.
  const [ownerNoncePDA] = deriveOwnerNoncePDA(wallet.publicKey);
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
    .accountsPartial({
      authority: wallet.publicKey,
      ownerNonce: ownerNoncePDA,
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
  // ADR-088: typed via `Program<AgentRegistry>.account.agentProfile`.
  // `pricingAmount`, `reputationScore`, `createdAt`, `updatedAt` arrive as
  // `BN`; `authority`, `vaultAddress` as `PublicKey`; `acceptedTokens` as
  // `PublicKey[]`. AUD-007 (PR-Q): the legacy `totalTasksCompleted`,
  // `totalEarnings`, and `avgRating` aggregates were removed from the
  // on-chain `AgentProfile`; they no longer appear here.
  const profile = await program.account.agentProfile.fetch(agentProfilePDA);

  return {
    agentProfileAddress: agentProfilePDA.toBase58(),
    authority: profile.authority.toBase58(),
    name: profile.name,
    description: profile.description,
    category: profile.category,
    capabilities: profile.capabilities,
    pricingModel: formatPricingModel(profile.pricingModel),
    pricingAmountSol: lamportsToSol(profile.pricingAmount.toNumber()),
    acceptedTokens: profile.acceptedTokens.map((pk: PublicKey) => pk.toBase58()),
    vaultAddress: profile.vaultAddress.toBase58(),
    status: formatAgentStatus(profile.status),
    reputationScore: profile.reputationScore.toNumber(),
    createdAt: profile.createdAt.toNumber(),
    updatedAt: profile.updatedAt.toNumber(),
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

  const [ownerNoncePDA] = deriveOwnerNoncePDA(wallet.publicKey);
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
    .accountsPartial({
      authority: wallet.publicKey,
      ownerNonce: ownerNoncePDA,
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
 * Finding #18: Uses the off-chain indexer's `/agents` HTTP endpoint to
 * narrow candidates (filter by category / min reputation server-side,
 * SQL-indexed), then hydrates the top `limit` candidates from on-chain
 * profile accounts. This replaces the previous `agentProfile.all()` call
 * that fetched every profile account via `getProgramAccounts` — an O(N)
 * unbounded RPC hit that doesn't scale past a few hundred agents.
 *
 * If `AEP_INDEXER_URL` is unset or the request fails, the handler falls
 * back to the old `agentProfile.all()` path so the MCP server stays
 * usable in local development and during indexer outages.
 */
export async function handleDiscoverAgents(args: Record<string, unknown>) {
  const program = getRegistryProgram();
  const limit = (args.limit as number) || 20;
  const category =
    typeof args.category === "string" ? (args.category as string) : undefined;
  const capability =
    typeof args.capability === "string"
      ? (args.capability as string).toLowerCase()
      : undefined;
  const minReputation =
    typeof args.minReputation === "number"
      ? (args.minReputation as number)
      : 0;

  const indexerUrl = process.env.AEP_INDEXER_URL;
  if (indexerUrl) {
    try {
      const hydrated = await discoverViaIndexer(
        program,
        indexerUrl,
        limit,
        category,
        capability,
        minReputation,
        args.includeInactive === true
      );
      if (hydrated) {
        return hydrated;
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, fallback: "on-chain-scan" },
        "discoverAgents indexer path failed; falling back to on-chain scan",
      );
    }
  }

  return discoverViaOnChainScan(
    program,
    limit,
    category,
    capability,
    minReputation,
    args.includeInactive === true
  );
}

/**
 * Indexer path: fetch candidate list from `/agents` with server-side
 * filters, then hydrate full profile details from on-chain PDAs for the
 * `limit` best candidates. This is O(limit) RPC round trips instead of
 * O(totalRegisteredAgents).
 */
async function discoverViaIndexer(
  program: ReturnType<typeof getRegistryProgram>,
  indexerUrl: string,
  limit: number,
  category: string | undefined,
  capability: string | undefined,
  minReputation: number,
  includeInactive: boolean
): Promise<{ agents: unknown[]; totalFound: number; limit: number } | null> {
  const url = new URL(`${indexerUrl.replace(/\/+$/, "")}/agents`);
  if (category) url.searchParams.set("category", category);
  if (minReputation > 0)
    url.searchParams.set("min_reputation", String(minReputation));
  // Over-fetch from the indexer: the on-chain hydration step may exclude
  // entries whose status is non-active or whose capabilities don't match.
  url.searchParams.set("limit", String(Math.min(Math.max(limit * 4, 50), 200)));

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(`indexer HTTP ${resp.status}`);
  }
  const payload = (await resp.json()) as {
    agents?: Array<{ authority: string; reputation_score?: number }>;
  };
  const candidates = payload.agents ?? [];
  if (candidates.length === 0) {
    return { agents: [], totalFound: 0, limit };
  }

  // Hydrate on-chain profile accounts in parallel. `fetchMultiple` does this
  // in one RPC call if available; fall back to per-PDA fetches otherwise.
  const profilePDAs = candidates.map(
    (c) => deriveAgentProfilePDA(parsePublicKey(c.authority))[0]
  );
  const accountsNs = program.account.agentProfile;
  let fetched: Array<AgentProfileAccount | null>;
  if (typeof accountsNs.fetchMultiple === "function") {
    fetched = (await accountsNs.fetchMultiple(
      profilePDAs
    )) as Array<AgentProfileAccount | null>;
  } else {
    fetched = await Promise.all(
      profilePDAs.map((pda) =>
        accountsNs.fetchNullable(pda).catch(() => null)
      )
    );
  }

  const agents = fetched
    .map((p, i): ReturnType<typeof hydrateAgent> | null => {
      if (!p) return null;
      const pda = profilePDAs[i];
      if (!pda) return null;
      return hydrateAgent(pda, p);
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  let filtered = agents;
  if (!includeInactive) {
    filtered = filtered.filter((a) => a.status === "active");
  }
  if (capability) {
    filtered = filtered.filter((a) =>
      a.capabilities.some((c: string) => c.toLowerCase().includes(capability))
    );
  }
  filtered.sort((a, b) => b.reputationScore - a.reputationScore);

  return {
    agents: filtered.slice(0, limit),
    totalFound: filtered.length,
    limit,
  };
}

/**
 * Fallback path: preserved from the original implementation so local
 * development and indexer outages don't break discovery outright. Incurs
 * the O(N) `getProgramAccounts` cost.
 */
async function discoverViaOnChainScan(
  program: ReturnType<typeof getRegistryProgram>,
  limit: number,
  category: string | undefined,
  capability: string | undefined,
  minReputation: number,
  includeInactive: boolean
): Promise<{ agents: unknown[]; totalFound: number; limit: number }> {
  const allProfiles = await program.account.agentProfile.all();

  let filtered = allProfiles.map((item) =>
    hydrateAgent(item.publicKey, item.account)
  );

  if (!includeInactive) {
    filtered = filtered.filter((a) => a.status === "active");
  }
  if (category) {
    filtered = filtered.filter((a) => a.category === category);
  }
  if (capability) {
    filtered = filtered.filter((a) =>
      a.capabilities.some((c: string) => c.toLowerCase().includes(capability))
    );
  }
  if (minReputation > 0) {
    filtered = filtered.filter((a) => a.reputationScore >= minReputation);
  }
  filtered.sort((a, b) => b.reputationScore - a.reputationScore);

  return {
    agents: filtered.slice(0, limit),
    totalFound: filtered.length,
    limit,
  };
}

/**
 * Normalize an on-chain `AgentProfile` account into the MCP wire format.
 * Shared between the indexer-hydrated path and the fallback scan so they
 * return identical shapes.
 *
 * ADR-088: typed via `IdlAccounts<AgentRegistry>["agentProfile"]`. No `as`
 * widening needed — the BN / PublicKey shapes flow from the IDL.
 */
function hydrateAgent(address: PublicKey, p: AgentProfileAccount) {
  return {
    address: address.toBase58(),
    authority: p.authority.toBase58(),
    name: p.name,
    description: p.description,
    category: p.category,
    capabilities: p.capabilities,
    pricingModel: formatPricingModel(p.pricingModel),
    pricingAmountSol: lamportsToSol(p.pricingAmount.toNumber()),
    status: formatAgentStatus(p.status),
    reputationScore: p.reputationScore.toNumber(),
    // AUD-007 (PR-Q): `totalTasksCompleted` and `avgRating` removed from the
    // on-chain `AgentProfile`. Discovery now exposes only Registry-native
    // signals (reputationScore, status); per-task telemetry is the indexer's
    // domain.
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
    .accountsPartial({
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

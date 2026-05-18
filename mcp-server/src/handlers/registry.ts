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
import { getAgentMemory } from "../adapters/agent-memory.js";
import { boundedFetchJson } from "../util/bounded-fetch.js";

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

  // ADR-129 Phase 1: best-effort observe into EVO L1 so a subsequent
  // `find_similar_agents` call can find this manifest by cosine similarity.
  // CONTRACT: register success is the only thing that matters here. The
  // try/catch swallows ANY failure mode — bridge down, EVO subprocess
  // crashed, surprise gate rejected, schema mismatch, anything. The
  // operator sees a WARN log at most. Failure is bounded to "future
  // similarity lookups won't find this agent until the next register" —
  // never to "register_agent reverted." This swallowing is asserted by
  // the registry test suite (find-similar-agents.test.ts).
  try {
    await getAgentMemory().recordAgentRegistration({
      authority: wallet.publicKey.toBase58(),
      agentProfileAddress: agentProfilePDA.toBase58(),
      name,
      description,
      category,
      capabilities,
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        agent_profile_address: agentProfilePDA.toBase58(),
        adr: "ADR-129",
      },
      "registerAgent: best-effort EVO observe failed; continuing (register success unaffected)",
    );
  }

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

  // ADR-144: bounded fetch (timeout + streamed byte cap). Indexer agent
  // list is bounded by the `limit` query param; 256 KiB default cap is
  // ample for the over-fetch (≤200 entries).
  const payload = await boundedFetchJson<{
    agents?: Array<{ authority: string; reputation_score?: number }>;
  }>(url.toString());
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

/**
 * ADR-129 Phase 1: read-only manifest-similarity query.
 *
 * Resolves a seed agent's authority into its on-chain manifest, then asks
 * EVO for the K agents whose cosine-similar L1 observations come closest.
 * Each hit is hydrated against the on-chain `AgentProfile` PDA so callers
 * get the same shape `discoverViaIndexer` returns plus the EVO-side
 * `similarity_score` and `memory_id`.
 *
 * Failure modes are bounded:
 *   - EVO disabled (kill-switch OFF) → returns `{ similar_agents: [],
 *     skipped: true, reason: "evo-disabled" }`. Not an error.
 *   - EVO bridge throws → returns a typed `Result.err` from the action
 *     wrapper (PROGRAM_ERROR with the bridge's message — never the raw
 *     EVO stack trace).
 *   - Hit references a stale authority (account closed, deregistered) →
 *     hydration drops it silently. The caller sees fewer than K results.
 */
export async function handleFindSimilarAgents(args: Record<string, unknown>) {
  const seedAuthority = parsePublicKey(requireString(args, "agent_id"));
  const topK = requirePositiveNumber(args, "top_k");
  const minSimilarity =
    typeof args.min_similarity === "number" ? args.min_similarity : 0.3;

  const program = getRegistryProgram();

  // 1. Resolve the seed agent's manifest. The query embedding is computed
  //    over the same compact text shape we observe in
  //    `agent-memory.ts#toEvoObservation`, so a register-then-self-query
  //    pair produces the highest-possible cosine similarity for the seed.
  const [seedProfilePDA] = deriveAgentProfilePDA(seedAuthority);
  const seedProfile = await program.account.agentProfile.fetchNullable(
    seedProfilePDA,
  );
  if (!seedProfile) {
    return {
      similar_agents: [],
      skipped: false,
      reason: "seed-agent-not-registered",
      seed_authority: seedAuthority.toBase58(),
    };
  }
  const queryText =
    `category=${seedProfile.category}\n` +
    `name=${seedProfile.name}\n` +
    `capabilities=${seedProfile.capabilities.join(", ")}\n` +
    `description=${seedProfile.description}`;

  // 2. Ask EVO for the K nearest neighbours under the requested similarity
  //    floor. Token budget is left at the adapter default (4096 per
  //    AEP_EVO_DEFAULT_TOKEN_BUDGET) — operators tighten via env, not
  //    per-call (Phase 1 keeps the wire surface minimal).
  // MCP-304: wrap in try/catch so a bridge-side failure (timeout, breaker
  // open, subprocess crash) NEVER throws out of this handler. Mirrors the
  // best-effort posture in handleRegisterAgent (`:108-126`) and the
  // settlement learn loop (`settlement.ts:71-89`).
  const memory = getAgentMemory();
  let memoryResult;
  try {
    memoryResult = await memory.findSimilarAgents({
      queryText,
      topK,
      minSimilarity,
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        seed_authority: seedAuthority.toBase58(),
        adr: "ADR-129",
        audit: "MCP-304",
      },
      "find_similar_agents: best-effort EVO retrieve failed; returning empty result",
    );
    return {
      similar_agents: [],
      skipped: true,
      reason: "evo-error",
      seed_authority: seedAuthority.toBase58(),
    };
  }

  if (memoryResult.skipped) {
    return {
      similar_agents: [],
      skipped: true,
      reason: "evo-disabled",
      seed_authority: seedAuthority.toBase58(),
    };
  }

  // 3. Hydrate each hit's on-chain profile so callers get the same shape
  //    `discoverViaIndexer` returns. Missing metadata (legacy observations
  //    pre-Phase-1) or stale PDAs are dropped silently — the caller sees
  //    fewer than topK results, not an error.
  const hitsWithAuthority = memoryResult.similarAgents.filter(
    (hit) => hit.authority.length > 0,
  );
  // Self-hit suppression: the seed agent's own observation is, by
  // construction, the highest-similarity match. Drop it so the caller
  // gets K *other* agents, not K-1.
  const peerHits = hitsWithAuthority.filter(
    (hit) => hit.authority !== seedAuthority.toBase58(),
  );

  const profilePDAs = peerHits.map(
    (hit) => deriveAgentProfilePDA(parsePublicKey(hit.authority))[0],
  );
  const accountsNs = program.account.agentProfile;
  let fetched: Array<AgentProfileAccount | null>;
  if (profilePDAs.length === 0) {
    fetched = [];
  } else if (typeof accountsNs.fetchMultiple === "function") {
    fetched = (await accountsNs.fetchMultiple(profilePDAs)) as Array<
      AgentProfileAccount | null
    >;
  } else {
    fetched = await Promise.all(
      profilePDAs.map((pda) =>
        accountsNs.fetchNullable(pda).catch(() => null),
      ),
    );
  }

  const similarAgents = peerHits
    .map((hit, i) => {
      const profile = fetched[i];
      if (!profile) return null;
      const pda = profilePDAs[i];
      if (!pda) return null;
      return {
        agent_id: hit.authority,
        agent_profile_address: pda.toBase58(),
        similarity_score: hit.similarityScore,
        memory_id: hit.memoryId,
        manifest_summary: hit.manifestSummary,
        // Mirror the discoverViaIndexer hydration shape so dashboards can
        // render either result set with the same projection logic.
        name: profile.name,
        category: profile.category,
        capabilities: profile.capabilities,
        reputation_score: profile.reputationScore.toNumber(),
        status: formatAgentStatus(profile.status),
      };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  return {
    similar_agents: similarAgents,
    skipped: false,
    seed_authority: seedAuthority.toBase58(),
    requested_top_k: topK,
    min_similarity: minSimilarity,
  };
}

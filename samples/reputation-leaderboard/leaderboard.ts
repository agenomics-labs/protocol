/**
 * AEP gallery sample — reputation-leaderboard
 *
 * SCOPE NOTE (read me first):
 *   This sample is READ-ONLY, like every v1 gallery entry. It exercises
 *   the `AgentRegistryClient` read surface:
 *
 *       connect  ->  derive profile PDA per authority  ->  fetch  ->
 *       rank by reputation  ->  render leaderboard
 *
 *   `@agenomics/client@0.1.0` ships PDA derivation + typed account
 *   fetch only; instruction builders (`registerAgent`, ...) are out of
 *   scope per ADR-098. See `samples/README.md` and the SDK README.
 *
 *   Discovery-by-`getProgramAccounts` (enumerate *every* on-chain
 *   profile) is itself an SDK roadmap item — `AgentRegistryClient`
 *   today fetches a profile for a known `(authority, nonce)`. This
 *   sample therefore ranks a *candidate set* of authorities (the
 *   `AGENT_AUTHORITIES` env var, comma-separated base58 pubkeys, or a
 *   small built-in devnet default). The moment a bulk-enumeration
 *   helper lands, the only change here is how `candidateAuthorities`
 *   is populated — the ranking/render code is unchanged.
 *
 * What this script demonstrates, end-to-end:
 *   1. Resolve the candidate authority set (env var or default).
 *   2. Build an `AnchorProvider` for Solana devnet (read-only: a
 *      throwaway keypair is fine; we never sign).
 *   3. Resolve cluster-keyed program IDs via `getProgramIds("devnet")`.
 *   4. Construct an `AgentRegistryClient`.
 *   5. For each candidate authority, derive the nonce=0 profile PDA
 *      and fetch the on-chain `AgentProfile`. Missing accounts are the
 *      expected "not registered" case and are skipped, not fatal.
 *   6. Clamp each reputation via `clampReputationScore`, sort
 *      descending, and render a ranked leaderboard table.
 */

import { AnchorProvider, Wallet, type Idl } from "@anchor-lang/core";
import { Connection, Keypair } from "@solana/web3.js";
import type { Address } from "@solana/kit";

import { AgentRegistryIdl, getProgramIds } from "@agenomics/idl";
import {
  AgentRegistryClient,
  clampReputationScore,
  MAX_REPUTATION_SCORE,
} from "@agenomics/client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Solana devnet RPC endpoint. Override with the RPC_URL env var. */
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

/** First profile an authority registers is always nonce = 0n (ADR-097). */
const NONCE: bigint = 0n;

/**
 * Built-in default candidate set. These are well-known devnet program
 * IDs used purely as *syntactically valid* base58 pubkeys so the
 * sample runs and renders its "no profile found" branch out of the box
 * without the user supplying anything. Replace via the
 * `AGENT_AUTHORITIES` env var with real registered-agent authorities
 * to see populated rows.
 */
const DEFAULT_AUTHORITIES: string[] = [
  "26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7",
  "9TRVbwhq3rR1Hpd8Yq1qd2dCw8Yq3xQ1cWw6q9rR1Hpd",
];

/** Parse the AGENT_AUTHORITIES env var (comma/whitespace separated). */
function resolveCandidateAuthorities(): string[] {
  const raw = process.env.AGENT_AUTHORITIES?.trim();
  if (!raw) return DEFAULT_AUTHORITIES;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  authority: string;
  profilePda: string;
  reputation: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const candidateAuthorities = resolveCandidateAuthorities();
  console.log(
    `reputation-leaderboard — ranking ${candidateAuthorities.length} ` +
      `candidate authorities on devnet\n`,
  );

  // Read-only: a generated keypair is sufficient; we never sign or send.
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const programIds = getProgramIds("devnet");
  const registryProgramId = programIds.agentRegistry as Address;
  console.log(`agent-registry program: ${registryProgramId}\n`);

  const registry = new AgentRegistryClient(
    provider,
    AgentRegistryIdl as Idl,
    registryProgramId,
  );

  const rows: LeaderboardRow[] = [];
  let missing = 0;

  for (const authority of candidateAuthorities) {
    let profilePda: string;
    try {
      profilePda = await registry.profilePda(authority as Address, NONCE);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  [skip] ${authority}: invalid authority — ${message}`);
      continue;
    }

    try {
      const profile = await registry.fetchProfile(
        authority as Address,
        NONCE,
      );
      const reputation = clampReputationScore(
        BigInt(profile.reputationScore.toString()),
      );
      rows.push({ authority, profilePda, reputation });
    } catch {
      // Account does not exist — the expected "not registered" case.
      missing += 1;
    }
  }

  rows.sort((a, b) => b.reputation - a.reputation);

  if (rows.length === 0) {
    console.log(
      `no registered profiles found among the candidate set ` +
        `(${missing} unregistered).\n` +
        `   this is expected with the built-in defaults — set\n` +
        `   AGENT_AUTHORITIES to real registered-agent authorities:\n` +
        `     AGENT_AUTHORITIES="<pubkey1>,<pubkey2>" npm start\n` +
        `   to register an agent, build a \`registerAgent\` transaction\n` +
        `   against the agent-registry program. SDK instruction\n` +
        `   builders are out of scope for @agenomics/client@0.1.0;\n` +
        `   see ADR-098 and sdk/client/README.md for the roadmap.`,
    );
    return;
  }

  console.log(`Leaderboard (top by reputation, out of ${MAX_REPUTATION_SCORE}):\n`);
  console.log(`  rank  reputation  authority`);
  console.log(`  ----  ----------  ---------`);
  rows.forEach((row, i) => {
    const rank = String(i + 1).padStart(4);
    const rep = `${row.reputation}/${MAX_REPUTATION_SCORE}`.padStart(10);
    console.log(`  ${rank}  ${rep}  ${row.authority}`);
  });
  if (missing > 0) {
    console.log(`\n  (${missing} candidate authorities had no registered profile)`);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});

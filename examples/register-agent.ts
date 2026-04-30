/**
 * AEP first-agent quickstart — register-agent.ts
 *
 * SCOPE NOTE (read me first):
 *   Despite the filename, this example is READ-ONLY today. SDK instruction
 *   builders (`registerAgent`, `updateAgent`, etc.) are explicitly out of
 *   scope for `@agenomics/client@0.1.0` — see the package README and the
 *   JSDoc on `AgentRegistryClient`. The honest, runnable scope of this
 *   file is:
 *
 *       connect  ->  derive PDA  ->  fetch  ->  render
 *
 *   When instruction builders ship, this file will be extended with a
 *   real `registerAgent` transaction. Until then, the filename is for
 *   discoverability ("how do I register an agent?" -> land here, see
 *   the wiring pattern, learn the read surface).
 *
 *   See `examples/README.md` for the user-facing recap.
 *
 * What this script demonstrates, end-to-end:
 *   1. Load a wallet keypair from `~/.config/solana/id.json`, or fall
 *      back to a generated keypair with a clear devnet-airdrop hint.
 *   2. Build an `AnchorProvider` for Solana devnet.
 *   3. Resolve the cluster's program IDs via `getProgramIds("devnet")`.
 *   4. Construct an `AgentRegistryClient` (cast IDL JSON to `Idl`,
 *      matching the canonical pattern from `sdk/client/README.md`).
 *   5. Derive the agent-profile PDA for `(authority, nonce=0n)` using
 *      `registry.profilePda(...)`.
 *   6. Fetch the on-chain `AgentProfile` account via `fetchProfile(...)`.
 *      If the account does not exist (the common first-time case),
 *      print a clear "no profile found" branch with a registration hint.
 *      If it exists, render the reputation score via
 *      `clampReputationScore(BigInt(profile.reputationScore.toString()))`.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { AgentRegistryIdl, getProgramIds } from "@agenomics/idl";
import { AgentRegistryClient, clampReputationScore } from "@agenomics/client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Solana devnet RPC endpoint. AUD-207: program IDs are devnet-functional. */
const RPC_URL = "https://api.devnet.solana.com";

/** Default agent-profile nonce. The first profile an authority registers
 *  is always nonce = 0n (ADR-097). Subsequent profiles increment from
 *  the on-chain `OwnerNonce::nonce` field. */
const NONCE: bigint = 0n;

// ---------------------------------------------------------------------------
// Step 1 — load wallet keypair
// ---------------------------------------------------------------------------

/**
 * Load the user's Solana CLI keypair from `~/.config/solana/id.json`,
 * or fall back to a freshly generated keypair (printing a clear devnet
 * airdrop hint so the dev knows how to fund it).
 */
function loadWalletKeypair(): Keypair {
  const keypairPath = join(homedir(), ".config", "solana", "id.json");
  if (existsSync(keypairPath)) {
    const raw = readFileSync(keypairPath, "utf8");
    const secret = Uint8Array.from(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(secret);
  }

  const generated = Keypair.generate();
  console.warn(
    `\n[warn] No keypair at ${keypairPath} — generated an ephemeral one.\n` +
      `       Public key: ${generated.publicKey.toBase58()}\n` +
      `       Fund it on devnet with:\n` +
      `         solana airdrop 1 ${generated.publicKey.toBase58()} -u devnet\n`,
  );
  return generated;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: wallet
  const keypair = loadWalletKeypair();
  const authority = keypair.publicKey;
  console.log(`authority: ${authority.toBase58()}`);

  // Step 2: AnchorProvider for devnet. We construct the provider directly
  //         (rather than `AnchorProvider.env()`) so this script runs without
  //         requiring the user to export `ANCHOR_WALLET` / `ANCHOR_PROVIDER_URL`.
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Step 3: resolve cluster-keyed program IDs from @agenomics/idl.
  const programIds = getProgramIds("devnet");
  const registryProgramId = new PublicKey(programIds.agentRegistry);
  console.log(`agent-registry program: ${registryProgramId.toBase58()}`);

  // Step 4: instantiate AgentRegistryClient. Cast the IDL JSON to `Idl`
  //         from @coral-xyz/anchor — this is the canonical pattern
  //         documented in `sdk/client/README.md`.
  const registry = new AgentRegistryClient(
    provider,
    AgentRegistryIdl as Idl,
    registryProgramId,
  );

  // Step 5: derive the agent-profile PDA for (authority, nonce=0n).
  //         Seeds: [authority.toBytes(), "agent-profile", nonce as u64 LE].
  const profilePda = registry.profilePda(authority, NONCE);
  console.log(`profile PDA (nonce=${NONCE}): ${profilePda.toBase58()}`);

  // Step 6: fetch the on-chain AgentProfile account, with a clear
  //         "not yet registered" branch — the expected first-run state.
  let profile: Awaited<ReturnType<AgentRegistryClient["fetchProfile"]>> | null =
    null;
  try {
    profile = await registry.fetchProfile(authority, NONCE);
  } catch (err) {
    // Anchor throws when the underlying account does not exist. This is
    // the common, expected case for an authority that has never registered.
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `\nno profile found at ${profilePda.toBase58()} — this is expected ` +
        `for an unregistered authority.\n` +
        `   underlying error: ${message}\n` +
        `   to register, build a \`registerAgent\` transaction against\n` +
        `   the agent-registry program. SDK instruction builders are\n` +
        `   out of scope for @agenomics/client@0.1.0; see ADR-098 and\n` +
        `   sdk/client/README.md for the roadmap.`,
    );
    return;
  }

  // Render the profile. Anchor decodes u64 fields as BN; route through
  // `BigInt(.toString())` and then `clampReputationScore` for AUD-112-safe
  // rendering during the migration window.
  const score = clampReputationScore(
    BigInt(profile.reputationScore.toString()),
  );
  console.log(`\nfound profile: ${profilePda.toBase58()}`);
  console.log(`   reputation: ${score}/100`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});

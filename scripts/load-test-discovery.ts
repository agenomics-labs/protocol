/**
 * ADR-022: Load Test for Agent Discovery (getProgramAccounts with memcmp filters)
 *
 * Creates N agent profiles on localnet, then benchmarks discovery queries
 * with and without memcmp filters to measure performance characteristics.
 *
 * Usage:
 *   npx ts-node scripts/load-test-discovery.ts [N]
 *   Default N = 100
 */

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  GetProgramAccountsFilter,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CATEGORIES = [
  "data-analysis",
  "trading",
  "content",
  "coding",
  "research",
] as const;

const AGENT_COUNT = parseInt(process.argv[2] ?? "100", 10);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

// The agent-registry program ID (must match declare_id! in lib.rs)
const REGISTRY_PROGRAM_ID = new PublicKey(
  "8t5oSA3xrLt9rMmM7QZBFWFDgBu8qvWsrUyXFYwPYWmV"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCategory(): string {
  return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

function randomName(i: number): string {
  return `agent-${i}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive the AgentProfile PDA for a given authority */
function deriveProfilePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );
}

interface BenchmarkResult {
  label: string;
  totalMs: number;
  perQueryMs: number;
  resultCount: number;
}

async function benchmarkQuery(
  connection: Connection,
  label: string,
  filters?: GetProgramAccountsFilter[]
): Promise<BenchmarkResult> {
  const iterations = 5;
  let totalMs = 0;
  let resultCount = 0;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const accounts = await connection.getProgramAccounts(REGISTRY_PROGRAM_ID, {
      filters,
    });
    totalMs += performance.now() - start;
    resultCount = accounts.length;
  }

  return {
    label,
    totalMs: Math.round(totalMs),
    perQueryMs: Math.round(totalMs / iterations),
    resultCount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== AEAP Agent Discovery Load Test (ADR-022) ===`);
  console.log(`RPC:        ${RPC_URL}`);
  console.log(`Agents:     ${AGENT_COUNT}`);
  console.log(`Categories: ${CATEGORIES.join(", ")}\n`);

  const connection = new Connection(RPC_URL, "confirmed");

  // --- Phase 1: Register agents ---
  console.log("Phase 1: Registering agents...");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load the IDL (must be built first via `anchor build`)
  let program: anchor.Program;
  try {
    const idl = await anchor.Program.fetchIdl(REGISTRY_PROGRAM_ID, provider);
    if (!idl) throw new Error("IDL not found");
    program = new anchor.Program(idl, provider);
  } catch {
    console.error(
      "ERROR: Could not load IDL. Run `anchor build` and `anchor deploy` first."
    );
    console.log(
      "Skipping registration phase -- running queries against existing accounts.\n"
    );
    program = null as any;
  }

  const registeredAuthorities: Keypair[] = [];
  const categoryAssignments: Map<string, number> = new Map();

  if (program) {
    const startReg = performance.now();

    for (let i = 0; i < AGENT_COUNT; i++) {
      const authority = Keypair.generate();
      const category = randomCategory();
      const name = randomName(i);

      // Airdrop SOL for rent
      const sig = await connection.requestAirdrop(
        authority.publicKey,
        2_000_000_000
      );
      await connection.confirmTransaction(sig, "confirmed");

      const [profilePDA] = deriveProfilePDA(authority.publicKey);

      try {
        await program.methods
          .registerAgent(
            name,
            `Load test agent ${i}`,
            category,
            ["benchmark"],
            { perTask: {} },
            new anchor.BN(1_000_000),
            [provider.wallet.publicKey],
            provider.wallet.publicKey
          )
          .accounts({
            authority: authority.publicKey,
            agentProfile: profilePDA,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([authority])
          .rpc();

        registeredAuthorities.push(authority);
        categoryAssignments.set(
          category,
          (categoryAssignments.get(category) ?? 0) + 1
        );

        if ((i + 1) % 20 === 0) {
          console.log(`  Registered ${i + 1}/${AGENT_COUNT}`);
        }
      } catch (err: any) {
        console.error(`  Failed to register agent ${i}: ${err.message}`);
      }
    }

    const regMs = Math.round(performance.now() - startReg);
    console.log(
      `  Done: ${registeredAuthorities.length} agents in ${regMs}ms\n`
    );
    console.log("  Category distribution:");
    for (const [cat, count] of categoryAssignments) {
      console.log(`    ${cat}: ${count}`);
    }
    console.log();
  }

  // --- Phase 2: Benchmark queries ---
  console.log("Phase 2: Benchmarking getProgramAccounts queries...\n");

  // Query 1: No filters (fetch all)
  const noFilter = await benchmarkQuery(connection, "No filters (all accounts)");

  // Query 2: memcmp filter on category field
  // The category string offset depends on the account layout.
  // AgentProfile discriminator (8) + authority (32) + name string (4 + 64) + description (4 + 256) = 368
  // Category starts at offset 368 as a Borsh string: 4-byte length prefix + data
  const CATEGORY_OFFSET = 8 + 32 + (4 + 64) + (4 + 256);
  const targetCategory = "trading";
  const categoryBytes = Buffer.alloc(4 + targetCategory.length);
  categoryBytes.writeUInt32LE(targetCategory.length, 0);
  categoryBytes.write(targetCategory, 4, "utf-8");

  const withMemcmp = await benchmarkQuery(
    connection,
    `memcmp filter (category="${targetCategory}")`,
    [
      {
        memcmp: {
          offset: CATEGORY_OFFSET,
          bytes: anchor.utils.bytes.bs58.encode(categoryBytes),
        },
      },
    ]
  );

  // Query 3: dataSize filter only
  const withDataSize = await benchmarkQuery(
    connection,
    "dataSize filter (account size match)",
    [{ dataSize: 8 + 32 + (4 + 64) + (4 + 256) + (4 + 50) + 500 }]
  );

  // --- Report ---
  console.log("=== Results ===\n");
  console.log(
    `${"Query".padEnd(45)} | ${"Total (ms)".padStart(10)} | ${"Per-Query (ms)".padStart(14)} | ${"Results".padStart(8)}`
  );
  console.log("-".repeat(85));

  for (const r of [noFilter, withMemcmp, withDataSize]) {
    console.log(
      `${r.label.padEnd(45)} | ${String(r.totalMs).padStart(10)} | ${String(r.perQueryMs).padStart(14)} | ${String(r.resultCount).padStart(8)}`
    );
  }

  console.log(
    `\nSpeedup from memcmp filter: ${noFilter.perQueryMs > 0 ? (noFilter.perQueryMs / Math.max(withMemcmp.perQueryMs, 1)).toFixed(2) : "N/A"}x`
  );
  console.log();
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});

/**
 * Full happy-path lifecycle scenario.
 *
 * Each "flow" exercises:
 *   1. register two agents (client + provider) — `register_agent` ×2
 *   2. initialize two vaults (client + provider) — `initialize_vault` ×2
 *      (post-ADR-124: ed25519 sibling ix + bind signature arg)
 *   3. provision a per-flow SPL token mint + ATAs + mint to client
 *   4. create_escrow with 1 milestone, client-funded
 *   5. accept_task (provider)
 *   6. submit_milestone (provider)
 *   7. approve_milestone (client) — CPIs into Registry's
 *      update_provider_reputation, which is the post-AUD-100
 *      implementation of the propose_reputation_delta policy. We
 *      surface this as an annotated ix-class so the metrics file
 *      makes the CPI cost explicit.
 *
 * The scenario does NOT call `propose_reputation_delta` directly —
 * that ix's `settlement_authority` slot is `signer + seeds::program =
 * SETTLEMENT_PROGRAM_ID`, only signable via Settlement's
 * `invoke_signed`. Direct TS calls fail at the web3.js client layer
 * with "unknown signer" before reaching the wire (this is the
 * cycle-2 AUD-108 boundary; see tests/agent-registry.ts ~L2315).
 * The reputation-delta behaviour is instead exercised through the
 * approve_milestone CPI path, which is the only production-reachable
 * driver of reputation mutations.
 *
 * Concurrency: a worker-pool pattern. `--concurrency=N` workers each
 * pull the next flow index from a shared counter and run a flow to
 * completion before pulling the next. This bounds in-flight RPC calls
 * (so the connection doesn't melt under unbounded fan-out) without
 * idle gaps between flows.
 *
 * Termination: the scenario exits when EITHER a configured number of
 * flows complete (`--flows=N`) OR a wall-clock duration is exceeded
 * (`--duration=M`, in seconds). Whichever fires first. For Phase 1
 * smoke validation, both are kept small.
 *
 * Exit codes:
 *   0 — scenario completed without infrastructure-level failure
 *   1 — fatal setup error (could not connect to RPC, IDL missing,
 *       protocol_config not initialized, etc.)
 * Lifecycle ix failures inside individual flows do NOT fail the
 * process; they're tallied in the JSON results file. Operators
 * inspect the JSON for SLO-breach counts.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import {
  PROTOCOL_CONFIG_PDA,
  REGISTRY_PROGRAM_ID,
  SETTLEMENT_AUTHORITY_PDA,
  SETTLEMENT_PROGRAM_ID,
  VAULT_PROGRAM_ID,
  deriveEscrowPDA,
} from "../lib/pdas";
import {
  loadProgram,
  provisionAgent,
  provisionFlowTokens,
  type LoadAgent,
} from "../lib/agent-factory";
import {
  MetricsCollector,
  type IxClass,
} from "../lib/metrics-collector";
import { measureIndexerLag } from "../lib/indexer-lag";

interface CliArgs {
  rpcUrl: string;
  walletPath: string;
  concurrency: number;
  flows: number;
  durationSec: number;
  outputDir: string;
  indexerDbPath: string;
  airdropSol: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (key: string, dflt?: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${key}=`));
    if (hit) return hit.slice(key.length + 3);
    return dflt;
  };

  return {
    rpcUrl:
      get("rpc-url") ??
      process.env.SOLANA_RPC_URL ??
      "http://127.0.0.1:8899",
    walletPath:
      get("wallet") ??
      process.env.ANCHOR_WALLET ??
      `${process.env.HOME ?? ""}/.config/solana/id.json`,
    concurrency: parseInt(get("concurrency", "2") ?? "2", 10),
    flows: parseInt(get("flows", "10") ?? "10", 10),
    durationSec: parseInt(get("duration", "30") ?? "30", 10),
    outputDir:
      get("output-dir") ??
      path.resolve(__dirname, "..", "results"),
    indexerDbPath:
      get("indexer-db") ??
      process.env.DB_PATH ??
      path.resolve(__dirname, "..", "..", "aep-events.db"),
    airdropSol: parseFloat(get("airdrop-sol", "5") ?? "5"),
  };
}

function loadWallet(walletPath: string): Keypair {
  const raw = fs.readFileSync(walletPath, "utf-8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

class KeypairWallet {
  constructor(public readonly payer: Keypair) {}
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

/**
 * Time a tx by measuring wall clock around .rpc(), then re-fetch
 * the tx via getTransaction with `maxSupportedTransactionVersion: 0`
 * to extract `meta.computeUnitsConsumed`. The fetch is best-effort —
 * if the tx isn't yet finalized for getTransaction we record CU as
 * NaN and the metrics file annotates the unsampled count.
 */
async function timedRpc(
  connection: Connection,
  ixClass: IxClass,
  collector: MetricsCollector,
  send: () => Promise<string>,
): Promise<string | null> {
  const t0 = Date.now();
  let signature: string;
  try {
    signature = await send();
  } catch (err) {
    collector.recordRpcError((err as Error).message ?? String(err));
    return null;
  }
  const latencyMs = Date.now() - t0;

  let computeUnits = NaN;
  let slot = 0;
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta) {
      const cu = (tx.meta as { computeUnitsConsumed?: number })
        .computeUnitsConsumed;
      if (typeof cu === "number") computeUnits = cu;
      slot = tx.slot;
    }
  } catch {
    // best-effort; don't fail the flow on a forensic-only fetch
  }

  collector.recordIx(ixClass, { latencyMs, computeUnits, signature, slot });
  return signature;
}

/**
 * Run one full happy-path lifecycle. Returns true on success, false
 * if any ix in the flow failed (the flow stops at first failure;
 * subsequent ixes are not attempted).
 */
async function runOneFlow(
  flowIdx: number,
  ctx: {
    connection: Connection;
    registryProgram: Program;
    vaultProgram: Program;
    settlementProgram: Program;
    collector: MetricsCollector;
    airdropLamports: number;
    ed25519Signer: { sign: (m: Uint8Array, k: Uint8Array) => Uint8Array };
  },
): Promise<boolean> {
  const taskId = BigInt(Date.now()) * BigInt(1_000) + BigInt(flowIdx % 1_000);

  let client: LoadAgent;
  let provider: LoadAgent;
  let tokens: Awaited<ReturnType<typeof provisionFlowTokens>>;
  try {
    // Per-flow per-agent setup is NOT attributed to per-ix latencies —
    // it's accounted as flow-setup overhead. The per-ix bucket only
    // covers the lifecycle ix calls (steps 4-7).
    client = await provisionAgent({
      registryProgram: ctx.registryProgram,
      vaultProgram: ctx.vaultProgram,
      connection: ctx.connection,
      airdropLamports: ctx.airdropLamports,
      nameTag: `loadclient${flowIdx}`,
      acceptedToken: SystemProgram.programId, // placeholder; replaced via update_profile if needed
      ed25519Signer: ctx.ed25519Signer,
    });
    provider = await provisionAgent({
      registryProgram: ctx.registryProgram,
      vaultProgram: ctx.vaultProgram,
      connection: ctx.connection,
      airdropLamports: ctx.airdropLamports,
      nameTag: `loadprov${flowIdx}`,
      acceptedToken: SystemProgram.programId,
      ed25519Signer: ctx.ed25519Signer,
    });
    tokens = await provisionFlowTokens({
      connection: ctx.connection,
      client: client.authority,
      provider: provider.authority,
      initialClientBalance: 10_000_000n,
    });
  } catch (err) {
    ctx.collector.recordRpcError(
      `flow-setup: ${(err as Error).message ?? String(err)}`,
    );
    return false;
  }

  const [escrowPDA] = deriveEscrowPDA(
    client.authority.publicKey,
    provider.authority.publicKey,
    taskId,
  );
  const escrowTokenAccount = getAssociatedTokenAddressSync(
    tokens.tokenMint,
    escrowPDA,
    true, // PDA owner — allowOwnerOffCurve
  );

  // 4. create_escrow
  const createSig = await timedRpc(
    ctx.connection,
    "create_escrow",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .createEscrow(
          new BN(taskId.toString()),
          new BN(1_000_000), // 1 USDC equivalent
          Buffer.alloc(32), // description_hash
          new BN(Math.floor(Date.now() / 1000) + 7 * 86400),
          [
            {
              amount: new BN(1_000_000),
              descriptionHash: Buffer.alloc(32, 1),
            },
          ],
          null, // dispute_resolver — default to client
        )
        .accounts({
          client: client.authority.publicKey,
          clientVault: client.vaultPDA,
          providerVault: provider.vaultPDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: provider.authority.publicKey,
          tokenMint: tokens.tokenMint,
          clientTokenAccount: tokens.clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([client.authority])
        .rpc(),
  );
  if (!createSig) return false;

  // 5. accept_task (provider)
  const acceptSig = await timedRpc(
    ctx.connection,
    "accept_task",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .acceptTask()
        .accounts({
          provider: provider.authority.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider.authority])
        .rpc(),
  );
  if (!acceptSig) return false;

  // 6. submit_milestone(0, grace=0)
  const submitSig = await timedRpc(
    ctx.connection,
    "submit_milestone",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: provider.authority.publicKey,
          escrow: escrowPDA,
        })
        .signers([provider.authority])
        .rpc(),
  );
  if (!submitSig) return false;

  // 7. approve_milestone(0, rating=5) — CPIs into Registry's
  //    update_provider_reputation, which is what realises the
  //    propose_reputation_delta policy in production. We attribute
  //    the approve_milestone latency to BOTH ix-classes so the
  //    metrics file shows the CPI-bearing cost separately.
  const approveSig = await timedRpc(
    ctx.connection,
    "approve_milestone__includes_reputation_cpi",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .approveMilestone(new BN(0), 5)
        .accounts({
          client: client.authority.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount,
          providerTokenAccount: tokens.providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: provider.profilePDA,
          providerOwnerNonce: provider.ownerNoncePDA,
          providerAuthority: provider.authority.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client.authority])
        .rpc(),
  );
  if (!approveSig) return false;

  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== AEP load harness — full-lifecycle scenario ===");
  console.log(`RPC URL:        ${args.rpcUrl}`);
  console.log(`Wallet:         ${args.walletPath}`);
  console.log(`Concurrency:    ${args.concurrency}`);
  console.log(`Flows (max):    ${args.flows}`);
  console.log(`Duration (max): ${args.durationSec}s`);
  console.log(`Output dir:     ${args.outputDir}`);
  console.log(`Indexer DB:     ${args.indexerDbPath}`);
  console.log(`Airdrop:        ${args.airdropSol} SOL / agent`);
  console.log();

  // Pre-flight: connection.
  const connection = new Connection(args.rpcUrl, "confirmed");
  try {
    const v = await connection.getVersion();
    console.log(`Cluster: ${v["solana-core"]}`);
  } catch (err) {
    console.error(`FATAL: cannot reach RPC at ${args.rpcUrl}: ${(err as Error).message}`);
    process.exit(1);
  }

  // Pre-flight: wallet.
  let walletKp: Keypair;
  try {
    walletKp = loadWallet(args.walletPath);
  } catch (err) {
    console.error(
      `FATAL: cannot load wallet at ${args.walletPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  // Pre-flight: noble ed25519 (used by ADR-124 bind signing). The dynamic
  // import keeps the harness loadable on Node versions where the noble
  // package's ESM exports trip CommonJS resolution at parse time.
  const dynImport = new Function("s", "return import(s);") as <T>(
    s: string,
  ) => Promise<T>;
  const nobleMod = await dynImport<typeof import("@noble/curves/ed25519")>(
    "@noble/curves/ed25519",
  );
  const ed25519Signer = nobleMod.ed25519;

  // Provider for Anchor.
  const provider = new anchor.AnchorProvider(
    connection,
    new KeypairWallet(walletKp) as unknown as anchor.Wallet,
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);

  // Programs (resolved by IDL on disk; no anchor.workspace dependency).
  let registryProgram: Program;
  let vaultProgram: Program;
  let settlementProgram: Program;
  try {
    registryProgram = loadProgram("agent_registry", provider, REGISTRY_PROGRAM_ID);
    vaultProgram = loadProgram("agent_vault", provider, VAULT_PROGRAM_ID);
    settlementProgram = loadProgram("settlement", provider, SETTLEMENT_PROGRAM_ID);
  } catch (err) {
    console.error(`FATAL: ${(err as Error).message}`);
    console.error(
      "Hint: run `anchor build` to populate target/idl/, or commit the IDL to idl/.",
    );
    process.exit(1);
  }

  // Pre-flight: protocol_config must already be initialized. The load
  // harness is NOT in the business of initializing protocol-level
  // singletons — that's an operator responsibility (see
  // tests/settlement.ts before() hook for the test-runner equivalent).
  const protocolConfigInfo = await connection.getAccountInfo(PROTOCOL_CONFIG_PDA);
  if (!protocolConfigInfo) {
    console.error(
      `FATAL: ProtocolConfig PDA not initialized at ${PROTOCOL_CONFIG_PDA.toBase58()}.`,
    );
    console.error(
      "On localnet, this is initialized once by the first `anchor test` run. ",
    );
    console.error(
      "If you brought up a fresh test-validator, run `anchor test --skip-build` once first to seed it.",
    );
    process.exit(1);
  }

  // Wire up the metrics collector with the actual run shape.
  const collector = new MetricsCollector({
    scenario: "full-lifecycle",
    rpcUrl: args.rpcUrl,
    concurrency: args.concurrency,
    durationSec: args.durationSec,
    flows: args.flows,
  });

  // Worker-pool: each worker pulls the next flow index, runs a full
  // lifecycle, records flow-attempt outcome, then pulls the next.
  // Stops when EITHER the flow counter is exhausted OR the deadline
  // has passed.
  const deadline = Date.now() + args.durationSec * 1000;
  let nextFlow = 0;
  let completedFlows = 0;

  const workerCount = Math.min(args.concurrency, args.flows);
  console.log(`Spawning ${workerCount} worker(s); deadline at +${args.durationSec}s\n`);
  const t0 = Date.now();

  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIdx) => {
      while (true) {
        if (Date.now() >= deadline) return;
        const idx = nextFlow++;
        if (idx >= args.flows) return;
        const ok = await runOneFlow(idx, {
          connection,
          registryProgram,
          vaultProgram,
          settlementProgram,
          collector,
          airdropLamports: Math.floor(args.airdropSol * 1_000_000_000),
          ed25519Signer,
        });
        collector.recordFlowAttempt(ok);
        completedFlows += 1;
        if (completedFlows % Math.max(1, Math.floor(args.flows / 10)) === 0) {
          const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `  worker[${workerIdx}] flow=${idx} ok=${ok} (completed=${completedFlows}, wall=${wallSec}s)`,
          );
        }
      }
    }),
  );

  const wallSec = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\nAll workers finished after ${wallSec}s (completed=${completedFlows}).`);

  // Indexer lag — best-effort, never blocks the campaign.
  try {
    console.log("\nMeasuring indexer lag...");
    const lag = await measureIndexerLag(connection, args.indexerDbPath);
    collector.setIndexerLag(lag);
    if (!lag.available) {
      console.log(`  [unavailable] ${lag.unavailableReason}`);
    } else {
      console.log(`  chain head: ${lag.chainHeadSlot}`);
      for (const [program, { cursorSlot, lagSlots }] of Object.entries(
        lag.perProgram,
      )) {
        console.log(
          `  ${program.padEnd(20)} cursor=${cursorSlot}  lag=${lagSlots} slots`,
        );
      }
    }
  } catch (err) {
    console.log(`  [error] ${(err as Error).message}`);
  }

  const outFile = await collector.flush(args.outputDir);
  console.log(`\nMetrics written to: ${outFile}`);
  console.log("Scenario complete.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});

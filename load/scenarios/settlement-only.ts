/**
 * Settlement-only steady-state load scenario.
 *
 * Phase 2 of B9 (PRE_MAINNET_ROADMAP §3). Builds on the Phase 1
 * `full-lifecycle` harness (commit `4b7f2b2`).
 *
 * What this scenario measures
 * ---------------------------
 *
 * `full-lifecycle.ts` provisions a fresh (client, provider) pair for
 * EVERY flow. That dominates wall-clock and biases the per-ix CU
 * profile toward `register_agent` + `initialize_vault`, which an
 * established protocol does NOT exercise on the steady-state hot
 * path. Phase 1 was right for end-to-end shape coverage; it is wrong
 * for representative throughput numbers.
 *
 * This scenario instead:
 *
 *   1. **Pre-provisions an agent pool ONCE** at startup. `--pool-size=N`
 *      pairs of (client, provider) agents are registered + vault-initialised
 *      sequentially. Pool provisioning is NOT counted toward per-ix
 *      latency / CU buckets.
 *   2. **Steady-state load**: a worker-pool of `--concurrency=M` workers
 *      acquires pairs round-robin from the pool, runs ONLY the
 *      settlement-phase ix sequence (create_escrow → accept_task →
 *      submit_milestone → approve_milestone), then returns the pair.
 *      The same pair is reused across many flows with monotonically
 *      increasing task_ids (the third escrow PDA seed).
 *   3. **Stops on `--duration` deadline OR `--flows` cap**, whichever
 *      fires first. For steady-state characterization, prefer the
 *      duration bound.
 *   4. **Reports per-ix metrics for the settlement-phase ixes ONLY**.
 *      Same four IxClass buckets as the lifecycle scenario's settlement
 *      tail, with a sharper signal because no per-flow setup overhead
 *      pollutes the slot range.
 *
 * What this scenario stresses
 * ---------------------------
 *
 *   - **Post-AUD-117 seeds defense-in-depth at the Settlement boundary**.
 *     Every approve_milestone in this scenario re-derives
 *     `provider_owner_nonce` and `provider_profile` PDAs from the
 *     declared authority on the Settlement side (per the AUD-117
 *     constraints in `programs/settlement/src/contexts.rs`). High
 *     concurrent load against a small population of provider profiles
 *     is the closest production-shape stress for that re-derivation
 *     path.
 *   - **Post-AUD-209 saturation guard at the off-chain layer**. The
 *     scenario produces high settlement-event throughput on-chain →
 *     direct ingest pressure on the indexer / x402-relay pipeline. The
 *     end-of-run `indexer-lag` reading is the leading indicator: a
 *     non-trivial lag at end-of-run means ingest can't keep up with the
 *     measured settlement throughput, which is exactly the surface
 *     AUD-209's saturation guard exists to fail-closed on. If lag
 *     stays bounded across rising `--concurrency`, the guard isn't
 *     triggered and the throughput number is the protocol's true
 *     headroom.
 *
 * Pool design
 * -----------
 *
 * See `lib/agent-pool.ts` for the per-pair nonce tracking + JIT
 * top-up rationale. Briefly: each pool member owns a per-pair task-id
 * counter (the third escrow PDA seed) so concurrent flows on the same
 * pair don't collide on PDA derivation, AND a per-pair token mint with
 * the harness as mint authority so the scenario can top-up the client
 * ATA mid-campaign without re-running token plumbing.
 *
 * Exit codes (same shape as full-lifecycle)
 *   0 — scenario completed without infrastructure-level failure
 *   1 — fatal setup error (RPC unreachable, IDL missing,
 *       protocol_config not initialized, pool provisioning failed)
 * Settlement-ix failures inside individual flows do NOT fail the
 * process; they're tallied in the JSON results file.
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
import { loadProgram } from "../lib/agent-factory";
import { provisionAgentPool, type AgentPool } from "../lib/agent-pool";
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
  poolSize: number;
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
    concurrency: parseInt(get("concurrency", "4") ?? "4", 10),
    flows: parseInt(get("flows", "100") ?? "100", 10),
    durationSec: parseInt(get("duration", "60") ?? "60", 10),
    outputDir:
      get("output-dir") ??
      path.resolve(__dirname, "..", "results"),
    indexerDbPath:
      get("indexer-db") ??
      process.env.DB_PATH ??
      path.resolve(__dirname, "..", "..", "aep-events.db"),
    airdropSol: parseFloat(get("airdrop-sol", "5") ?? "5"),
    poolSize: parseInt(get("pool-size", "10") ?? "10", 10),
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
 * Time a tx by measuring wall clock around .rpc(), then re-fetch via
 * getTransaction to pull `meta.computeUnitsConsumed`. Same shape as
 * the full-lifecycle scenario's `timedRpc` — copy intentional to keep
 * the two scenarios literally identical on the hot path so a
 * cross-scenario diff isolates the pool-vs-fresh effect cleanly.
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
    // best-effort
  }

  collector.recordIx(ixClass, { latencyMs, computeUnits, signature, slot });
  return signature;
}

/** Per-flow escrow amount, in token base units (USDC-like, 6 decimals → 1.0 token). */
const ESCROW_AMOUNT = 1_000_000n;

/**
 * Run one settlement cycle on the pool-acquired pair. The pool MUST
 * have been acquired by the caller; this function only runs the
 * four-ix sequence and records metrics. Returns true if all four ixes
 * succeeded, false otherwise (and stops at first failure).
 */
async function runSettlementCycle(
  flowIdx: number,
  taskId: bigint,
  pair: {
    client: { authority: Keypair; vaultPDA: PublicKey };
    provider: {
      authority: Keypair;
      vaultPDA: PublicKey;
      profilePDA: PublicKey;
      ownerNoncePDA: PublicKey;
    };
    tokens: {
      tokenMint: PublicKey;
      clientTokenAccount: PublicKey;
      providerTokenAccount: PublicKey;
    };
  },
  ctx: {
    connection: Connection;
    settlementProgram: Program;
    collector: MetricsCollector;
  },
): Promise<boolean> {
  const [escrowPDA] = deriveEscrowPDA(
    pair.client.authority.publicKey,
    pair.provider.authority.publicKey,
    taskId,
  );
  const escrowTokenAccount = getAssociatedTokenAddressSync(
    pair.tokens.tokenMint,
    escrowPDA,
    true,
  );

  // create_escrow
  const createSig = await timedRpc(
    ctx.connection,
    "create_escrow",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .createEscrow(
          new BN(taskId.toString()),
          new BN(ESCROW_AMOUNT.toString()),
          Buffer.alloc(32),
          new BN(Math.floor(Date.now() / 1000) + 7 * 86400),
          [
            {
              amount: new BN(ESCROW_AMOUNT.toString()),
              descriptionHash: Buffer.alloc(32, 1),
            },
          ],
          null,
        )
        .accounts({
          client: pair.client.authority.publicKey,
          clientVault: pair.client.vaultPDA,
          providerVault: pair.provider.vaultPDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          provider: pair.provider.authority.publicKey,
          tokenMint: pair.tokens.tokenMint,
          clientTokenAccount: pair.tokens.clientTokenAccount,
          escrow: escrowPDA,
          escrowTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([pair.client.authority])
        .rpc(),
  );
  if (!createSig) return false;

  // accept_task
  const acceptSig = await timedRpc(
    ctx.connection,
    "accept_task",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .acceptTask()
        .accounts({
          provider: pair.provider.authority.publicKey,
          escrow: escrowPDA,
        })
        .signers([pair.provider.authority])
        .rpc(),
  );
  if (!acceptSig) return false;

  // submit_milestone(0, grace=0)
  const submitSig = await timedRpc(
    ctx.connection,
    "submit_milestone",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .submitMilestone(new BN(0), new BN(0))
        .accounts({
          provider: pair.provider.authority.publicKey,
          escrow: escrowPDA,
        })
        .signers([pair.provider.authority])
        .rpc(),
  );
  if (!submitSig) return false;

  // approve_milestone(0, rating=5) — CPIs into Registry's
  // update_provider_reputation. AUD-117 defense-in-depth re-derives
  // provider_owner_nonce + provider_profile at the Settlement boundary;
  // this scenario hammers that path under sustained concurrency
  // against a small pool of provider profiles.
  const approveSig = await timedRpc(
    ctx.connection,
    "approve_milestone__includes_reputation_cpi",
    ctx.collector,
    () =>
      ctx.settlementProgram.methods
        .approveMilestone(new BN(0), 5)
        .accounts({
          client: pair.client.authority.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount,
          providerTokenAccount: pair.tokens.providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: pair.provider.profilePDA,
          providerOwnerNonce: pair.provider.ownerNoncePDA,
          providerAuthority: pair.provider.authority.publicKey,
          settlementAuthority: SETTLEMENT_AUTHORITY_PDA,
          protocolConfig: PROTOCOL_CONFIG_PDA,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([pair.client.authority])
        .rpc(),
  );
  if (!approveSig) return false;

  // The flowIdx parameter is unused inside the cycle but kept on the
  // signature so the per-worker progress logger can correlate.
  void flowIdx;
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== AEP load harness — settlement-only steady-state ===");
  console.log(`RPC URL:        ${args.rpcUrl}`);
  console.log(`Wallet:         ${args.walletPath}`);
  console.log(`Pool size:      ${args.poolSize} pairs (pre-provisioned)`);
  console.log(`Concurrency:    ${args.concurrency} workers`);
  console.log(`Flows (max):    ${args.flows}`);
  console.log(`Duration (max): ${args.durationSec}s`);
  console.log(`Output dir:     ${args.outputDir}`);
  console.log(`Indexer DB:     ${args.indexerDbPath}`);
  console.log(`Airdrop:        ${args.airdropSol} SOL / agent`);
  console.log();

  if (args.poolSize < 1) {
    console.error("FATAL: --pool-size must be >= 1");
    process.exit(1);
  }
  if (args.concurrency < 1) {
    console.error("FATAL: --concurrency must be >= 1");
    process.exit(1);
  }

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

  // Pre-flight: noble ed25519 (used by ADR-124 vault-bind during pool
  // provisioning). Same dynamic-import trick as full-lifecycle to dodge
  // CommonJS-vs-ESM resolution at parse time.
  const dynImport = new Function("s", "return import(s);") as <T>(
    s: string,
  ) => Promise<T>;
  const nobleMod = await dynImport<typeof import("@noble/curves/ed25519")>(
    "@noble/curves/ed25519",
  );
  const ed25519Signer = nobleMod.ed25519;

  const provider = new anchor.AnchorProvider(
    connection,
    new KeypairWallet(walletKp) as unknown as anchor.Wallet,
    { commitment: "confirmed" },
  );
  anchor.setProvider(provider);

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

  // Pre-flight: protocol_config must be initialized.
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

  // === Phase A: pool provisioning (NOT counted in per-ix metrics) ===
  console.log(`\nProvisioning pool of ${args.poolSize} pairs...`);
  const poolT0 = Date.now();
  // Estimate flows-per-pair so the initial mint covers the full
  // expected campaign without mid-run top-ups in the common case.
  const expectedFlowsPerPair = Math.max(
    1,
    Math.ceil(args.flows / args.poolSize),
  );
  let pool: AgentPool;
  try {
    pool = await provisionAgentPool({
      connection,
      registryProgram,
      vaultProgram,
      airdropLamports: Math.floor(args.airdropSol * 1_000_000_000),
      ed25519Signer,
      config: {
        size: args.poolSize,
        escrowAmount: ESCROW_AMOUNT,
        expectedFlowsPerPair,
        // Top-up when balance falls below 5 flows worth, mint 50 more.
        // Keeps the JIT top-up rare even on long campaigns.
        topUpThresholdFlows: 5,
        topUpFlows: 50,
      },
      onMemberReady: (m) => {
        console.log(
          `  pool[${m.pairIdx}] ready: client=${m.client.authority.publicKey.toBase58().slice(0, 8)}… provider=${m.provider.authority.publicKey.toBase58().slice(0, 8)}…`,
        );
      },
    });
  } catch (err) {
    console.error(`FATAL: pool provisioning failed: ${(err as Error).message}`);
    process.exit(1);
  }
  const poolWallSec = ((Date.now() - poolT0) / 1000).toFixed(2);
  console.log(`Pool ready (${pool.size()} pairs) in ${poolWallSec}s.\n`);

  // === Phase B: steady-state settlement load ===
  const collector = new MetricsCollector({
    scenario: "settlement-only",
    rpcUrl: args.rpcUrl,
    concurrency: args.concurrency,
    durationSec: args.durationSec,
    flows: args.flows,
  });

  const deadline = Date.now() + args.durationSec * 1000;
  let nextFlow = 0;
  let completedFlows = 0;

  // Cap concurrency at pool size — extra workers would just block on
  // pool.acquire() with no benefit (each worker holds exactly one pair
  // for the duration of one settlement cycle).
  const workerCount = Math.min(args.concurrency, args.poolSize, args.flows);
  if (workerCount < args.concurrency) {
    console.log(
      `Note: capping workers at ${workerCount} ` +
        `(min of --concurrency=${args.concurrency}, --pool-size=${args.poolSize}, --flows=${args.flows})`,
    );
  }
  console.log(`Spawning ${workerCount} worker(s); deadline at +${args.durationSec}s\n`);
  const t0 = Date.now();

  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIdx) => {
      while (true) {
        if (Date.now() >= deadline) return;
        const idx = nextFlow++;
        if (idx >= args.flows) return;

        const { member, taskId } = await pool.acquire();
        let ok = false;
        try {
          ok = await runSettlementCycle(
            idx,
            taskId,
            {
              client: {
                authority: member.client.authority,
                vaultPDA: member.client.vaultPDA,
              },
              provider: {
                authority: member.provider.authority,
                vaultPDA: member.provider.vaultPDA,
                profilePDA: member.provider.profilePDA,
                ownerNoncePDA: member.provider.ownerNoncePDA,
              },
              tokens: {
                tokenMint: member.tokens.tokenMint,
                clientTokenAccount: member.tokens.clientTokenAccount,
                providerTokenAccount: member.tokens.providerTokenAccount,
              },
            },
            { connection, settlementProgram, collector },
          );
        } finally {
          pool.release(member);
        }

        collector.recordFlowAttempt(ok);
        completedFlows += 1;
        const reportEvery = Math.max(1, Math.floor(args.flows / 10));
        if (completedFlows % reportEvery === 0) {
          const wallSec = ((Date.now() - t0) / 1000).toFixed(1);
          console.log(
            `  worker[${workerIdx}] flow=${idx} pair=${member.pairIdx} ok=${ok} ` +
              `(completed=${completedFlows}, wall=${wallSec}s)`,
          );
        }
      }
    }),
  );

  const wallSec = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\nAll workers finished after ${wallSec}s (completed=${completedFlows}).`);

  // Indexer lag — best-effort.
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

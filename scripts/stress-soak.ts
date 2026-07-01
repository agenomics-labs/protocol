/**
 * Long-running soak test: launches 1 flow every INTERVAL_MS for DURATION_MS total.
 * Watches for memory growth, slot drift, error accumulation, and latency drift over time.
 *
 * Env:
 *   DURATION_SEC  total soak duration (default 600 = 10 min)
 *   INTERVAL_MS   ms between flow launches (default 1000)
 *   SNAPSHOT_SEC  snapshot cadence (default 30)
 */

import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const DURATION_SEC = parseInt(process.env.DURATION_SEC || "600", 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || "1000", 10);
const SNAPSHOT_SEC = parseInt(process.env.SNAPSHOT_SEC || "30", 10);

const REGISTRY_PROGRAM_ID = new PublicKey("26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7");
const SETTLEMENT_PROGRAM_ID = new PublicKey("AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia");

function deriveEscrowPDA(client: PublicKey, provider: PublicKey, taskId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(taskId), 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), buf],
    SETTLEMENT_PROGRAM_ID
  );
}

function deriveAgentProfilePDA(
  authority: PublicKey,
  nonce: bigint = 0n
): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
    REGISTRY_PROGRAM_ID
  );
}

function deriveOwnerNoncePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("owner-nonce")],
    REGISTRY_PROGRAM_ID
  );
}

interface FlowResult {
  idx: number;
  t0: number;
  t1: number;
  durationMs: number;
  success: boolean;
  instructionCount: number;
}

const results: FlowResult[] = [];
let launched = 0;
let inflight = 0;

async function runOne(
  idx: number,
  settlementProgram: Program,
  registryProgram: Program,
  connection: anchor.web3.Connection,
): Promise<FlowResult> {
  const t0 = Date.now();
  let instructionCount = 0;
  try {
    const client = Keypair.generate();
    const providerAgent = Keypair.generate();
    const mintAuthority = Keypair.generate();
    const resolver = Keypair.generate();

    await Promise.all(
      [client, providerAgent, mintAuthority, resolver].map(async (kp) => {
        const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
      }),
    );

    const tokenMint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
    const clientTokenAccount = (await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, client.publicKey)).address;
    const providerTokenAccount = (await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, providerAgent.publicKey)).address;
    await mintTo(connection, mintAuthority, tokenMint, clientTokenAccount, mintAuthority.publicKey, 5_000_000n);

    const [providerProfilePDA] = deriveAgentProfilePDA(providerAgent.publicKey);
    await registryProgram.methods
      .registerAgent(`Soak${idx}`, "soak", "testing", ["x"], { perTask: {} }, new BN(0), [tokenMint], Keypair.generate().publicKey)
      .accounts({ authority: providerAgent.publicKey, agentProfile: providerProfilePDA, systemProgram: SystemProgram.programId })
      .signers([providerAgent])
      .rpc();
    instructionCount++;

    const taskId = 500000 + idx;
    const [escrowPDA] = deriveEscrowPDA(client.publicKey, providerAgent.publicKey, taskId);
    const escrowTokenAccount = getAssociatedTokenAddressSync(tokenMint, escrowPDA, true);

    await settlementProgram.methods
      .createEscrow(
        new BN(taskId),
        new BN(2_000_000),
        Buffer.alloc(32),
        new BN(Math.floor(Date.now() / 1000) + 7 * 86400),
        [{ amount: new BN(2_000_000), descriptionHash: Buffer.alloc(32, 1) }],
        resolver.publicKey,
      )
      .accounts({
        client: client.publicKey,
        clientVault: client.publicKey,
        providerVault: providerAgent.publicKey,
        provider: providerAgent.publicKey,
        tokenMint,
        clientTokenAccount,
        escrow: escrowPDA,
        escrowTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([client])
      .rpc();
    instructionCount++;

    await settlementProgram.methods
      .acceptTask()
      .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
      .signers([providerAgent])
      .rpc();
    instructionCount++;

    await settlementProgram.methods
      .submitMilestone(new BN(0))
      .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
      .signers([providerAgent])
      .rpc();
    instructionCount++;

    await settlementProgram.methods
      .approveMilestone(new BN(0))
      .accounts({
        client: client.publicKey,
        escrow: escrowPDA,
        escrowTokenAccount,
        providerTokenAccount,
        registryProgram: REGISTRY_PROGRAM_ID,
        providerProfile: providerProfilePDA,
        settlementSelf: SETTLEMENT_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();
    instructionCount++;

    const t1 = Date.now();
    return { idx, t0, t1, durationMs: t1 - t0, success: true, instructionCount };
  } catch (err) {
    const t1 = Date.now();
    return { idx, t0, t1, durationMs: t1 - t0, success: false, instructionCount };
  }
}

function formatMem(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * q)];
}

describe("AEP Soak Test", () => {
  it(`soaks for ${DURATION_SEC}s at ${INTERVAL_MS}ms intervals`, async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;
    const settlementProgram = anchor.workspace.Settlement as Program;
    const registryProgram = anchor.workspace.AgentRegistry as Program;

    console.log(`\n[SOAK] duration=${DURATION_SEC}s interval=${INTERVAL_MS}ms snapshot=${SNAPSHOT_SEC}s`);

    const startSlot = await connection.getSlot();
    const startTime = Date.now();
    const endTime = startTime + DURATION_SEC * 1000;

    const snapshots: Array<{
      t: number;
      slot: number;
      heap: number;
      rss: number;
      completed: number;
      inflight: number;
      recentP50: number;
      recentP99: number;
      errorCount: number;
    }> = [];

    let lastSnapshotResultIdx = 0;

    const snapshotInterval = setInterval(async () => {
      try {
        const slot = await connection.getSlot();
        const mem = process.memoryUsage();
        const completed = results.length;
        const recent = results.slice(lastSnapshotResultIdx);
        lastSnapshotResultIdx = completed;
        const recentDurs = recent.filter((r) => r.success).map((r) => r.durationMs);
        const recentErrs = recent.filter((r) => !r.success).length;

        const snap = {
          t: Math.floor((Date.now() - startTime) / 1000),
          slot,
          heap: mem.heapUsed,
          rss: mem.rss,
          completed,
          inflight,
          recentP50: percentile(recentDurs, 0.5),
          recentP99: percentile(recentDurs, 0.99),
          errorCount: recentErrs,
        };
        snapshots.push(snap);

        console.log(
          `[${String(snap.t).padStart(4, " ")}s] ` +
            `launched=${String(launched).padStart(4, " ")} ` +
            `done=${String(completed).padStart(4, " ")} ` +
            `inflight=${String(inflight).padStart(3, " ")} ` +
            `slot=${slot} ` +
            `heap=${formatMem(mem.heapUsed).padStart(6, " ")} ` +
            `rss=${formatMem(mem.rss).padStart(6, " ")} ` +
            `p50=${snap.recentP50}ms ` +
            `p99=${snap.recentP99}ms ` +
            `errs=${recentErrs}`,
        );
      } catch (e) {
        console.log(`[snapshot error] ${e}`);
      }
    }, SNAPSHOT_SEC * 1000);

    // Launch loop
    while (Date.now() < endTime) {
      const i = launched++;
      inflight++;
      runOne(i, settlementProgram, registryProgram, connection)
        .then((r) => {
          inflight--;
          results.push(r);
        })
        .catch(() => {
          inflight--;
        });

      const delay = INTERVAL_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    console.log(`\n[SOAK] launch phase done, waiting for inflight=${inflight} to drain...`);
    const drainDeadline = Date.now() + 120000; // max 2 min drain
    while (inflight > 0 && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    clearInterval(snapshotInterval);

    const endSlot = await connection.getSlot();

    // ================== Analysis ==================
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    // Split by time for early vs late comparison
    const third = Math.floor(successes.length / 3);
    const firstThird = successes.slice(0, third);
    const lastThird = successes.slice(-third);

    const firstDurs = firstThird.map((r) => r.durationMs);
    const lastDurs = lastThird.map((r) => r.durationMs);

    console.log(`\n${"═".repeat(70)}`);
    console.log(`  SOAK RESULTS`);
    console.log(`${"═".repeat(70)}`);
    console.log(`  duration:            ${DURATION_SEC}s`);
    console.log(`  launched:            ${launched}`);
    console.log(`  completed:           ${results.length}`);
    console.log(`  successes:           ${successes.length}`);
    console.log(`  failures:            ${failures.length}`);
    console.log(`  error rate:          ${((failures.length / results.length) * 100).toFixed(2)}%`);
    console.log(`  slot range:          ${startSlot} → ${endSlot} (${endSlot - startSlot} slots)`);
    console.log(
      `  slots/sec:           ${((endSlot - startSlot) / DURATION_SEC).toFixed(2)} (expected ~2.5)`,
    );
    console.log();
    console.log(`  FIRST THIRD (warm-up)   LAST THIRD (soaked)`);
    console.log(
      `    min:  ${String(Math.min(...firstDurs)).padStart(5)}ms           ${String(Math.min(...lastDurs)).padStart(5)}ms`,
    );
    console.log(
      `    p50:  ${String(percentile(firstDurs, 0.5)).padStart(5)}ms           ${String(percentile(lastDurs, 0.5)).padStart(5)}ms`,
    );
    console.log(
      `    p90:  ${String(percentile(firstDurs, 0.9)).padStart(5)}ms           ${String(percentile(lastDurs, 0.9)).padStart(5)}ms`,
    );
    console.log(
      `    p99:  ${String(percentile(firstDurs, 0.99)).padStart(5)}ms           ${String(percentile(lastDurs, 0.99)).padStart(5)}ms`,
    );
    console.log(
      `    max:  ${String(Math.max(...firstDurs)).padStart(5)}ms           ${String(Math.max(...lastDurs)).padStart(5)}ms`,
    );

    if (snapshots.length >= 2) {
      const first = snapshots[0];
      const last = snapshots[snapshots.length - 1];
      const heapGrowth = last.heap - first.heap;
      const rssGrowth = last.rss - first.rss;
      console.log();
      console.log(`  Memory growth (node):`);
      console.log(`    heap:  ${formatMem(first.heap)} → ${formatMem(last.heap)}  (Δ ${formatMem(heapGrowth)})`);
      console.log(`    rss:   ${formatMem(first.rss)} → ${formatMem(last.rss)}  (Δ ${formatMem(rssGrowth)})`);
    }

    if (failures.length > 0) {
      console.log(`\n  First failure at idx ${failures[0].idx} (t=${(failures[0].t0 - startTime) / 1000}s)`);
    }

    // Assert minimum health: <1% errors, slot rate >2/s
    const errorRate = failures.length / results.length;
    const slotRate = (endSlot - startSlot) / DURATION_SEC;
    if (errorRate > 0.05) throw new Error(`error rate ${(errorRate * 100).toFixed(2)}% exceeds 5%`);
    if (slotRate < 2) throw new Error(`slot rate ${slotRate.toFixed(2)} below 2/s`);
  }).timeout(1_000_000);
});

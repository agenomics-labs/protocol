/**
 * In-process stress test: N concurrent happy-path flows in a single Node runtime.
 * Each flow gets its own keypairs, mint, and escrow — fully isolated on-chain.
 *
 * Run:
 *   N=100 MODE_MIX=happy npx ts-mocha -p ./tsconfig.json -t 600000 scripts/stress-inproc.ts
 *
 * Env:
 *   N           number of parallel flows (default 100)
 *   MODE_MIX    happy | mixed (default mixed)
 *   AIRDROP     SOL per flow (default 2)
 */

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const N = parseInt(process.env.N || "100", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "0", 10); // 0 = unlimited
const MODE_MIX = process.env.MODE_MIX || "mixed";
const AIRDROP = parseFloat(process.env.AIRDROP || "2");

const REGISTRY_PROGRAM_ID = new PublicKey("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");
const SETTLEMENT_PROGRAM_ID = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");

type Mode = "happy" | "dispute" | "rework" | "cancel";

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
  mode: Mode;
  taskId: number;
  sigs: string[];
  durationMs: number;
  success: boolean;
  error?: string;
}

async function runFlow(
  idx: number,
  mode: Mode,
  settlementProgram: Program,
  registryProgram: Program,
  connection: anchor.web3.Connection,
): Promise<FlowResult> {
  const t0 = Date.now();
  const sigs: string[] = [];
  const taskId = 200000 + idx * 17;

  try {
    const client = Keypair.generate();
    const providerAgent = Keypair.generate();
    const mintAuthority = Keypair.generate();
    const resolver = Keypair.generate();

    // Airdrop in parallel
    await Promise.all(
      [client, providerAgent, mintAuthority, resolver].map(async (kp) => {
        const sig = await connection.requestAirdrop(kp.publicKey, AIRDROP * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig);
      }),
    );

    const tokenMint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
    const clientTokenAccount = (
      await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, client.publicKey)
    ).address;
    const providerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, providerAgent.publicKey)
    ).address;
    await mintTo(connection, mintAuthority, tokenMint, clientTokenAccount, mintAuthority.publicKey, 10_000_000n);

    const [providerProfilePDA] = deriveAgentProfilePDA(providerAgent.publicKey);
    sigs.push(
      await registryProgram.methods
        .registerAgent(
          `P${idx}`,
          "stress",
          "testing",
          ["stress"],
          { perTask: {} },
          new BN(0),
          [tokenMint],
          Keypair.generate().publicKey,
        )
        .accounts({
          authority: providerAgent.publicKey,
          ownerNonce: deriveOwnerNoncePDA(providerAgent.publicKey)[0],
          agentProfile: providerProfilePDA,
          systemProgram: SystemProgram.programId,
        })
        .signers([providerAgent])
        .rpc(),
    );

    const [escrowPDA] = deriveEscrowPDA(client.publicKey, providerAgent.publicKey, taskId);
    const escrowTokenAccount = getAssociatedTokenAddressSync(tokenMint, escrowPDA, true);
    const total = 3_000_000n;
    const m1 = 1_500_000n;
    const m2 = 1_500_000n;

    sigs.push(
      await settlementProgram.methods
        .createEscrow(
          new BN(taskId),
          new BN(total.toString()),
          Buffer.alloc(32),
          new BN(Math.floor(Date.now() / 1000) + 7 * 86400),
          [
            { amount: new BN(m1.toString()), descriptionHash: Buffer.alloc(32, 1) },
            { amount: new BN(m2.toString()), descriptionHash: Buffer.alloc(32, 2) },
          ],
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
        .rpc(),
    );

    if (mode === "cancel") {
      sigs.push(
        await settlementProgram.methods
          .cancelEscrow()
          .accounts({
            client: client.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount,
            clientTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([client])
          .rpc(),
      );
      return { idx, mode, taskId, sigs, durationMs: Date.now() - t0, success: true };
    }

    sigs.push(
      await settlementProgram.methods
        .acceptTask()
        .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
        .signers([providerAgent])
        .rpc(),
    );

    sigs.push(
      await settlementProgram.methods
        .submitMilestone(new BN(0))
        .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
        .signers([providerAgent])
        .rpc(),
    );

    if (mode === "dispute") {
      sigs.push(
        await settlementProgram.methods
          .raiseDispute()
          .accounts({ requester: client.publicKey, escrow: escrowPDA })
          .signers([client])
          .rpc(),
      );
      sigs.push(
        await settlementProgram.methods
          .resolveDispute(new BN(1_500_000), new BN(1_500_000))
          .accounts({
            resolver: resolver.publicKey,
            escrow: escrowPDA,
            escrowTokenAccount,
            clientTokenAccount,
            providerTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([resolver])
          .rpc(),
      );
      return { idx, mode, taskId, sigs, durationMs: Date.now() - t0, success: true };
    }

    if (mode === "rework") {
      sigs.push(
        await settlementProgram.methods
          .rejectMilestone(new BN(0))
          .accounts({ client: client.publicKey, escrow: escrowPDA })
          .signers([client])
          .rpc(),
      );
      sigs.push(
        await settlementProgram.methods
          .submitMilestone(new BN(0))
          .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
          .signers([providerAgent])
          .rpc(),
      );
    }

    // happy + rework both continue with approve → submit 1 → approve 1
    sigs.push(
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
        .rpc(),
    );

    sigs.push(
      await settlementProgram.methods
        .submitMilestone(new BN(1))
        .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
        .signers([providerAgent])
        .rpc(),
    );

    sigs.push(
      await settlementProgram.methods
        .approveMilestone(new BN(1))
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
        .rpc(),
    );

    return { idx, mode, taskId, sigs, durationMs: Date.now() - t0, success: true };
  } catch (err: any) {
    return { idx, mode, taskId, sigs, durationMs: Date.now() - t0, success: false, error: err.message || String(err) };
  }
}

function pickMode(idx: number): Mode {
  if (MODE_MIX === "happy") return "happy";
  const r = idx % 10;
  if (r < 6) return "happy";
  if (r < 8) return "rework";
  if (r === 8) return "dispute";
  return "cancel";
}

describe("AEP In-Process Stress", () => {
  it(`runs ${N} parallel flows (${MODE_MIX})`, async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;
    const settlementProgram = anchor.workspace.Settlement as Program;
    const registryProgram = anchor.workspace.AgentRegistry as Program;

    console.log(`\n[STRESS] Launching ${N} concurrent flows (mix=${MODE_MIX})...`);

    const firstSlot = await connection.getSlot();
    const t0 = Date.now();

    // Bounded concurrency: worker pool pattern
    const results: FlowResult[] = new Array(N);
    let next = 0;
    const limit = CONCURRENCY > 0 ? Math.min(CONCURRENCY, N) : N;
    const workers = Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= N) return;
        results[i] = await runFlow(i, pickMode(i), settlementProgram, registryProgram, connection);
      }
    });
    await Promise.all(workers);

    const t1 = Date.now();
    const lastSlot = await connection.getSlot();
    const wallMs = t1 - t0;

    const pass = results.filter((r) => r.success).length;
    const fail = results.length - pass;
    const allSigs = results.flatMap((r) => r.sigs);
    const uniqueSigs = new Set(allSigs);

    const durs = results.map((r) => r.durationMs).sort((a, b) => a - b);
    const p = (q: number) => durs[Math.floor(durs.length * q)];

    const modes = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.mode] = (acc[r.mode] || 0) + 1;
      return acc;
    }, {});

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  STRESS RESULTS — ${N} parallel flows`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  passing:           ${pass} / ${N}`);
    console.log(`  failing:           ${fail}`);
    console.log(`  total instructions:${allSigs.length}`);
    console.log(`  unique sigs:       ${uniqueSigs.size}`);
    console.log(`  wall clock:        ${(wallMs / 1000).toFixed(2)}s`);
    console.log(`  slot range:        ${firstSlot} → ${lastSlot} (${lastSlot - firstSlot} slots)`);
    console.log(`  effective TPS:     ${(uniqueSigs.size / (wallMs / 1000)).toFixed(1)} tx/sec`);
    console.log();
    console.log(`  per-flow latency (ms):`);
    console.log(`    min:  ${durs[0]}  p50: ${p(0.5)}  p90: ${p(0.9)}  p99: ${p(0.99)}  max: ${durs[durs.length - 1]}`);
    console.log(`    mean: ${Math.round(durs.reduce((a, b) => a + b, 0) / durs.length)}`);
    console.log();
    console.log(`  mode mix: ${JSON.stringify(modes)}`);

    if (fail > 0) {
      console.log(`\n  FAILURES:`);
      for (const r of results.filter((x) => !x.success).slice(0, 10)) {
        console.log(`    [${r.idx}] ${r.mode} task=${r.taskId}: ${r.error?.slice(0, 120)}`);
      }
    }

    if (fail > 0) throw new Error(`${fail}/${N} flows failed`);
  }).timeout(600000);
});

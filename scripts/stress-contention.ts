/**
 * Same-account contention test.
 *
 * Probes Solana's account locking: when N concurrent txs all write to the same
 * account, the runtime must serialize them. We expect exactly 1 winner per
 * transition and N-1 losers, with losses caused by program-level state checks
 * (not runtime lock errors).
 *
 * Tests four race conditions:
 *   1. ACCEPT_RACE:  N parallel acceptTask on one escrow
 *   2. CANCEL_RACE:  N parallel cancelEscrow on one escrow
 *   3. SUBMIT_RACE:  N parallel submitMilestone(0) on one accepted escrow
 *   4. APPROVE_RACE: N parallel approveMilestone(0) after submission
 */

import BN from "bn.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const N = parseInt(process.env.N || "15", 10);

const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
const SETTLEMENT_PROGRAM_ID = new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

function deriveEscrowPDA(client: PublicKey, provider: PublicKey, taskId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(taskId), 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), buf],
    SETTLEMENT_PROGRAM_ID
  );
}

function deriveAgentProfilePDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );
}

interface Attempt {
  ok: boolean;
  sig?: string;
  slot?: number;
  errKind?: string;
  errMsg?: string;
}

function classify(err: any): { errKind: string; errMsg: string } {
  const msg: string = err?.message || String(err);
  // Try common Anchor error codes
  if (msg.includes("custom program error")) {
    const m = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
    return { errKind: `CustomProgramError ${m?.[1] || "?"}`, errMsg: msg.slice(0, 200) };
  }
  if (msg.includes("InvalidStatus") || msg.includes("InvalidState")) return { errKind: "InvalidStatus", errMsg: msg.slice(0, 200) };
  if (msg.includes("already in use")) return { errKind: "AccountAlreadyInUse", errMsg: msg.slice(0, 200) };
  if (msg.includes("Blockhash not found")) return { errKind: "BlockhashNotFound", errMsg: msg.slice(0, 200) };
  if (msg.includes("simulation failed")) return { errKind: "SimulationFailed", errMsg: msg.slice(0, 200) };
  if (msg.includes("Transaction was not confirmed")) return { errKind: "Timeout", errMsg: msg.slice(0, 200) };
  return { errKind: "Other", errMsg: msg.slice(0, 200) };
}

async function race<T>(label: string, n: number, factory: (nonce: number) => Promise<string>): Promise<Attempt[]> {
  // Nonce is applied via a unique ComputeBudget preInstruction so each tx has a distinct signature.
  const attempts = Array.from({ length: n }, (_, i) => factory(400000 + i));
  const settled = await Promise.allSettled(attempts);
  const out: Attempt[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") {
      out.push({ ok: true, sig: s.value });
    } else {
      const { errKind, errMsg } = classify(s.reason);
      out.push({ ok: false, errKind, errMsg });
    }
  }
  return out;
}

function summarize(label: string, attempts: Attempt[]) {
  const wins = attempts.filter((a) => a.ok);
  const losses = attempts.filter((a) => !a.ok);
  const errCounts: Record<string, number> = {};
  for (const l of losses) errCounts[l.errKind!] = (errCounts[l.errKind!] || 0) + 1;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  attempts:     ${attempts.length}`);
  console.log(`  winners:      ${wins.length}`);
  console.log(`  losers:       ${losses.length}`);
  console.log(`  error mix:    ${JSON.stringify(errCounts)}`);
  if (wins.length > 0) {
    console.log(`  winning sigs: ${wins.map((w) => w.sig!.slice(0, 12)).join(", ")}`);
  }
  if (losses.length > 0 && losses[0].errMsg) {
    console.log(`  sample err:   ${losses[0].errMsg.slice(0, 150)}`);
  }
  return { wins: wins.length, losses: losses.length, errCounts };
}

async function setupEscrow(
  connection: anchor.web3.Connection,
  settlementProgram: Program,
  registryProgram: Program,
  taskId: number,
) {
  const client = Keypair.generate();
  const providerAgent = Keypair.generate();
  const mintAuthority = Keypair.generate();
  const resolver = Keypair.generate();

  await Promise.all(
    [client, providerAgent, mintAuthority, resolver].map(async (kp) => {
      const sig = await connection.requestAirdrop(kp.publicKey, 3 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }),
  );

  const tokenMint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
  const clientTokenAccount = (await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, client.publicKey)).address;
  const providerTokenAccount = (await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, providerAgent.publicKey)).address;
  await mintTo(connection, mintAuthority, tokenMint, clientTokenAccount, mintAuthority.publicKey, 10_000_000n);

  const [providerProfilePDA] = deriveAgentProfilePDA(providerAgent.publicKey);
  await registryProgram.methods
    .registerAgent(`P${taskId}`, "contention", "testing", ["x"], { perTask: {} }, new BN(0), [tokenMint], Keypair.generate().publicKey)
    .accounts({ authority: providerAgent.publicKey, agentProfile: providerProfilePDA, systemProgram: SystemProgram.programId })
    .signers([providerAgent])
    .rpc();

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

  return { client, providerAgent, resolver, tokenMint, clientTokenAccount, providerTokenAccount, providerProfilePDA, escrowPDA, escrowTokenAccount };
}

describe("AEP Same-Account Contention", () => {
  it(`probes lock conflicts with ${N} concurrent writers`, async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;
    const settlementProgram = anchor.workspace.Settlement as Program;
    const registryProgram = anchor.workspace.AgentRegistry as Program;

    const summary: Record<string, { wins: number; losses: number }> = {};

    // ====================================================================
    // TEST 1: ACCEPT RACE
    // ====================================================================
    console.log(`\n[TEST 1] Setting up escrow for ACCEPT race...`);
    const s1 = await setupEscrow(connection, settlementProgram, registryProgram, 900001);
    console.log(`  escrow=${s1.escrowPDA.toBase58().slice(0, 16)}...`);

    const r1 = await race("ACCEPT_RACE", N, (nonce) =>
      settlementProgram.methods
        .acceptTask()
        .accounts({ provider: s1.providerAgent.publicKey, escrow: s1.escrowPDA })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: nonce })])
        .signers([s1.providerAgent])
        .rpc(),
    );
    summary["ACCEPT_RACE"] = summarize(`TEST 1: ACCEPT RACE (${N} concurrent acceptTask on one escrow)`, r1);

    // ====================================================================
    // TEST 2: CANCEL RACE
    // ====================================================================
    console.log(`\n[TEST 2] Setting up escrow for CANCEL race...`);
    const s2 = await setupEscrow(connection, settlementProgram, registryProgram, 900002);

    const r2 = await race("CANCEL_RACE", N, (nonce) =>
      settlementProgram.methods
        .cancelEscrow()
        .accounts({
          client: s2.client.publicKey,
          escrow: s2.escrowPDA,
          escrowTokenAccount: s2.escrowTokenAccount,
          clientTokenAccount: s2.clientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: nonce })])
        .signers([s2.client])
        .rpc(),
    );
    summary["CANCEL_RACE"] = summarize(`TEST 2: CANCEL RACE (${N} concurrent cancelEscrow)`, r2);

    // ====================================================================
    // TEST 3: SUBMIT RACE (on accepted escrow)
    // ====================================================================
    console.log(`\n[TEST 3] Setting up escrow for SUBMIT race...`);
    const s3 = await setupEscrow(connection, settlementProgram, registryProgram, 900003);
    await settlementProgram.methods
      .acceptTask()
      .accounts({ provider: s3.providerAgent.publicKey, escrow: s3.escrowPDA })
      .signers([s3.providerAgent])
      .rpc();

    const r3 = await race("SUBMIT_RACE", N, (nonce) =>
      settlementProgram.methods
        .submitMilestone(new BN(0))
        .accounts({ provider: s3.providerAgent.publicKey, escrow: s3.escrowPDA })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: nonce })])
        .signers([s3.providerAgent])
        .rpc(),
    );
    summary["SUBMIT_RACE"] = summarize(`TEST 3: SUBMIT RACE (${N} concurrent submitMilestone(0))`, r3);

    // ====================================================================
    // TEST 4: APPROVE RACE (on submitted milestone)
    // ====================================================================
    console.log(`\n[TEST 4] Setting up escrow for APPROVE race...`);
    const s4 = await setupEscrow(connection, settlementProgram, registryProgram, 900004);
    await settlementProgram.methods
      .acceptTask()
      .accounts({ provider: s4.providerAgent.publicKey, escrow: s4.escrowPDA })
      .signers([s4.providerAgent])
      .rpc();
    await settlementProgram.methods
      .submitMilestone(new BN(0))
      .accounts({ provider: s4.providerAgent.publicKey, escrow: s4.escrowPDA })
      .signers([s4.providerAgent])
      .rpc();

    const r4 = await race("APPROVE_RACE", N, (nonce) =>
      settlementProgram.methods
        .approveMilestone(new BN(0))
        .accounts({
          client: s4.client.publicKey,
          escrow: s4.escrowPDA,
          escrowTokenAccount: s4.escrowTokenAccount,
          providerTokenAccount: s4.providerTokenAccount,
          registryProgram: REGISTRY_PROGRAM_ID,
          providerProfile: s4.providerProfilePDA,
          settlementSelf: SETTLEMENT_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: nonce })])
        .signers([s4.client])
        .rpc(),
    );
    summary["APPROVE_RACE"] = summarize(`TEST 4: APPROVE RACE (${N} concurrent approveMilestone(0))`, r4);

    // ====================================================================
    // FINAL VERDICT
    // ====================================================================
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  CONTENTION SUMMARY`);
    console.log(`${"═".repeat(60)}`);
    for (const [test, { wins, losses }] of Object.entries(summary)) {
      const expected = wins === 1 ? "✓ exactly 1 winner" : `⚠ ${wins} winners`;
      console.log(`  ${test.padEnd(16)} ${wins}W/${losses}L  ${expected}`);
    }

    // Assert the invariant: every race should have exactly 1 winner
    for (const [test, { wins }] of Object.entries(summary)) {
      if (wins !== 1) {
        throw new Error(`${test}: expected exactly 1 winner, got ${wins}`);
      }
    }
  }).timeout(600000);
});

/**
 * AEP Flow Runner — parameterized single-flow demo used for parallel testing.
 *
 * Env:
 *   FLOW_LABEL   — short tag for console output (e.g. "DISPUTE", "REWORK")
 *   FLOW_MODE    — dispute | rework
 *   FLOW_TASK_ID — unique numeric task id (keeps PDAs isolated per run)
 *   FLOW_TOTAL   — total escrow amount in mint micro-units
 *   FLOW_M1      — milestone 1 amount (micro-units)
 *   FLOW_M2      — milestone 2 amount (micro-units, 0 = single milestone)
 *
 * Run: ts-mocha scripts/flow-runner.ts
 */

import BN from "bn.js";
import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
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

const LABEL = process.env.FLOW_LABEL || "FLOW";
const MODE = (process.env.FLOW_MODE || "dispute") as "dispute" | "rework" | "happy" | "cancel";
const TASK_ID = parseInt(process.env.FLOW_TASK_ID || "1000", 10);
const TOTAL = BigInt(process.env.FLOW_TOTAL || "3000000");
const M1 = BigInt(process.env.FLOW_M1 || "1000000");
const M2 = BigInt(process.env.FLOW_M2 || "2000000");

const REGISTRY_PROGRAM_ID = new PublicKey("psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv");
const SETTLEMENT_PROGRAM_ID = new PublicKey("9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95");

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

const tag = (msg: string) => `[${LABEL}] ${msg}`;
const log = (msg: string) => console.log(tag(msg));

describe(`AEP Flow Runner — ${LABEL}`, () => {
  it(`runs ${MODE} flow (task ${TASK_ID})`, async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const connection = provider.connection;

    const settlementProgram = anchor.workspace.Settlement as Program;
    const registryProgram = anchor.workspace.AgentRegistry as Program;

    const client = Keypair.generate();
    const providerAgent = Keypair.generate();
    const mintAuthority = Keypair.generate();
    const resolver = Keypair.generate();

    log(`client=${client.publicKey.toBase58().slice(0, 10)}... provider=${providerAgent.publicKey.toBase58().slice(0, 10)}...`);

    for (const kp of [client, providerAgent, mintAuthority, resolver]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig);
    }
    log("funded 4 accounts");

    const tokenMint = await createMint(connection, mintAuthority, mintAuthority.publicKey, null, 6);
    log(`mint=${tokenMint.toBase58().slice(0, 10)}...`);

    const clientTokenAccount = (
      await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, client.publicKey)
    ).address;
    const providerTokenAccount = (
      await getOrCreateAssociatedTokenAccount(connection, client, tokenMint, providerAgent.publicKey)
    ).address;
    await mintTo(connection, mintAuthority, tokenMint, clientTokenAccount, mintAuthority.publicKey, TOTAL + 1_000_000n);
    log(`minted ${Number(TOTAL) / 1_000_000} USDC to client`);

    // Register provider in registry so reputation CPI has a target for rework flow
    const [providerProfilePDA] = deriveAgentProfilePDA(providerAgent.publicKey);
    await registryProgram.methods
      .registerAgent(
        `Provider-${LABEL}`,
        `Flow runner provider for ${MODE}`,
        "testing",
        ["flow-runner"],
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
      .rpc();
    log(`registered provider agent profile`);

    const [escrowPDA] = deriveEscrowPDA(client.publicKey, providerAgent.publicKey, TASK_ID);
    const escrowTokenAccount = getAssociatedTokenAddressSync(tokenMint, escrowPDA, true);

    const milestones =
      M2 > 0n
        ? [
            { amount: new BN(M1.toString()), descriptionHash: Buffer.alloc(32, 1) },
            { amount: new BN(M2.toString()), descriptionHash: Buffer.alloc(32, 2) },
          ]
        : [{ amount: new BN(M1.toString()), descriptionHash: Buffer.alloc(32, 1) }];

    const createSig = await settlementProgram.methods
      .createEscrow(
        new BN(TASK_ID),
        new BN(TOTAL.toString()),
        Buffer.alloc(32),
        new BN(Math.floor(Date.now() / 1000) + 7 * 86400),
        milestones,
        resolver.publicKey, // named dispute resolver
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
    log(`create_escrow sig=${createSig.slice(0, 20)}... total=${Number(TOTAL) / 1_000_000} USDC milestones=${milestones.length}`);

    if (MODE === "cancel") {
      const cancelSig = await settlementProgram.methods
        .cancelEscrow()
        .accounts({
          client: client.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount,
          clientTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([client])
        .rpc();
      log(`cancel_escrow sig=${cancelSig.slice(0, 20)}...`);
      const cb = await connection.getTokenAccountBalance(clientTokenAccount);
      log(`FINAL client balance=${Number(cb.value.amount) / 1_000_000} USDC (full refund)`);
      log(`DONE escrow=${escrowPDA.toBase58()}`);
      return;
    }

    const acceptSig = await settlementProgram.methods
      .acceptTask()
      .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
      .signers([providerAgent])
      .rpc();
    log(`accept_task sig=${acceptSig.slice(0, 20)}...`);

    const submitSig = await settlementProgram.methods
      .submitMilestone(new BN(0))
      .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
      .signers([providerAgent])
      .rpc();
    log(`submit_milestone(0) sig=${submitSig.slice(0, 20)}...`);

    if (MODE === "dispute") {
      const raiseSig = await settlementProgram.methods
        .raiseDispute()
        .accounts({ requester: client.publicKey, escrow: escrowPDA })
        .signers([client])
        .rpc();
      log(`raise_dispute sig=${raiseSig.slice(0, 20)}...`);

      const clientRefund = new BN((TOTAL / 2n).toString());
      const providerRefund = new BN((TOTAL - TOTAL / 2n).toString());
      const resolveSig = await settlementProgram.methods
        .resolveDispute(clientRefund, providerRefund)
        .accounts({
          resolver: resolver.publicKey,
          escrow: escrowPDA,
          escrowTokenAccount,
          clientTokenAccount,
          providerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([resolver])
        .rpc();
      log(`resolve_dispute 50/50 sig=${resolveSig.slice(0, 20)}...`);

      const cb = await connection.getTokenAccountBalance(clientTokenAccount);
      const pb = await connection.getTokenAccountBalance(providerTokenAccount);
      log(`FINAL balances client=${Number(cb.value.amount) / 1_000_000} provider=${Number(pb.value.amount) / 1_000_000}`);
    } else if (MODE === "rework") {
      const rejectSig = await settlementProgram.methods
        .rejectMilestone(new BN(0))
        .accounts({ client: client.publicKey, escrow: escrowPDA })
        .signers([client])
        .rpc();
      log(`reject_milestone(0) sig=${rejectSig.slice(0, 20)}...`);

      const resubmitSig = await settlementProgram.methods
        .submitMilestone(new BN(0))
        .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
        .signers([providerAgent])
        .rpc();
      log(`re-submit_milestone(0) sig=${resubmitSig.slice(0, 20)}...`);

      const approveSig = await settlementProgram.methods
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
      log(`approve_milestone(0) sig=${approveSig.slice(0, 20)}...`);

      const pb = await connection.getTokenAccountBalance(providerTokenAccount);
      log(`FINAL provider balance=${Number(pb.value.amount) / 1_000_000} USDC`);
    } else if (MODE === "happy") {
      const approve0 = await settlementProgram.methods
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
      log(`approve_milestone(0) sig=${approve0.slice(0, 20)}...`);

      if (M2 > 0n) {
        const submit1 = await settlementProgram.methods
          .submitMilestone(new BN(1))
          .accounts({ provider: providerAgent.publicKey, escrow: escrowPDA })
          .signers([providerAgent])
          .rpc();
        log(`submit_milestone(1) sig=${submit1.slice(0, 20)}...`);

        const approve1 = await settlementProgram.methods
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
          .rpc();
        log(`approve_milestone(1) sig=${approve1.slice(0, 20)}...`);
      }
      const pb = await connection.getTokenAccountBalance(providerTokenAccount);
      log(`FINAL provider balance=${Number(pb.value.amount) / 1_000_000} USDC (full payout)`);
    }

    log(`DONE escrow=${escrowPDA.toBase58()}`);
  }).timeout(120000);
});

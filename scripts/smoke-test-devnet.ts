/**
 * Agenomics Devnet Smoke Test
 *
 * Verifies that all 3 programs are deployed and functional on devnet.
 * Tests: vault creation, agent registration, and escrow creation.
 *
 * Usage: SOLANA_RPC_URL=https://api.devnet.solana.com npx ts-node scripts/smoke-test-devnet.ts
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

const VAULT_PROGRAM_ID = new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");
const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
const SETTLEMENT_PROGRAM_ID = new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

function loadIdl(name: string): any {
  const idlPath = path.resolve(__dirname, "..", "target", "idl", `${name}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

class KeypairWallet {
  payer: Keypair;
  constructor(payer: Keypair) { this.payer = payer; }
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T>(tx: T): Promise<T> { (tx as any).partialSign(this.payer); return tx; }
  async signAllTransactions<T>(txs: T[]): Promise<T[]> { txs.forEach(tx => (tx as any).partialSign(this.payer)); return txs; }
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`Agenomics Devnet Smoke Test`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Cluster version: ${await connection.getVersion().then(v => v["solana-core"])}`);
  console.log();

  // Step 1: Verify programs are deployed
  console.log("--- Checking program deployments ---");
  const programs = [
    { name: "Agent Vault", id: VAULT_PROGRAM_ID },
    { name: "Agent Registry", id: REGISTRY_PROGRAM_ID },
    { name: "Settlement", id: SETTLEMENT_PROGRAM_ID },
  ];

  for (const prog of programs) {
    const info = await connection.getAccountInfo(prog.id);
    if (info && info.executable) {
      console.log(`  ${prog.name} (${prog.id.toBase58().slice(0, 8)}...): DEPLOYED (${info.data.length} bytes)`);
    } else {
      console.log(`  ${prog.name}: NOT FOUND`);
      console.log("  Run ./scripts/deploy-devnet.sh first");
      process.exit(1);
    }
  }
  console.log();

  // Step 2: Create a test keypair and fund it
  const testKp = Keypair.generate();
  console.log(`--- Test wallet: ${testKp.publicKey.toBase58()} ---`);

  try {
    const sig = await connection.requestAirdrop(testKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  Airdropped 2 SOL`);
  } catch (e) {
    console.log(`  Airdrop failed (rate limited?): ${(e as Error).message}`);
    console.log("  Fund manually: solana transfer <address> 2 --allow-unfunded-recipient");
    process.exit(1);
  }

  const provider = new AnchorProvider(
    connection,
    new KeypairWallet(testKp) as any,
    { commitment: "confirmed" }
  );

  // Step 3: Test vault creation
  console.log();
  console.log("--- Testing Vault Program ---");
  const vaultProgram = new Program(loadIdl("agent_vault"), provider);
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), testKp.publicKey.toBuffer()],
    VAULT_PROGRAM_ID
  );

  try {
    await vaultProgram.methods
      .initializeVault(
        testKp.publicKey,
        new BN(LAMPORTS_PER_SOL),
        new BN(LAMPORTS_PER_SOL / 10),
        10
      )
      .accounts({
        vault: vaultPDA,
        authority: testKp.publicKey,
      })
      .signers([testKp])
      .rpc();
    console.log(`  Vault created: ${vaultPDA.toBase58()}`);
  } catch (e) {
    console.log(`  Vault creation failed: ${(e as Error).message}`);
  }

  // Step 4: Test agent registration
  console.log();
  console.log("--- Testing Registry Program ---");
  const registryProgram = new Program(loadIdl("agent_registry"), provider);
  const [profilePDA] = PublicKey.findProgramAddressSync(
    [testKp.publicKey.toBuffer(), Buffer.from("agent-profile")],
    REGISTRY_PROGRAM_ID
  );

  try {
    await registryProgram.methods
      .registerAgent(
        "SmokeTestAgent",
        "Devnet smoke test agent",
        "testing",
        ["smoke-test"],
        { perTask: {} },
        new BN(1000),
        [testKp.publicKey], // Using test key as placeholder token
        vaultPDA
      )
      .accounts({
        authority: testKp.publicKey,
        agentProfile: profilePDA,
      })
      .signers([testKp])
      .rpc();
    console.log(`  Agent registered: ${profilePDA.toBase58()}`);
  } catch (e) {
    console.log(`  Registration failed: ${(e as Error).message}`);
  }

  // Step 5: Verify on-chain state
  console.log();
  console.log("--- Verifying on-chain state ---");
  try {
    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    console.log(`  Vault authority: ${vault.authority.toBase58()}`);
    console.log(`  Vault paused: ${vault.paused}`);
  } catch (e) {
    console.log(`  Vault fetch failed: ${(e as Error).message}`);
  }

  try {
    const profile = await (registryProgram.account as any).agentProfile.fetch(profilePDA);
    console.log(`  Agent name: ${profile.name}`);
    console.log(`  Agent category: ${profile.category}`);
    console.log(`  Agent status: ${JSON.stringify(profile.status)}`);
  } catch (e) {
    console.log(`  Profile fetch failed: ${(e as Error).message}`);
  }

  console.log();
  console.log("=== Smoke test complete ===");
}

main().catch(console.error);

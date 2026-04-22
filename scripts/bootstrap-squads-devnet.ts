#!/usr/bin/env tsx
/**
 * Bootstrap a Squads v4 multisig on Solana devnet for Agenomics Protocol.
 *
 * Scope: devnet v1 bootstrap only. Creates a 2-of-3 multisig intended to
 * serve as the `AEP_PROTOCOL` SAS credential authority (per ADR-063, with
 * the devnet composition reduced to 2-of-3 while mainnet settles on 3-of-5).
 *
 * This script does NOT:
 *   - Touch mainnet.
 *   - Transfer program upgrade authority.
 *   - Create SAS credentials (that is the follow-up ceremony).
 *
 * Idempotent: if `scripts/.squads-devnet.json` already exists and the
 * recorded multisig PDA is live on-chain, the script exits without
 * mutating state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

const { Permissions } = multisig.types;

// -- Constants ---------------------------------------------------------------

const CLUSTER_URL = 'https://api.devnet.solana.com';
const CLUSTER_NAME = 'devnet';
const THRESHOLD = 2;

const REPO_ROOT = path.resolve(__dirname, '..');
const KEYS_DIR = path.join(REPO_ROOT, '.keys');
const SIGNER_2_PATH = path.join(KEYS_DIR, 'squads-signer-2.json');
const SIGNER_3_PATH = path.join(KEYS_DIR, 'squads-signer-3.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'scripts', '.squads-devnet.json');
const SIGNER_1_PATH = path.join(
  process.env.HOME ?? '',
  '.config',
  'solana',
  'id.json',
);

// Minimum balance we top up signers 2/3 to (so they can sign follow-up txs).
const SIGNER_MIN_LAMPORTS = Math.floor(0.02 * LAMPORTS_PER_SOL);

// -- Types -------------------------------------------------------------------

interface BootstrapRecord {
  cluster: string;
  multisigProgramId: string;
  multisigPda: string;
  createKey: string;
  threshold: number;
  members: string[];
  createdAt: string;
  createSignature: string;
}

// -- Helpers -----------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

function loadOrCreateKeypair(filePath: string): { kp: Keypair; created: boolean } {
  if (fs.existsSync(filePath)) {
    return { kp: loadKeypair(filePath), created: false };
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(Array.from(kp.secretKey)),
    { mode: 0o600 },
  );
  return { kp, created: true };
}

async function fundIfEmpty(
  connection: Connection,
  funder: Keypair,
  target: PublicKey,
  minLamports: number,
  label: string,
): Promise<string | null> {
  const balance = await connection.getBalance(target, 'confirmed');
  if (balance >= minLamports) {
    console.log(
      `  [skip] ${label} already funded: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
    );
    return null;
  }
  const topUp = minLamports - balance;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: target,
      lamports: topUp,
    }),
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [funder], {
    commitment: 'confirmed',
  });
  console.log(
    `  [fund] ${label} topped up ${(topUp / LAMPORTS_PER_SOL).toFixed(4)} SOL (sig ${sig})`,
  );
  return sig;
}

async function readExistingRecord(): Promise<BootstrapRecord | null> {
  if (!fs.existsSync(OUTPUT_PATH)) return null;
  try {
    const parsed: BootstrapRecord = JSON.parse(
      fs.readFileSync(OUTPUT_PATH, 'utf8'),
    );
    if (!parsed.multisigPda) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function isMultisigLive(
  connection: Connection,
  multisigPda: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(multisigPda, 'confirmed');
  return info !== null && info.data.length > 0;
}

async function readMultisigWithRetry(
  connection: Connection,
  multisigPda: PublicKey,
  attempts = 10,
  delayMs = 1500,
): Promise<multisig.accounts.Multisig> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Use finalized so we don't race a node that's behind on a recent write.
      return await multisig.accounts.Multisig.fromAccountAddress(
        connection,
        multisigPda,
        'finalized',
      );
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `Multisig at ${multisigPda.toBase58()} not readable after ${attempts} attempts: ${String(lastErr)}`,
  );
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log(`Bootstrapping Squads v4 multisig on ${CLUSTER_NAME}...`);

  // 1. Wallet / signer 1 (must exist).
  if (!fs.existsSync(SIGNER_1_PATH)) {
    throw new Error(`Signer 1 keypair not found at ${SIGNER_1_PATH}`);
  }
  const signer1 = loadKeypair(SIGNER_1_PATH);
  console.log(`Signer 1: ${signer1.publicKey.toBase58()}`);

  const connection = new Connection(CLUSTER_URL, 'confirmed');

  // 2. Idempotency check — bail out early if we've already bootstrapped.
  const existing = await readExistingRecord();
  if (existing) {
    const live = await isMultisigLive(
      connection,
      new PublicKey(existing.multisigPda),
    );
    if (live) {
      console.log('Existing multisig detected and live on-chain:');
      console.log(`  Multisig PDA: ${existing.multisigPda}`);
      console.log(`  Threshold:    ${existing.threshold}`);
      console.log(`  Members:      ${existing.members.join(', ')}`);
      console.log(`  Create tx:    ${existing.createSignature}`);
      console.log('Nothing to do. Exiting.');
      return;
    }
    console.warn(
      `Found ${OUTPUT_PATH} but multisig ${existing.multisigPda} is not live; re-creating.`,
    );
  }

  // 3. Fund wallet sanity check.
  const funderBalance = await connection.getBalance(signer1.publicKey);
  console.log(
    `Funder balance: ${(funderBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
  );
  if (funderBalance < 0.2 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Funder (${signer1.publicKey.toBase58()}) has insufficient balance; need >= 0.2 SOL on devnet.`,
    );
  }

  // 4. Generate / load signers 2 and 3.
  const { kp: signer2, created: s2Created } = loadOrCreateKeypair(SIGNER_2_PATH);
  const { kp: signer3, created: s3Created } = loadOrCreateKeypair(SIGNER_3_PATH);
  console.log(
    `Signer 2: ${signer2.publicKey.toBase58()} ${s2Created ? '(generated)' : '(loaded)'}`,
  );
  console.log(
    `Signer 3: ${signer3.publicKey.toBase58()} ${s3Created ? '(generated)' : '(loaded)'}`,
  );

  // 5. Fund signers 2 & 3 enough to pay fees on future proposal votes.
  console.log('Ensuring signers are funded...');
  await fundIfEmpty(
    connection,
    signer1,
    signer2.publicKey,
    SIGNER_MIN_LAMPORTS,
    'Signer 2',
  );
  await fundIfEmpty(
    connection,
    signer1,
    signer3.publicKey,
    SIGNER_MIN_LAMPORTS,
    'Signer 3',
  );

  // 6. Derive multisig PDA from a fresh createKey.
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
  });
  console.log(`Derived multisig PDA: ${multisigPda.toBase58()}`);

  // 7. Resolve Squads program config treasury (required by multisigCreateV2).
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda,
  );
  const treasury = programConfig.treasury;
  console.log(`Program config treasury: ${treasury.toBase58()}`);

  // 8. Build Member list — signer1, signer2, signer3, all with full perms.
  const members = [
    { key: signer1.publicKey, permissions: Permissions.all() },
    { key: signer2.publicKey, permissions: Permissions.all() },
    { key: signer3.publicKey, permissions: Permissions.all() },
  ];

  // 9. Send the create-multisig transaction. signer1 pays + creates.
  console.log(`Creating 2-of-3 multisig (threshold=${THRESHOLD})...`);
  const createSignature = await multisig.rpc.multisigCreateV2({
    connection,
    treasury,
    createKey,
    creator: signer1,
    multisigPda,
    configAuthority: null, // controlled by its own members
    threshold: THRESHOLD,
    members,
    timeLock: 0,
    rentCollector: null,
    sendOptions: { skipPreflight: false },
  });
  console.log(`  create tx: ${createSignature}`);

  // 10. Verify the account exists and config matches. The devnet RPC node
  // that served the create tx is not guaranteed to be the same node that
  // serves the follow-up read, so we retry briefly with 'finalized'
  // commitment to give propagation time.
  const ms = await readMultisigWithRetry(connection, multisigPda);
  if (ms.threshold !== THRESHOLD) {
    throw new Error(
      `On-chain threshold (${ms.threshold}) does not match expected (${THRESHOLD}).`,
    );
  }
  if (ms.members.length !== 3) {
    throw new Error(
      `On-chain member count (${ms.members.length}) does not match expected (3).`,
    );
  }
  console.log(
    `  verified: threshold=${ms.threshold}, members=${ms.members.length}`,
  );

  // 11. Record result.
  const record: BootstrapRecord = {
    cluster: CLUSTER_NAME,
    multisigProgramId: multisig.PROGRAM_ID.toBase58(),
    multisigPda: multisigPda.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    threshold: THRESHOLD,
    members: [
      signer1.publicKey.toBase58(),
      signer2.publicKey.toBase58(),
      signer3.publicKey.toBase58(),
    ],
    createdAt: new Date().toISOString(),
    createSignature,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(record, null, 2) + '\n');
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});

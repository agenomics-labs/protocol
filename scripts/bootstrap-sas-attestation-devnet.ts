#!/usr/bin/env tsx
/**
 * Issue one test SAS attestation under the AEP_PROTOCOL credential on
 * devnet, signed via the Squads vault PDA (2-of-3 multisig).
 *
 * Step 6 of ADR-063 §5 bootstrap ceremony / STATUS.md §7.A.6. Builds
 * directly on bootstrap-sas-credential-devnet.ts (which created the
 * credential + schema PDAs). The resulting attestation is what the
 * smoke test points at to prove `@agenomics/sas-resolver`'s
 * end-to-end on-chain path before v0.1.0 publish.
 *
 * Scope: devnet only. Issues a single attestation against a stable
 * test-subject keypair (kept in `.keys/sas-test-subject-devnet.json`,
 * gitignored). Does NOT:
 *   - Touch mainnet
 *   - Run the resolver (smoke test handles that)
 *   - Mutate credential/schema PDAs
 *   - Issue real attestations for actual agents (this is a bootstrap
 *     dry-run; real attestations issue later via a different flow)
 *
 * Idempotent: if the attestation PDA is already live AND the test
 * subject keypair is already on disk, exits without mutating state.
 *
 * Wire format hand-built because `sas-lib@1.0.10` pins
 * `@solana/kit@^5` which conflicts with our `@solana/kit@^6` tree.
 * Discriminator + byte layout traced against
 * `node_modules/sas-lib/dist/src/generated/instructions/createAttestation.js`
 * (createAttestation discriminator = 6) and the PDA seed
 * (`["attestation", credential, schema, nonce]`) traced against
 * `node_modules/sas-lib/dist/src/pdas.js`. See ADR-061 §2 for the
 * AEP_AGENT_REPUTATION_v1 layout (16 bytes, U16/U32/U16/I64 LE).
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
  TransactionInstruction,
  TransactionMessage,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

// -- Constants ---------------------------------------------------------------

const CLUSTER_URL = 'https://api.devnet.solana.com';
const CLUSTER_NAME = 'devnet';

const REPO_ROOT = path.resolve(__dirname, '..');
const SQUADS_CONFIG_PATH = path.join(REPO_ROOT, 'scripts', '.squads-devnet.json');
const SAS_RECORD_PATH = path.join(REPO_ROOT, 'scripts', '.sas-devnet.json');
const SIGNER_1_PATH = path.join(
  process.env.HOME ?? '',
  '.config',
  'solana',
  'id.json',
);
const SIGNER_2_PATH = path.join(REPO_ROOT, '.keys', 'squads-signer-2.json');
const TEST_SUBJECT_PATH = path.join(
  REPO_ROOT,
  '.keys',
  'sas-test-subject-devnet.json',
);

// SAS program ID on devnet (Solana Foundation deployment).
const SAS_PROGRAM_ID = new PublicKey(
  '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
);

// PDA seed (sas-lib/src/pdas.ts: ATTESTATION_SEED = "attestation").
const SAS_ATTESTATION_SEED = Buffer.from('attestation');

// createAttestation discriminator (sas-lib/dist/.../createAttestation.js:20).
const IX_CREATE_ATTESTATION = 6;

// AEP_AGENT_REPUTATION_v1 layout — 16 bytes (ADR-061 §2):
//   u16 score, u32 completed_tasks, u16 dispute_ratio_bps, i64 last_updated
const REPUTATION_DATA_SIZE = 16;

// Deterministic test reputation values. Smoke test asserts these
// exact numbers; reruns of this script produce the same on-chain
// bytes so the attestation account is byte-identical across runs.
//
// `last_updated` is FIXED (not Date.now()) so the encoded data is
// deterministic — otherwise the script would always think the
// attestation needs re-issuing (the account would have stale bytes
// vs. a fresh encoding) and we'd burn rent each run.
const TEST_REPUTATION = {
  score: 8500,           // 85.00% in bps (ADR-061 §2 score range 0..10000)
  completed_tasks: 42,
  dispute_ratio_bps: 200, // 2.00%
  last_updated: 1714867200, // 2024-05-05 00:00:00 UTC — fixed for idempotency
} as const;

// SAS attestation expiry: 0 = no expiry (per attestation account decoder
// in packages/sas-resolver/src/schema.ts:131).
const ATTESTATION_EXPIRY: number = 0;

// Vault min lamports for attestation rent + fee buffer. Attestation
// account = 173 bytes header + 16 bytes data = 189 bytes; rent for
// 189 bytes is ~0.00148 SOL on mainnet schedule. 0.005 SOL is ~3x
// that with fee headroom.
const VAULT_MIN_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);

// -- Types -------------------------------------------------------------------

interface SquadsConfig {
  cluster: string;
  multisigProgramId: string;
  multisigPda: string;
  threshold: number;
  members: string[];
}

// Subset of the .sas-devnet.json record produced by the credential
// bootstrap script. We only read the fields we need; the full shape
// lives in bootstrap-sas-credential-devnet.ts.
interface SasBootstrapRecord {
  cluster: string;
  sasProgramId: string;
  multisigPda: string;
  multisigVaultPda: string;
  vaultIndex: number;
  credential: { pda: string; name: string };
  schema: { pda: string; name: string; version: number };
  testAttestation?: TestAttestationRecord;
}

interface TestAttestationRecord {
  pda: string;
  subject: string;
  nonce: string;
  expiry: number;
  reputation: typeof TEST_REPUTATION;
  createdAt: string;
  createTx?: string;
}

// -- Helpers -----------------------------------------------------------------

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function loadSquadsConfig(): SquadsConfig {
  if (!fs.existsSync(SQUADS_CONFIG_PATH)) {
    throw new Error(
      `Squads config not found at ${SQUADS_CONFIG_PATH}. Run bootstrap-squads-devnet.ts first.`,
    );
  }
  const parsed: SquadsConfig = JSON.parse(
    fs.readFileSync(SQUADS_CONFIG_PATH, 'utf8'),
  );
  if (parsed.cluster !== CLUSTER_NAME) {
    throw new Error(
      `Squads config cluster=${parsed.cluster}, expected ${CLUSTER_NAME}`,
    );
  }
  return parsed;
}

function readSasRecord(): SasBootstrapRecord {
  if (!fs.existsSync(SAS_RECORD_PATH)) {
    throw new Error(
      `SAS record not found at ${SAS_RECORD_PATH}. Run bootstrap-sas-credential-devnet.ts first.`,
    );
  }
  const parsed = JSON.parse(
    fs.readFileSync(SAS_RECORD_PATH, 'utf8'),
  ) as SasBootstrapRecord;
  if (parsed.cluster !== CLUSTER_NAME) {
    throw new Error(
      `SAS record cluster=${parsed.cluster}, expected ${CLUSTER_NAME}`,
    );
  }
  return parsed;
}

function writeSasRecord(record: SasBootstrapRecord): void {
  fs.writeFileSync(SAS_RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
}

async function isAccountLive(
  connection: Connection,
  addr: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(addr, 'confirmed');
  return info !== null && info.data.length > 0;
}

/**
 * Deterministic test subject keypair. Persisted under `.keys/` so
 * reruns target the same attestation PDA. `.keys/` is gitignored.
 */
function loadOrCreateTestSubject(): Keypair {
  if (fs.existsSync(TEST_SUBJECT_PATH)) {
    return loadKeypair(TEST_SUBJECT_PATH);
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(TEST_SUBJECT_PATH), { recursive: true });
  fs.writeFileSync(
    TEST_SUBJECT_PATH,
    JSON.stringify(Array.from(kp.secretKey)) + '\n',
    { mode: 0o600 },
  );
  console.log(
    `Generated test subject keypair → ${path.relative(REPO_ROOT, TEST_SUBJECT_PATH)}`,
  );
  return kp;
}

// -- Encoders ----------------------------------------------------------------

/**
 * Encode the 16-byte AEP_AGENT_REPUTATION_v1 data slice. Mirrors
 * `parseReputationData` in packages/sas-resolver/src/schema.ts.
 */
function encodeReputationData(fields: typeof TEST_REPUTATION): Buffer {
  if (fields.score < 0 || fields.score > 10_000) {
    throw new Error(`score out of range: ${fields.score}`);
  }
  if (fields.dispute_ratio_bps < 0 || fields.dispute_ratio_bps > 10_000) {
    throw new Error(`dispute_ratio_bps out of range: ${fields.dispute_ratio_bps}`);
  }
  const buf = Buffer.alloc(REPUTATION_DATA_SIZE);
  buf.writeUInt16LE(fields.score, 0);
  buf.writeUInt32LE(fields.completed_tasks, 2);
  buf.writeUInt16LE(fields.dispute_ratio_bps, 6);
  buf.writeBigInt64LE(BigInt(fields.last_updated), 8);
  return buf;
}

/**
 * Encode a u32 length-prefixed byte array: `[u32 LE len, raw bytes]`.
 * Mirrors `addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())`
 * in sas-lib's createAttestation IX encoder.
 */
function encodeLenBytes(b: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32LE(b.length, 0);
  Buffer.from(b).copy(out, 4);
  return out;
}

/**
 * createAttestation IX data
 * (sas-lib/dist/.../createAttestation.js:25-30):
 *
 *   u8   discriminator = 6
 *   32B  nonce (Address)
 *   u32  data_len, [data_len bytes]
 *   i64  expiry (LE)
 */
function encodeCreateAttestationData(params: {
  nonce: PublicKey;
  data: Uint8Array;
  expiry: number;
}): Buffer {
  const expiryBuf = Buffer.alloc(8);
  expiryBuf.writeBigInt64LE(BigInt(params.expiry), 0);

  return Buffer.concat([
    Buffer.from([IX_CREATE_ATTESTATION]),
    params.nonce.toBuffer(),
    encodeLenBytes(params.data),
    expiryBuf,
  ]);
}

// -- PDA derivation ---------------------------------------------------------

/**
 * Attestation PDA: `["attestation", credential, schema, nonce]`
 * Traced against sas-lib/dist/src/pdas.js:69-74.
 */
function deriveAttestationPda(params: {
  credential: PublicKey;
  schema: PublicKey;
  nonce: PublicKey;
}): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      SAS_ATTESTATION_SEED,
      params.credential.toBuffer(),
      params.schema.toBuffer(),
      params.nonce.toBuffer(),
    ],
    SAS_PROGRAM_ID,
  );
  return pda;
}

// -- IX builder --------------------------------------------------------------

/**
 * Build createAttestation IX. Account order traced against
 * sas-lib/dist/.../createAttestation.js:64-73 (payer, authority,
 * credential, schema, attestation, systemProgram).
 *
 * `payer` and `authority` are both the multisig vault PDA — the
 * vault has the SOL to pay rent AND is the credential authority.
 * Both must sign; for a vault-PDA signer, signing happens via
 * `vaultTransactionExecute` (the multisig program signs on behalf
 * of the vault).
 */
function buildCreateAttestationInstruction(params: {
  payer: PublicKey;
  authority: PublicKey;
  credential: PublicKey;
  schema: PublicKey;
  attestation: PublicKey;
  nonce: PublicKey;
  data: Uint8Array;
  expiry: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.credential, isSigner: false, isWritable: false },
      { pubkey: params.schema, isSigner: false, isWritable: false },
      { pubkey: params.attestation, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SAS_PROGRAM_ID,
    data: encodeCreateAttestationData({
      nonce: params.nonce,
      data: params.data,
      expiry: params.expiry,
    }),
  });
}

// -- Squads vault transaction wrapping --------------------------------------

async function confirmSig(
  connection: Connection,
  sig: string,
  label: string,
): Promise<void> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const res = await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    'confirmed',
  );
  if (res.value.err) {
    throw new Error(
      `[${label}] tx ${sig} failed confirmation: ${JSON.stringify(res.value.err)}`,
    );
  }
}

/**
 * Wrap a single inner instruction in a Squads vault transaction
 * requiring 2-of-3 approval, then execute it. Returns the execution
 * signature.
 *
 * Identical flow to bootstrap-sas-credential-devnet.ts —
 * vaultTransactionCreate → proposalCreate → 2× proposalApprove →
 * vaultTransactionExecute, each explicitly confirmed before the next.
 */
async function proposeApproveExecute(params: {
  connection: Connection;
  multisigPda: PublicKey;
  multisigVaultPda: PublicKey;
  transactionIndex: bigint;
  signer1: Keypair;
  signer2: Keypair;
  innerInstruction: TransactionInstruction;
  label: string;
}): Promise<string> {
  const {
    connection,
    multisigPda,
    multisigVaultPda,
    transactionIndex,
    signer1,
    signer2,
    innerInstruction,
    label,
  } = params;

  console.log(`  [${label}] multisig tx #${transactionIndex.toString()}: create`);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const transactionMessage = new TransactionMessage({
    payerKey: multisigVaultPda,
    recentBlockhash: blockhash,
    instructions: [innerInstruction],
  });

  const createSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer: signer1,
    multisigPda,
    transactionIndex,
    creator: signer1.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage,
  });
  await confirmSig(connection, createSig, `${label}/vault-create`);

  console.log(`  [${label}] proposalCreate`);
  const propSig = await multisig.rpc.proposalCreate({
    connection,
    feePayer: signer1,
    multisigPda,
    transactionIndex,
    creator: signer1,
  });
  await confirmSig(connection, propSig, `${label}/proposal-create`);

  console.log(`  [${label}] proposalApprove (signer 1, 1/2)`);
  const approve1Sig = await multisig.rpc.proposalApprove({
    connection,
    feePayer: signer1,
    multisigPda,
    transactionIndex,
    member: signer1,
  });
  await confirmSig(connection, approve1Sig, `${label}/approve-1`);

  console.log(`  [${label}] proposalApprove (signer 2, 2/2)`);
  const approve2Sig = await multisig.rpc.proposalApprove({
    connection,
    feePayer: signer1,
    multisigPda,
    transactionIndex,
    member: signer2,
  });
  await confirmSig(connection, approve2Sig, `${label}/approve-2`);

  console.log(`  [${label}] vaultTransactionExecute`);
  const execSig = await multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: signer1,
    multisigPda,
    transactionIndex,
    member: signer1.publicKey,
  });
  await confirmSig(connection, execSig, `${label}/execute`);
  console.log(`  [${label}] executed: ${execSig}`);
  return execSig;
}

// -- Main --------------------------------------------------------------------

async function main() {
  console.log(`Bootstrapping AEP test SAS attestation on ${CLUSTER_NAME}...`);

  // 1. Load configs + keypairs.
  const signer1 = loadKeypair(SIGNER_1_PATH);
  const signer2 = loadKeypair(SIGNER_2_PATH);
  const squads = loadSquadsConfig();
  const sasRecord = readSasRecord();

  const multisigPda = new PublicKey(squads.multisigPda);
  const [multisigVaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  const credentialPda = new PublicKey(sasRecord.credential.pda);
  const schemaPda = new PublicKey(sasRecord.schema.pda);

  // Sanity: the recorded vault must match the derived one (otherwise
  // the credential-bootstrap script and this script disagree on
  // which Squads vault is the SAS authority).
  if (sasRecord.multisigVaultPda !== multisigVaultPda.toBase58()) {
    throw new Error(
      `Multisig vault mismatch: .sas-devnet.json says ${sasRecord.multisigVaultPda}, derived ${multisigVaultPda.toBase58()}`,
    );
  }

  console.log(`Signer 1:          ${signer1.publicKey.toBase58()}`);
  console.log(`Signer 2:          ${signer2.publicKey.toBase58()}`);
  console.log(`Multisig PDA:      ${multisigPda.toBase58()}`);
  console.log(`Multisig Vault:    ${multisigVaultPda.toBase58()} (SAS credential authority)`);
  console.log(`Credential PDA:    ${credentialPda.toBase58()}`);
  console.log(`Schema PDA:        ${schemaPda.toBase58()}`);

  const connection = new Connection(CLUSTER_URL, 'confirmed');

  // Confirm credential + schema PDAs are live before issuing.
  if (!(await isAccountLive(connection, credentialPda))) {
    throw new Error(
      `Credential PDA ${credentialPda.toBase58()} not live on ${CLUSTER_NAME}; run bootstrap-sas-credential-devnet.ts first.`,
    );
  }
  if (!(await isAccountLive(connection, schemaPda))) {
    throw new Error(
      `Schema PDA ${schemaPda.toBase58()} not live on ${CLUSTER_NAME}; run bootstrap-sas-credential-devnet.ts first.`,
    );
  }

  // 2. Test subject + nonce. We use the test-subject pubkey as the
  // PDA nonce — gives one stable attestation PDA per subject for
  // this credential+schema, which is also the natural lookup pattern
  // the resolver expects when consumers store an attestation
  // address per agent.
  const testSubject = loadOrCreateTestSubject();
  const subjectPubkey = testSubject.publicKey;
  const nonce = subjectPubkey;
  const attestationPda = deriveAttestationPda({
    credential: credentialPda,
    schema: schemaPda,
    nonce,
  });

  console.log(`Test subject:      ${subjectPubkey.toBase58()}`);
  console.log(`Attestation PDA:   ${attestationPda.toBase58()}`);

  // 3. Idempotency: account live + record present means nothing to do.
  const attLive = await isAccountLive(connection, attestationPda);
  const recorded = sasRecord.testAttestation;
  if (attLive && recorded && recorded.pda === attestationPda.toBase58()) {
    console.log('Attestation already live on-chain and recorded. Nothing to do.');
    return;
  }
  if (recorded && recorded.pda !== attestationPda.toBase58()) {
    throw new Error(
      `.sas-devnet.json testAttestation.pda=${recorded.pda} but derived ${attestationPda.toBase58()} — refusing to overwrite without explicit reset.`,
    );
  }

  // 4. Encode the reputation data.
  const data = encodeReputationData(TEST_REPUTATION);
  console.log(
    `Reputation:        score=${TEST_REPUTATION.score}, completed=${TEST_REPUTATION.completed_tasks}, dispute_bps=${TEST_REPUTATION.dispute_ratio_bps}, last_updated=${TEST_REPUTATION.last_updated}`,
  );
  console.log(`Encoded data:      ${data.toString('hex')} (${data.length} bytes)`);

  // 5. Fund the multisig vault.
  const vaultBalance = await connection.getBalance(multisigVaultPda, 'confirmed');
  console.log(`Vault balance:     ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (vaultBalance < VAULT_MIN_LAMPORTS) {
    const topUp = VAULT_MIN_LAMPORTS - vaultBalance;
    console.log(
      `Funding vault: ${(topUp / LAMPORTS_PER_SOL).toFixed(4)} SOL from signer 1`,
    );
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: signer1.publicKey,
        toPubkey: multisigVaultPda,
        lamports: topUp,
      }),
    );
    const fundSig = await sendAndConfirmTransaction(
      connection,
      fundTx,
      [signer1],
      { commitment: 'confirmed' },
    );
    console.log(`  fund sig: ${fundSig}`);
  }

  // 6. Read multisig transactionIndex.
  const msAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
    'confirmed',
  );
  const nextIndex = BigInt(msAccount.transactionIndex.toString()) + 1n;
  console.log(
    `Multisig transactionIndex: ${msAccount.transactionIndex.toString()}; next = ${nextIndex.toString()}`,
  );

  // 7. Build + execute attestation IX via multisig.
  console.log('\n--- createAttestation (test reputation) ---');
  const ix = buildCreateAttestationInstruction({
    payer: multisigVaultPda,
    authority: multisigVaultPda,
    credential: credentialPda,
    schema: schemaPda,
    attestation: attestationPda,
    nonce,
    data,
    expiry: ATTESTATION_EXPIRY,
  });
  const execSig = await proposeApproveExecute({
    connection,
    multisigPda,
    multisigVaultPda,
    transactionIndex: nextIndex,
    signer1,
    signer2,
    innerInstruction: ix,
    label: 'attest',
  });

  if (!(await isAccountLive(connection, attestationPda))) {
    throw new Error(
      `Attestation PDA ${attestationPda.toBase58()} not live after execute.`,
    );
  }

  // 8. Persist record.
  const record: TestAttestationRecord = {
    pda: attestationPda.toBase58(),
    subject: subjectPubkey.toBase58(),
    nonce: nonce.toBase58(),
    expiry: ATTESTATION_EXPIRY,
    reputation: TEST_REPUTATION,
    createdAt: new Date().toISOString(),
    createTx: execSig,
  };
  const updated: SasBootstrapRecord = { ...sasRecord, testAttestation: record };
  writeSasRecord(updated);
  console.log(
    `\nWrote testAttestation block to ${path.relative(REPO_ROOT, SAS_RECORD_PATH)}`,
  );
  console.log(`Subject keypair lives at ${path.relative(REPO_ROOT, TEST_SUBJECT_PATH)} (gitignored).`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('SAS attestation bootstrap failed:', err);
  process.exit(1);
});

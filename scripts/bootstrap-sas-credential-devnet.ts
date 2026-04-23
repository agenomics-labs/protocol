#!/usr/bin/env tsx
/**
 * Bootstrap the AEP `AEP_PROTOCOL` SAS credential + `AEP_AGENT_REPUTATION_v1`
 * schema on devnet, with the Squads v4 multisig vault PDA as credential
 * authority from day one (per STATUS.md §7.A.2 recommendation and ADR-063).
 *
 * Scope: devnet only. Creates two SAS PDAs wrapped in Squads vault
 * transactions (2-of-3 approval). Does NOT:
 *   - Issue any attestation (that is the follow-up bootstrap script)
 *   - Touch mainnet
 *   - Wire smoke-test Steps 11-13 (follow-up PR)
 *
 * Idempotent: if `scripts/.sas-devnet.json` already records PDAs that are
 * live on-chain, exits without mutating state. Per-PDA idempotency is
 * handled inside the flow so a mid-run crash can be resumed.
 *
 * Wire format is hand-built because `sas-lib@1.0.10` pins
 * `@solana/kit@^5` which conflicts with our `@solana/kit@^6` tree; the
 * byte layouts here are traced against sas-lib's Codama-generated
 * encoders. See ADR-061 §2/§3 and ADR-063 §5 for the governance spec.
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
const OUTPUT_PATH = path.join(REPO_ROOT, 'scripts', '.sas-devnet.json');
const SIGNER_1_PATH = path.join(
  process.env.HOME ?? '',
  '.config',
  'solana',
  'id.json',
);
const SIGNER_2_PATH = path.join(REPO_ROOT, '.keys', 'squads-signer-2.json');

// SAS program ID on devnet (Solana Foundation deployment).
const SAS_PROGRAM_ID = new PublicKey(
  '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
);

// Seeds (sas-lib/src/pdas.ts).
const SAS_CREDENTIAL_SEED = Buffer.from('credential');
const SAS_SCHEMA_SEED = Buffer.from('schema');

// Instruction discriminators (sas-lib/src/generated/instructions/*.ts).
const IX_CREATE_CREDENTIAL = 0;
const IX_CREATE_SCHEMA = 1;

// AEP-specific names/versions (ADR-061 §2, §3).
const CREDENTIAL_NAME = 'AEP_PROTOCOL';
const SCHEMA_NAME = 'AEP_AGENT_REPUTATION';
const SCHEMA_VERSION = 1;

// Schema description for on-chain storage.
const SCHEMA_DESCRIPTION =
  'AEP baseline agent reputation v1 — ADR-061 §2. U16 score (bps), U32 completed_tasks, U16 dispute_ratio_bps, I64 last_updated (unix seconds).';

// Schema layout: tag bytes from sas-lib/src/utils.ts compactLayoutMapping.
// 1 = u16, 2 = u32, 8 = i64.
const SCHEMA_FIELD_NAMES = [
  'score',
  'completed_tasks',
  'dispute_ratio_bps',
  'last_updated',
];
const SCHEMA_LAYOUT = Uint8Array.from([1, 2, 1, 8]);

// Lamports the multisig vault needs before bootstrap. Rent for credential
// (~small, variable signers) + schema (larger due to description + field
// names) + fee buffer. 0.01 SOL is ~5x what we need.
const VAULT_MIN_LAMPORTS = Math.floor(0.01 * LAMPORTS_PER_SOL);

// -- Types -------------------------------------------------------------------

interface SquadsConfig {
  cluster: string;
  multisigProgramId: string;
  multisigPda: string;
  threshold: number;
  members: string[];
}

interface SasBootstrapRecord {
  cluster: string;
  sasProgramId: string;
  multisigPda: string;
  multisigVaultPda: string;
  vaultIndex: number;
  credential: {
    pda: string;
    name: string;
    authority: string; // multisigVaultPda
    signers: string[]; // empty at bootstrap
    createdAt: string;
    createTx?: string; // multisig execute sig
  };
  schema: {
    pda: string;
    name: string;
    version: number;
    credential: string;
    fieldNames: string[];
    layout: number[];
    createdAt: string;
    createTx?: string;
  };
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
  const parsed: SquadsConfig = JSON.parse(fs.readFileSync(SQUADS_CONFIG_PATH, 'utf8'));
  if (parsed.cluster !== CLUSTER_NAME) {
    throw new Error(
      `Squads config cluster=${parsed.cluster}, expected ${CLUSTER_NAME}`,
    );
  }
  return parsed;
}

function readExistingSasRecord(): SasBootstrapRecord | null {
  if (!fs.existsSync(OUTPUT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) as SasBootstrapRecord;
  } catch {
    return null;
  }
}

function writeSasRecord(record: SasBootstrapRecord): void {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(record, null, 2) + '\n');
}

async function isAccountLive(
  connection: Connection,
  addr: PublicKey,
): Promise<boolean> {
  const info = await connection.getAccountInfo(addr, 'confirmed');
  return info !== null && info.data.length > 0;
}

// -- SAS instruction encoders (hand-built) ----------------------------------

/**
 * Encode a u32 length-prefixed UTF-8 string: `[u32 LE len, utf8 bytes]`.
 * Mirrors `addEncoderSizePrefix(getUtf8Encoder(), getU32Encoder())` in sas-lib.
 */
function encodeLenUtf8(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32LE(bytes.length, 0);
  bytes.copy(out, 4);
  return out;
}

/**
 * Encode a u32 length-prefixed byte array: `[u32 LE len, raw bytes]`.
 * Mirrors `addEncoderSizePrefix(getBytesEncoder(), getU32Encoder())`.
 */
function encodeLenBytes(b: Uint8Array): Buffer {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32LE(b.length, 0);
  Buffer.from(b).copy(out, 4);
  return out;
}

/**
 * createCredential IX data (sas-lib createCredential.js:25-29):
 *   u8   discriminator = 0
 *   u32  name_len, utf8 name
 *   u32  signers_count, [32B pubkey] * signers_count
 */
function encodeCreateCredentialData(name: string, signers: PublicKey[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([IX_CREATE_CREDENTIAL]));
  parts.push(encodeLenUtf8(name));

  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(signers.length, 0);
  parts.push(countBuf);
  for (const s of signers) parts.push(s.toBuffer());

  return Buffer.concat(parts);
}

/**
 * createSchema IX data (sas-lib createSchema.js:25-32):
 *   u8   discriminator = 1
 *   u32  name_len, utf8 name
 *   u32  description_len, utf8 description
 *   u32  layout_len, layout bytes (tag per field)
 *   u32  fieldNames_count, [u32 len, utf8] * fieldNames_count
 */
function encodeCreateSchemaData(
  name: string,
  description: string,
  layout: Uint8Array,
  fieldNames: string[],
): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([IX_CREATE_SCHEMA]));
  parts.push(encodeLenUtf8(name));
  parts.push(encodeLenUtf8(description));
  parts.push(encodeLenBytes(layout));

  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(fieldNames.length, 0);
  parts.push(countBuf);
  for (const f of fieldNames) parts.push(encodeLenUtf8(f));

  return Buffer.concat(parts);
}

// -- SAS PDA derivation (sas-lib/src/pdas.ts) -------------------------------

function deriveCredentialPda(authority: PublicKey, name: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SAS_CREDENTIAL_SEED, authority.toBuffer(), Buffer.from(name, 'utf8')],
    SAS_PROGRAM_ID,
  );
  return pda;
}

function deriveSchemaPda(
  credential: PublicKey,
  name: string,
  version: number,
): PublicKey {
  if (version < 0 || version > 255) {
    throw new Error(`schema version must fit in u8, got ${version}`);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [
      SAS_SCHEMA_SEED,
      credential.toBuffer(),
      Buffer.from(name, 'utf8'),
      Uint8Array.from([version]),
    ],
    SAS_PROGRAM_ID,
  );
  return pda;
}

// -- SAS instruction builders -----------------------------------------------

function buildCreateCredentialInstruction(params: {
  payer: PublicKey; // signer
  credential: PublicKey; // writable PDA
  authority: PublicKey; // signer (same as payer for us — vault PDA)
  name: string;
  signers: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.credential, isSigner: false, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SAS_PROGRAM_ID,
    data: encodeCreateCredentialData(params.name, params.signers),
  });
}

function buildCreateSchemaInstruction(params: {
  payer: PublicKey;
  authority: PublicKey;
  credential: PublicKey;
  schema: PublicKey;
  name: string;
  description: string;
  layout: Uint8Array;
  fieldNames: string[];
}): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.credential, isSigner: false, isWritable: false },
      { pubkey: params.schema, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SAS_PROGRAM_ID,
    data: encodeCreateSchemaData(
      params.name,
      params.description,
      params.layout,
      params.fieldNames,
    ),
  });
}

// -- Squads vault transaction wrapping --------------------------------------

/**
 * Wait for a signature to reach 'confirmed' commitment. The Squads `rpc.*`
 * helpers use `sendTransaction` (fire-and-forget), so without explicit
 * confirmation the next call in the flow may see stale multisig state
 * and fail the on-chain `transaction_index` check.
 */
async function confirmSig(connection: Connection, sig: string, label: string): Promise<void> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const res = await connection.confirmTransaction(
    { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    'confirmed',
  );
  if (res.value.err) {
    throw new Error(`[${label}] tx ${sig} failed confirmation: ${JSON.stringify(res.value.err)}`);
  }
}

/**
 * Wrap a single inner instruction in a Squads vault transaction requiring
 * 2-of-3 approval, then execute it. Returns the execution signature.
 *
 * Flow (per docs/SQUADS_DEVNET.md + @sqds/multisig API):
 *   1. vaultTransactionCreate   (signer 1 pays rent)
 *   2. proposalCreate           (signer 1 creates proposal)
 *   3. proposalApprove          (signer 1 — 1/2)
 *   4. proposalApprove          (signer 2 — 2/2, proposal → Approved)
 *   5. vaultTransactionExecute  (any member; vault PDA signs inner ix)
 *
 * Each stage is explicitly confirmed before the next — `@sqds/multisig`'s
 * rpc helpers fire-and-forget, so otherwise later stages race ahead of
 * on-chain state propagation.
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
  const { connection, multisigPda, multisigVaultPda, transactionIndex, signer1, signer2, innerInstruction, label } = params;

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
    feePayer: signer1, // signer1 still pays fees
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
  console.log(`Bootstrapping AEP SAS credential + schema on ${CLUSTER_NAME}...`);

  // 1. Load keypairs and Squads config.
  const signer1 = loadKeypair(SIGNER_1_PATH);
  const signer2 = loadKeypair(SIGNER_2_PATH);
  const squads = loadSquadsConfig();
  const multisigPda = new PublicKey(squads.multisigPda);
  const [multisigVaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  console.log(`Signer 1:          ${signer1.publicKey.toBase58()}`);
  console.log(`Signer 2:          ${signer2.publicKey.toBase58()}`);
  console.log(`Multisig PDA:      ${multisigPda.toBase58()}`);
  console.log(`Multisig Vault:    ${multisigVaultPda.toBase58()} (SAS credential authority)`);

  const connection = new Connection(CLUSTER_URL, 'confirmed');

  // 2. Derive SAS PDAs. Both are fully deterministic from the vault pubkey.
  const credentialPda = deriveCredentialPda(multisigVaultPda, CREDENTIAL_NAME);
  const schemaPda = deriveSchemaPda(credentialPda, SCHEMA_NAME, SCHEMA_VERSION);
  console.log(`Credential PDA:    ${credentialPda.toBase58()}`);
  console.log(`Schema PDA:        ${schemaPda.toBase58()}`);

  // 3. Idempotency: if both PDAs already live, exit.
  const existing = readExistingSasRecord();
  const credLive = await isAccountLive(connection, credentialPda);
  const schemaLive = await isAccountLive(connection, schemaPda);

  if (existing && credLive && schemaLive) {
    console.log('Both credential and schema are live on-chain and recorded. Nothing to do.');
    return;
  }
  if (existing && (!credLive || !schemaLive)) {
    console.warn(
      `Found ${path.relative(REPO_ROOT, OUTPUT_PATH)} but one PDA is not live (credential=${credLive}, schema=${schemaLive}); resuming.`,
    );
  }

  // 4. Fund the multisig vault so it can pay rent for credential+schema.
  const vaultBalance = await connection.getBalance(multisigVaultPda, 'confirmed');
  console.log(
    `Vault balance: ${(vaultBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
  );
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
    const fundSig = await sendAndConfirmTransaction(connection, fundTx, [signer1], {
      commitment: 'confirmed',
    });
    console.log(`  fund sig: ${fundSig}`);
  }

  // 5. Read current multisig transactionIndex so we know what index to use next.
  const msAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
    'confirmed',
  );
  let nextIndex = BigInt(msAccount.transactionIndex.toString()) + 1n;
  console.log(
    `Multisig transactionIndex: ${msAccount.transactionIndex.toString()}; next = ${nextIndex.toString()}`,
  );

  // 6. Create credential (if not live).
  let credentialCreateTx: string | undefined;
  if (!credLive) {
    console.log(`\n--- createCredential "${CREDENTIAL_NAME}" ---`);
    const ix = buildCreateCredentialInstruction({
      payer: multisigVaultPda,
      credential: credentialPda,
      authority: multisigVaultPda,
      name: CREDENTIAL_NAME,
      signers: [], // empty at bootstrap; authority alone can issue
    });
    credentialCreateTx = await proposeApproveExecute({
      connection,
      multisigPda,
      multisigVaultPda,
      transactionIndex: nextIndex,
      signer1,
      signer2,
      innerInstruction: ix,
      label: 'cred',
    });
    nextIndex += 1n;

    if (!(await isAccountLive(connection, credentialPda))) {
      throw new Error(
        `Credential PDA ${credentialPda.toBase58()} not live after execute; aborting before schema.`,
      );
    }
  } else {
    console.log(`\n--- credential already live; skipping createCredential ---`);
  }

  // 7. Create schema (if not live).
  let schemaCreateTx: string | undefined;
  if (!schemaLive) {
    console.log(`\n--- createSchema "${SCHEMA_NAME}" v${SCHEMA_VERSION} ---`);
    const ix = buildCreateSchemaInstruction({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential: credentialPda,
      schema: schemaPda,
      name: SCHEMA_NAME,
      description: SCHEMA_DESCRIPTION,
      layout: SCHEMA_LAYOUT,
      fieldNames: SCHEMA_FIELD_NAMES,
    });
    schemaCreateTx = await proposeApproveExecute({
      connection,
      multisigPda,
      multisigVaultPda,
      transactionIndex: nextIndex,
      signer1,
      signer2,
      innerInstruction: ix,
      label: 'schema',
    });

    if (!(await isAccountLive(connection, schemaPda))) {
      throw new Error(`Schema PDA ${schemaPda.toBase58()} not live after execute.`);
    }
  } else {
    console.log(`\n--- schema already live; skipping createSchema ---`);
  }

  // 8. Write authoritative record.
  const record: SasBootstrapRecord = {
    cluster: CLUSTER_NAME,
    sasProgramId: SAS_PROGRAM_ID.toBase58(),
    multisigPda: multisigPda.toBase58(),
    multisigVaultPda: multisigVaultPda.toBase58(),
    vaultIndex: 0,
    credential: {
      pda: credentialPda.toBase58(),
      name: CREDENTIAL_NAME,
      authority: multisigVaultPda.toBase58(),
      signers: [],
      createdAt: new Date().toISOString(),
      createTx: credentialCreateTx,
    },
    schema: {
      pda: schemaPda.toBase58(),
      name: SCHEMA_NAME,
      version: SCHEMA_VERSION,
      credential: credentialPda.toBase58(),
      fieldNames: SCHEMA_FIELD_NAMES,
      layout: Array.from(SCHEMA_LAYOUT),
      createdAt: new Date().toISOString(),
      createTx: schemaCreateTx,
    },
  };
  writeSasRecord(record);
  console.log(`\nWrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('SAS bootstrap failed:', err);
  process.exit(1);
});

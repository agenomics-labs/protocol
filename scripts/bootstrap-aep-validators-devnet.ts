#!/usr/bin/env tsx
/**
 * Bootstrap the AEP `AEP_VALIDATORS` SAS credential on devnet. Rehearsal
 * artifact per ADR-077 — the mainnet `AEP_VALIDATORS` bootstrap is
 * explicitly deferred to T+90 after mainnet launch (see ADR-077 §1).
 *
 * Scope: devnet only. Creates ONE SAS credential PDA (no schema — the
 * `AEP_AGENT_REPUTATION_v1` schema from ADR-061 §2 is reused) wrapped in
 * a Squads vault transaction (2-of-3 approval on devnet).
 *
 * Does NOT:
 *   - Create a schema PDA (ADR-061 §2 schema is shared across credentials).
 *   - Touch mainnet. The mainnet ceremony runs per ADR-077 §4 after the
 *     §3 pre-conditions land.
 *   - Issue any attestation.
 *   - Wire the resolver's default allowlist (that's a follow-up in
 *     `@agenomics/sas-resolver` once mainnet bootstrap runs).
 *
 * Idempotent: if `scripts/.sas-devnet.json` already records a live
 * `validators_credential_pda`, exits without mutating state.
 *
 * Template: mirrors `scripts/bootstrap-sas-credential-devnet.ts`. The
 * SAS wire format is hand-built because `sas-lib@1.0.10` pins
 * `@solana/kit@^5` which conflicts with our `@solana/kit@^6` tree.
 *
 * STATUS: SKELETON. The credential-create instruction builder, the
 * Squads vault-tx wrapping, and the confirm-loop are stubbed with the
 * same shape the SAS bootstrap script uses; fill in against that script
 * when the devnet rehearsal ceremony is scheduled.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

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

// SAS program ID on devnet (Solana Foundation deployment).
const SAS_PROGRAM_ID = new PublicKey(
  '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
);

// Seeds (sas-lib/src/pdas.ts).
const SAS_CREDENTIAL_SEED = Buffer.from('credential');

// Instruction discriminators (sas-lib/src/generated/instructions/*.ts).
const IX_CREATE_CREDENTIAL = 0;

// ADR-077 §5: use a devnet-specific name to avoid namespace collision
// with the eventual mainnet `AEP_VALIDATORS` credential, which is
// deferred until T+90 after mainnet launch per ADR-077 §1.
const CREDENTIAL_NAME = 'AEP_VALIDATORS_DEVNET';

// Rent buffer for vault fees + credential creation. Conservative.
const VAULT_MIN_LAMPORTS = Math.floor(0.005 * LAMPORTS_PER_SOL);

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
  credential?: {
    pda: string;
    name: string;
    authority: string;
    signers: string[];
    createdAt: string;
    createTx?: string;
  };
  // Added by this script:
  validators_credential?: {
    pda: string;
    name: string;
    authority: string;
    signers: string[];
    createdAt: string;
    createTx?: string;
    adrRef: 'ADR-077';
  };
  schema?: unknown;
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

function readExistingSasRecord(): SasBootstrapRecord | null {
  if (!fs.existsSync(SAS_RECORD_PATH)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(SAS_RECORD_PATH, 'utf8'),
    ) as SasBootstrapRecord;
  } catch {
    return null;
  }
}

function writeSasRecord(record: SasBootstrapRecord): void {
  fs.writeFileSync(SAS_RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
}

function deriveCredentialPda(
  authority: PublicKey,
  name: string,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SAS_CREDENTIAL_SEED, authority.toBuffer(), Buffer.from(name)],
    SAS_PROGRAM_ID,
  );
}

// -- SAS instruction builder (SKELETON) -------------------------------------
// Lift from bootstrap-sas-credential-devnet.ts#buildCreateCredentialIx once
// this ceremony is scheduled. The byte layout is:
//   [u8 disc = 0][u32 name_len][name bytes][u8 signer_count][signer pubkeys...]
// ADR-077 devnet ceremony uses signer_count = 0 (authority-only, per
// ADR-063 §1.2 tier-1 placeholder pattern).

function buildCreateCredentialIx(params: {
  authority: PublicKey;
  credentialPda: PublicKey;
  name: string;
  payer: PublicKey;
}): TransactionInstruction {
  void params;
  throw new Error(
    'SKELETON: copy buildCreateCredentialIx from bootstrap-sas-credential-devnet.ts and wire AEP_VALIDATORS_DEVNET name + empty signer list',
  );
}

// -- Squads wrapping (SKELETON) ---------------------------------------------
// Lift proposeApproveExecute from bootstrap-sas-credential-devnet.ts.
// Same 2-of-3 flow; the SAS ix is a single inner instruction wrapped in
// a vault transaction.

async function proposeApproveExecute(params: {
  connection: Connection;
  squads: SquadsConfig;
  signer1: Keypair;
  signer2: Keypair;
  innerInstruction: TransactionInstruction;
  vaultIndex: number;
  transactionIndex: bigint;
}): Promise<string> {
  void params;
  throw new Error(
    'SKELETON: copy proposeApproveExecute from bootstrap-sas-credential-devnet.ts — identical flow; the only difference is the inner IX is the AEP_VALIDATORS_DEVNET credential create',
  );
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[adr-077] AEP_VALIDATORS_DEVNET bootstrap — devnet rehearsal');
  console.log('[adr-077] Per ADR-077 §1, mainnet AEP_VALIDATORS is deferred T+90');

  const squads = loadSquadsConfig();
  const existing = readExistingSasRecord();

  if (existing?.validators_credential?.pda) {
    console.log(
      `[adr-077] Existing validators_credential PDA in record: ${existing.validators_credential.pda}`,
    );
    // TODO: verify live on-chain via connection.getAccountInfo; exit if live.
    console.log('[adr-077] SKELETON: add on-chain liveness check, then exit 0');
    return;
  }

  const connection = new Connection(CLUSTER_URL, 'confirmed');
  const signer1 = loadKeypair(SIGNER_1_PATH);
  const signer2 = loadKeypair(SIGNER_2_PATH);

  const vaultPda = new PublicKey(
    existing?.multisigVaultPda ?? squads.multisigPda,
  );
  const [credentialPda] = deriveCredentialPda(vaultPda, CREDENTIAL_NAME);

  console.log(`[adr-077] credential authority (vault): ${vaultPda.toBase58()}`);
  console.log(`[adr-077] derived credential PDA: ${credentialPda.toBase58()}`);

  // Fund the vault if needed.
  const vaultBalance = await connection.getBalance(vaultPda);
  if (vaultBalance < VAULT_MIN_LAMPORTS) {
    const topUp = VAULT_MIN_LAMPORTS - vaultBalance;
    console.log(`[adr-077] topping up vault with ${topUp} lamports`);
    await sendAndConfirmTransaction(
      connection,
      // TODO: build and sign a SystemProgram.transfer tx from signer1 to vaultPda
      // SKELETON: copy topUpVault from bootstrap-sas-credential-devnet.ts
      null as unknown as never,
      [signer1],
    );
  }

  const innerIx = buildCreateCredentialIx({
    authority: vaultPda,
    credentialPda,
    name: CREDENTIAL_NAME,
    payer: vaultPda,
  });

  const transactionIndex = 0n; // TODO: read from multisig account state.
  const executeSig = await proposeApproveExecute({
    connection,
    squads,
    signer1,
    signer2,
    innerInstruction: innerIx,
    vaultIndex: existing?.vaultIndex ?? 0,
    transactionIndex,
  });

  const record: SasBootstrapRecord = {
    ...(existing ?? {
      cluster: CLUSTER_NAME,
      sasProgramId: SAS_PROGRAM_ID.toBase58(),
      multisigPda: squads.multisigPda,
      multisigVaultPda: vaultPda.toBase58(),
      vaultIndex: 0,
    }),
    validators_credential: {
      pda: credentialPda.toBase58(),
      name: CREDENTIAL_NAME,
      authority: vaultPda.toBase58(),
      signers: [], // empty; per ADR-077 devnet rehearsal uses authority-only
      createdAt: new Date().toISOString(),
      createTx: executeSig,
      adrRef: 'ADR-077',
    },
  };
  writeSasRecord(record);
  console.log(`[adr-077] wrote record to ${SAS_RECORD_PATH}`);
  console.log(`[adr-077] execute tx: ${executeSig}`);
}

main().catch((err) => {
  console.error('[adr-077] bootstrap failed:', err);
  process.exit(1);
});

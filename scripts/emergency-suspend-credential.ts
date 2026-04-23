#!/usr/bin/env tsx
/**
 * Emergency-suspend a SAS credential authority by clearing its authorized
 * signer set to empty via a multisig-signed `change_authorized_signers`
 * SAS instruction. Implements ADR-081 §1 (suspension semantics) and
 * ADR-063 §6.1 step 2 (T+0 to T+2h "suspend issuance").
 *
 * After execution, only the credential's authority (the multisig vault
 * PDA) can sign new attestations — and the multisig vault can only sign
 * with quorum approval. Operationally, this halts new attestation
 * issuance under the compromised signer's pubkey. Existing attestations
 * remain on-chain and are flagged retroactively by the T+24h-T+7d audit
 * (`scripts/audit-suspended-credential-attestations.ts`, stub follow-up).
 *
 * Scope: devnet (mainnet uses the same script with `--credential` set to
 * the mainnet PDA; the script reads cluster from the SAS record file).
 *
 * Idempotent / resumable: a crash mid-ceremony leaves the on-chain
 * proposal at a known index. Re-invocation reads `multisig.transactionIndex`
 * and the proposal status at the candidate index, then resumes from the
 * next required stage. The local JSON log at `logs/credential-suspend-*.json`
 * is written only after the proposal reaches `Executed`.
 *
 * Usage:
 *   tsx scripts/emergency-suspend-credential.ts \
 *     --credential <pubkey> \
 *     --reason "<freeform>" \
 *     --auditor-cosig <path-to-auditor-cosig.json> \
 *     [--dry-run]
 *
 * In `--dry-run`, the script:
 *   - Validates `--credential` against the SAS record config.
 *   - Constructs the SAS instruction and the wrapping Squads payload.
 *   - Prints the payload (decoded fields) to stdout.
 *   - Does NOT submit any transaction.
 *   - Does NOT require `--auditor-cosig`.
 *   - Writes `logs/credential-suspend-DRY-<timestamp>.json`.
 *
 * Auditor cosign:
 *   The script enforces a valid Ed25519 signature by the auditor pubkey
 *   (read from `scripts/.sas-devnet.json#governance.auditorCosignPubkey`)
 *   over the message:
 *     "AEP-EMERGENCY-SUSPEND:<credentialPubkey>:<sha256(reason)>"
 *   in non-dry-run mode. Per ADR-063 "Pending items before Accept" #2,
 *   when `governance.auditorCosignPubkey` is null the script refuses
 *   outside `--dry-run`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  SystemProgram,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
// `@noble/curves/ed25519` is a transitive dep via `@solana/web3.js` and is
// the standard modern Ed25519 verifier. Avoids adding a new direct dep.
import { ed25519 } from '@noble/curves/ed25519';

// -- Constants ---------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const SAS_RECORD_PATH = path.join(REPO_ROOT, 'scripts', '.sas-devnet.json');
const SQUADS_CONFIG_PATH = path.join(REPO_ROOT, 'scripts', '.squads-devnet.json');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const TRANSPARENCY_LOG_DIR = path.join(REPO_ROOT, 'governance', 'attestation-log');

const CLUSTER_RPC: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

// SAS program ID (Solana Foundation deployment — same on devnet + mainnet).
const SAS_PROGRAM_ID = new PublicKey(
  '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
);

// SAS `change_authorized_signers` discriminator. Per sas-lib's
// generated/instructions/changeAuthorizedSigners.ts. The bootstrap
// script uses 0 (createCredential) and 1 (createSchema); this is 4 in
// the same enum, ordered: createCredential, createSchema, createAttestation,
// closeAttestation, changeAuthorizedSigners.
const IX_CHANGE_AUTHORIZED_SIGNERS = 4;

const SIGNER_1_PATH = path.join(
  process.env.HOME ?? '',
  '.config',
  'solana',
  'id.json',
);
const SIGNER_2_PATH = path.join(REPO_ROOT, '.keys', 'squads-signer-2.json');

// -- Types -------------------------------------------------------------------

export interface SquadsConfig {
  cluster: string;
  multisigProgramId: string;
  multisigPda: string;
  threshold: number;
  members: string[];
  createKey?: string;
  createdAt?: string;
  createSignature?: string;
}

export interface SasRecord {
  cluster: string;
  sasProgramId: string;
  multisigPda: string;
  multisigVaultPda: string;
  vaultIndex: number;
  credential: {
    pda: string;
    name: string;
    authority: string;
    signers: string[];
    createdAt: string;
    createTx?: string;
  };
  schema?: unknown;
  validators_credential?: unknown;
  governance?: {
    /**
     * Pre-registered auditor pubkey for emergency cosign per ADR-063 §6.1
     * "auditor co-sign" requirement. Null until ADR-063 "Pending items
     * before Accept" #2 is resolved.
     */
    auditorCosignPubkey: string | null;
  };
}

export interface AuditorCosignFile {
  auditorPubkey: string; // base58
  signature: string; // base64 (64 bytes Ed25519)
}

export interface SuspendLog {
  credentialPda: string;
  credentialName: string;
  cluster: string;
  multisigPda: string;
  multisigVaultPda: string;
  proposalIndex: string; // bigint serialized as string
  reason: string;
  reasonSha256: string;
  auditorCosig: AuditorCosignFile | null;
  approvers: string[];
  transactions: {
    vaultTransactionCreate?: string;
    proposalCreate?: string;
    proposalApprove?: string[];
    vaultTransactionExecute?: string;
  };
  suspendedAt: string;
  dryRun: boolean;
  nextSteps: {
    rotateBy: string;
    rotateScript: string;
    auditBy: string;
    auditScript: string;
  };
}

export interface CliArgs {
  credential?: string;
  reason: string;
  auditorCosig?: string;
  dryRun: boolean;
}

// -- CLI parsing -------------------------------------------------------------

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    reason: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--credential':
        args.credential = argv[++i];
        break;
      case '--reason':
        args.reason = argv[++i];
        break;
      case '--auditor-cosig':
        args.auditorCosig = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (a !== undefined) {
          throw new Error(`unknown argument: ${a}`);
        }
    }
  }
  if (!args.reason) {
    throw new Error('--reason is required (use a short freeform string)');
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: tsx scripts/emergency-suspend-credential.ts \\',
      '  --credential <pubkey>           # optional; defaults to .sas-devnet.json#credential.pda',
      '  --reason "<freeform>"           # required',
      '  --auditor-cosig <path>          # required outside --dry-run',
      '  [--dry-run]                     # no on-chain submission, no auditor required',
      '',
      'See ADR-081 for the operational procedure (T+2h suspend / T+24h rotate / T+7d audit).',
      '',
    ].join('\n'),
  );
}

// -- Config / record helpers -------------------------------------------------

export function loadSasRecord(filePath: string = SAS_RECORD_PATH): SasRecord {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `SAS record not found at ${filePath}. Run scripts/bootstrap-sas-credential-devnet.ts first.`,
    );
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SasRecord;
}

export function loadSquadsConfig(
  filePath: string = SQUADS_CONFIG_PATH,
): SquadsConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Squads config not found at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as SquadsConfig;
}

export function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Resolve the target credential pubkey:
 * - If `--credential` is provided AND matches the SAS record's stored PDA,
 *   return it.
 * - If `--credential` is provided AND does NOT match, refuse (typo defense).
 * - If `--credential` is omitted, default to the SAS record's stored PDA.
 *
 * The "must match" rule is intentional: an operator running this script
 * during an emergency must explicitly target the right credential. A
 * mistyped pubkey that silently falls back to the config default would
 * mask exactly the operator-error class this defense is for.
 */
export function resolveCredentialPubkey(
  cliCredential: string | undefined,
  record: SasRecord,
): PublicKey {
  if (!cliCredential) {
    return new PublicKey(record.credential.pda);
  }
  if (cliCredential !== record.credential.pda) {
    throw new Error(
      `--credential ${cliCredential} does not match SAS record credential.pda ${record.credential.pda}. ` +
        `If you are intentionally targeting a different credential, update the record file first.`,
    );
  }
  return new PublicKey(cliCredential);
}

// -- Auditor cosign verification --------------------------------------------

/**
 * Compute the cosign message: `"AEP-EMERGENCY-SUSPEND:<credential>:<sha256(reason)>"`.
 * Stable, deterministic — auditor signs this exact string off-line.
 */
export function computeCosignMessage(
  credentialPubkey: PublicKey,
  reason: string,
): string {
  const reasonHash = crypto.createHash('sha256').update(reason, 'utf8').digest('hex');
  return `AEP-EMERGENCY-SUSPEND:${credentialPubkey.toBase58()}:${reasonHash}`;
}

export function loadAuditorCosig(filePath: string): AuditorCosignFile {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as AuditorCosignFile;
  if (!parsed.auditorPubkey || !parsed.signature) {
    throw new Error(
      `auditor cosign file at ${filePath} is missing auditorPubkey or signature`,
    );
  }
  return parsed;
}

/**
 * Verify the auditor cosign:
 * - The signature is valid Ed25519 over the cosign message.
 * - The signing pubkey matches the cosign file's `auditorPubkey`.
 * - The cosign file's `auditorPubkey` matches the registered auditor in
 *   the SAS record (`governance.auditorCosignPubkey`).
 *
 * Returns true on success; throws on any mismatch.
 */
export function verifyAuditorCosig(params: {
  cosig: AuditorCosignFile;
  credential: PublicKey;
  reason: string;
  registeredAuditorPubkey: string | null;
}): true {
  const { cosig, credential, reason, registeredAuditorPubkey } = params;
  if (!registeredAuditorPubkey) {
    throw new Error(
      'No auditor pubkey registered in scripts/.sas-devnet.json#governance.auditorCosignPubkey. ' +
        'Per ADR-063 "Pending items before Accept" #2, the auditor slot must be populated ' +
        'before this script can run outside --dry-run.',
    );
  }
  if (cosig.auditorPubkey !== registeredAuditorPubkey) {
    throw new Error(
      `auditor cosign pubkey ${cosig.auditorPubkey} does not match registered ` +
        `auditor ${registeredAuditorPubkey}`,
    );
  }
  const message = computeCosignMessage(credential, reason);
  const messageBytes = Buffer.from(message, 'utf8');
  const signatureBytes = Buffer.from(cosig.signature, 'base64');
  if (signatureBytes.length !== 64) {
    throw new Error(
      `auditor cosign signature must be 64 bytes (Ed25519); got ${signatureBytes.length}`,
    );
  }
  const auditorPubkeyBytes = new PublicKey(cosig.auditorPubkey).toBytes();
  let ok = false;
  try {
    // ed25519.verify(sig, msg, pub) — boolean result; throws on bad shapes
    // for some inputs (e.g., non-canonical encodings).
    ok = ed25519.verify(signatureBytes, messageBytes, auditorPubkeyBytes);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new Error(
      `auditor cosign signature failed Ed25519 verification against message ` +
        `"${message}" and pubkey ${cosig.auditorPubkey}`,
    );
  }
  return true;
}

// -- SAS instruction builder -------------------------------------------------

/**
 * Encode a `change_authorized_signers` SAS instruction body. Layout:
 *   u8   discriminator = 4
 *   u32  signers_count
 *   [32B pubkey] * signers_count
 *
 * For suspension, `signers` is `[]` — empty signer list. Mirrors the
 * encoder shape used in `bootstrap-sas-credential-devnet.ts` for the
 * createCredential signers field.
 */
export function encodeChangeAuthorizedSignersData(signers: PublicKey[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([IX_CHANGE_AUTHORIZED_SIGNERS]));
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(signers.length, 0);
  parts.push(countBuf);
  for (const s of signers) parts.push(s.toBuffer());
  return Buffer.concat(parts);
}

/**
 * Build the `change_authorized_signers` instruction.
 * Account layout (mirrors sas-lib generated/instructions/changeAuthorizedSigners.ts):
 *   0: payer (signer, writable) — multisig vault PDA
 *   1: authority (signer) — multisig vault PDA
 *   2: credential (writable) — the SAS credential PDA
 *   3: system program
 */
export function buildChangeAuthorizedSignersIx(params: {
  payer: PublicKey;
  authority: PublicKey;
  credential: PublicKey;
  newSigners: PublicKey[];
}): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.credential, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SAS_PROGRAM_ID,
    data: encodeChangeAuthorizedSignersData(params.newSigners),
  });
}

// -- Squads RPC abstraction --------------------------------------------------
//
// Mirrors the proposeApproveExecute pattern in
// `bootstrap-sas-credential-devnet.ts`. Behind an interface so the unit
// tests can mock the entire RPC layer without spinning up a validator.

export interface MultisigState {
  transactionIndex: bigint;
}

export type ProposalStatus =
  | 'None'
  | 'Draft'
  | 'Active'
  | 'Approved'
  | 'Executed'
  | 'Rejected'
  | 'Cancelled';

export interface ProposalState {
  status: ProposalStatus;
  approved: string[]; // base58 pubkeys that have approved
}

export interface SquadsRpc {
  fetchMultisig(multisigPda: PublicKey): Promise<MultisigState>;
  fetchProposal(
    multisigPda: PublicKey,
    transactionIndex: bigint,
  ): Promise<ProposalState>;
  vaultTransactionCreate(params: {
    multisigPda: PublicKey;
    multisigVaultPda: PublicKey;
    transactionIndex: bigint;
    creator: Keypair;
    innerInstruction: TransactionInstruction;
  }): Promise<string>;
  proposalCreate(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    creator: Keypair;
  }): Promise<string>;
  proposalApprove(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    member: Keypair;
  }): Promise<string>;
  vaultTransactionExecute(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    member: Keypair;
    feePayer: Keypair;
  }): Promise<string>;
}

/**
 * Live Squads RPC implementation — wraps `@sqds/multisig`'s `rpc.*`
 * helpers and adds explicit per-call confirmation (mirrors the bootstrap
 * script's `confirmSig` discipline; without it, fire-and-forget races
 * make the next stage see stale on-chain state).
 */
export function makeLiveSquadsRpc(connection: Connection): SquadsRpc {
  async function confirmSig(sig: string, label: string): Promise<void> {
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

  return {
    async fetchMultisig(multisigPda) {
      const ms = await multisig.accounts.Multisig.fromAccountAddress(
        connection,
        multisigPda,
        'confirmed',
      );
      return { transactionIndex: BigInt(ms.transactionIndex.toString()) };
    },
    async fetchProposal(multisigPda, transactionIndex) {
      const [proposalPda] = multisig.getProposalPda({
        multisigPda,
        transactionIndex,
      });
      const info = await connection.getAccountInfo(proposalPda, 'confirmed');
      if (!info || info.data.length === 0) {
        return { status: 'None', approved: [] };
      }
      const proposal = await multisig.accounts.Proposal.fromAccountAddress(
        connection,
        proposalPda,
        'confirmed',
      );
      // The proposal status enum encodes the variant name in its kind field.
      const statusKind = (proposal.status as { __kind?: string }).__kind ?? 'None';
      const approved = (proposal.approved as { toBase58(): string }[]).map((p) =>
        p.toBase58(),
      );
      return {
        status: statusKind as ProposalStatus,
        approved,
      };
    },
    async vaultTransactionCreate(params) {
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const transactionMessage = new TransactionMessage({
        payerKey: params.multisigVaultPda,
        recentBlockhash: blockhash,
        instructions: [params.innerInstruction],
      });
      const sig = await multisig.rpc.vaultTransactionCreate({
        connection,
        feePayer: params.creator,
        multisigPda: params.multisigPda,
        transactionIndex: params.transactionIndex,
        creator: params.creator.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage,
      });
      await confirmSig(sig, 'vault-create');
      return sig;
    },
    async proposalCreate(params) {
      const sig = await multisig.rpc.proposalCreate({
        connection,
        feePayer: params.creator,
        multisigPda: params.multisigPda,
        transactionIndex: params.transactionIndex,
        creator: params.creator,
      });
      await confirmSig(sig, 'proposal-create');
      return sig;
    },
    async proposalApprove(params) {
      const sig = await multisig.rpc.proposalApprove({
        connection,
        feePayer: params.member,
        multisigPda: params.multisigPda,
        transactionIndex: params.transactionIndex,
        member: params.member,
      });
      await confirmSig(sig, `approve-${params.member.publicKey.toBase58().slice(0, 8)}`);
      return sig;
    },
    async vaultTransactionExecute(params) {
      const sig = await multisig.rpc.vaultTransactionExecute({
        connection,
        feePayer: params.feePayer,
        multisigPda: params.multisigPda,
        transactionIndex: params.transactionIndex,
        member: params.member.publicKey,
      });
      await confirmSig(sig, 'execute');
      return sig;
    },
  };
}

// -- Resumable proposal flow -------------------------------------------------

export interface RunFlowParams {
  rpc: SquadsRpc;
  multisigPda: PublicKey;
  multisigVaultPda: PublicKey;
  signers: Keypair[]; // ordered: signer1 (creator + approver), signer2 (approver)
  innerInstruction: TransactionInstruction;
  threshold: number;
  /**
   * Allow the caller to override the candidate transaction index. When
   * omitted, the flow reads `multisig.transactionIndex` and uses
   * `transactionIndex + 1` (next available slot).
   */
  candidateIndex?: bigint;
}

export interface RunFlowResult {
  proposalIndex: bigint;
  approvers: string[];
  transactions: SuspendLog['transactions'];
  alreadyExecuted: boolean;
}

/**
 * Drive the propose/approve/execute state machine. Resumable — reads
 * proposal status at the candidate index and skips stages that have
 * already landed on-chain.
 */
export async function runProposalFlow(
  params: RunFlowParams,
): Promise<RunFlowResult> {
  const {
    rpc,
    multisigPda,
    multisigVaultPda,
    signers,
    innerInstruction,
    threshold,
  } = params;
  if (signers.length < threshold) {
    throw new Error(
      `not enough signers loaded: have ${signers.length}, need >= threshold (${threshold})`,
    );
  }
  const creator = signers[0]!;

  // 1. Decide candidate index.
  let candidateIndex = params.candidateIndex;
  if (candidateIndex === undefined) {
    const ms = await rpc.fetchMultisig(multisigPda);
    candidateIndex = ms.transactionIndex + 1n;
  }

  // 2. Read proposal status at the candidate index.
  const proposal = await rpc.fetchProposal(multisigPda, candidateIndex);
  const transactions: SuspendLog['transactions'] = {};

  // 3. Drive state machine.
  if (proposal.status === 'Executed') {
    return {
      proposalIndex: candidateIndex,
      approvers: proposal.approved,
      transactions,
      alreadyExecuted: true,
    };
  }
  if (proposal.status === 'Rejected' || proposal.status === 'Cancelled') {
    throw new Error(
      `proposal at index ${candidateIndex} is ${proposal.status}; cannot resume. ` +
        `Operator must escalate to a fresh proposal at the next index, which itself ` +
        `requires multisig-coordinated action.`,
    );
  }

  // Stage: vaultTransactionCreate (skip if proposal already exists).
  if (proposal.status === 'None') {
    transactions.vaultTransactionCreate = await rpc.vaultTransactionCreate({
      multisigPda,
      multisigVaultPda,
      transactionIndex: candidateIndex,
      creator,
      innerInstruction,
    });
  }

  // Stage: proposalCreate (skip if status is already past Draft).
  if (proposal.status === 'None' || proposal.status === 'Draft') {
    transactions.proposalCreate = await rpc.proposalCreate({
      multisigPda,
      transactionIndex: candidateIndex,
      creator,
    });
  }

  // Stage: proposalApprove for each signer that has not yet approved,
  // up to threshold total approvals.
  const approveSigs: string[] = [];
  let approvalsSoFar = proposal.approved.length;
  for (const member of signers) {
    if (approvalsSoFar >= threshold) break;
    const memberPub = member.publicKey.toBase58();
    if (proposal.approved.includes(memberPub)) continue;
    const sig = await rpc.proposalApprove({
      multisigPda,
      transactionIndex: candidateIndex,
      member,
    });
    approveSigs.push(sig);
    approvalsSoFar += 1;
  }
  if (approveSigs.length > 0) {
    transactions.proposalApprove = approveSigs;
  }

  // Stage: vaultTransactionExecute. Re-read proposal status to confirm
  // we have reached `Approved` (or `Active` with enough approvals — but
  // the multisig program transitions to `Approved` automatically once
  // threshold is met).
  const postApproval = await rpc.fetchProposal(multisigPda, candidateIndex);
  if (postApproval.status !== 'Approved' && postApproval.status !== 'Executed') {
    throw new Error(
      `proposal at index ${candidateIndex} is ${postApproval.status} after approvals; ` +
        `expected Approved or Executed`,
    );
  }
  if (postApproval.status === 'Approved') {
    transactions.vaultTransactionExecute = await rpc.vaultTransactionExecute({
      multisigPda,
      transactionIndex: candidateIndex,
      member: creator,
      feePayer: creator,
    });
  }

  // Final approvers = whoever ended up on the proposal.
  const finalProposal = await rpc.fetchProposal(multisigPda, candidateIndex);
  return {
    proposalIndex: candidateIndex,
    approvers: finalProposal.approved,
    transactions,
    alreadyExecuted: false,
  };
}

// -- Idempotency: prior log scan --------------------------------------------

/**
 * Look at `logs/credential-suspend-*.json` for a non-dry-run entry that
 * matches the credential pubkey. If found AND its `transactions` block
 * is fully populated, return its path — caller treats this as "already
 * suspended, no work to do."
 */
export function findExistingSuspendLog(
  credentialPubkey: PublicKey,
  logsDir: string = LOGS_DIR,
): string | null {
  if (!fs.existsSync(logsDir)) return null;
  const entries = fs.readdirSync(logsDir).filter(
    (f) => f.startsWith('credential-suspend-') && f.endsWith('.json'),
  );
  for (const e of entries) {
    if (e.includes('-DRY-')) continue;
    const filePath = path.join(logsDir, e);
    try {
      const log = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SuspendLog;
      if (
        log.credentialPda === credentialPubkey.toBase58() &&
        log.transactions.vaultTransactionExecute &&
        !log.dryRun
      ) {
        return filePath;
      }
    } catch {
      // Ignore unparseable entries — they're not authoritative.
    }
  }
  return null;
}

// -- Log + transparency-log writers -----------------------------------------

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function writeSuspendLog(log: SuspendLog, logsDir: string = LOGS_DIR): string {
  ensureDir(logsDir);
  const stamp = log.suspendedAt.replace(/[:.]/g, '-');
  const fname = log.dryRun
    ? `credential-suspend-DRY-${stamp}.json`
    : `credential-suspend-${stamp}.json`;
  const fpath = path.join(logsDir, fname);
  fs.writeFileSync(fpath, JSON.stringify(log, null, 2) + '\n');
  return fpath;
}

export function writeTransparencyLogStub(
  log: SuspendLog,
  rootDir: string = TRANSPARENCY_LOG_DIR,
): string | null {
  if (log.dryRun) return null;
  const yyyymm = log.suspendedAt.slice(0, 7); // YYYY-MM
  const dir = path.join(rootDir, yyyymm);
  ensureDir(dir);
  const stamp = log.suspendedAt.replace(/[:.]/g, '-');
  const fname = `suspend-${stamp}.json`;
  const fpath = path.join(dir, fname);
  // Strip `nextSteps` (operator-facing) from the consumer-facing entry.
  const consumerEntry: Record<string, unknown> = { ...log };
  delete consumerEntry.nextSteps;
  fs.writeFileSync(fpath, JSON.stringify(consumerEntry, null, 2) + '\n');
  return fpath;
}

// -- Next-steps printer ------------------------------------------------------

export function printNextStepGuidance(log: SuspendLog): void {
  const lines = [
    '',
    '====================================================================',
    'SUSPENSION COMPLETE — next steps per ADR-063 §6.1:',
    '',
    `  T+24h (by ${log.nextSteps.rotateBy}):`,
    `    Rotate compromised signer using:`,
    `      ${log.nextSteps.rotateScript}`,
    '',
    `  T+7d (by ${log.nextSteps.auditBy}):`,
    `    Retroactive attestation audit using:`,
    `      ${log.nextSteps.auditScript}`,
    '',
    `Local log: logs/credential-suspend-${log.suspendedAt.replace(/[:.]/g, '-')}.json`,
    `Transparency log stub: governance/attestation-log/${log.suspendedAt.slice(0, 7)}/suspend-${log.suspendedAt.replace(/[:.]/g, '-')}.json`,
    '====================================================================',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}

// -- Main --------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseCliArgs(argv);
  const record = loadSasRecord();
  const credentialPubkey = resolveCredentialPubkey(args.credential, record);

  const cluster = record.cluster;
  process.stdout.write(`[adr-081] cluster: ${cluster}\n`);
  process.stdout.write(`[adr-081] credential: ${credentialPubkey.toBase58()} (${record.credential.name})\n`);
  process.stdout.write(`[adr-081] reason: ${args.reason}\n`);
  process.stdout.write(`[adr-081] dry-run: ${args.dryRun}\n`);

  // Idempotency: short-circuit if a fully-executed prior log exists.
  if (!args.dryRun) {
    const prior = findExistingSuspendLog(credentialPubkey);
    if (prior) {
      process.stdout.write(
        `[adr-081] credential already suspended per ${prior}; nothing to do.\n`,
      );
      return;
    }
  }

  // Auditor cosign verification (skipped in dry-run).
  let auditorCosig: AuditorCosignFile | null = null;
  if (!args.dryRun) {
    if (!args.auditorCosig) {
      throw new Error('--auditor-cosig is required outside --dry-run');
    }
    auditorCosig = loadAuditorCosig(args.auditorCosig);
    verifyAuditorCosig({
      cosig: auditorCosig,
      credential: credentialPubkey,
      reason: args.reason,
      registeredAuditorPubkey: record.governance?.auditorCosignPubkey ?? null,
    });
    process.stdout.write(`[adr-081] auditor cosign verified: ${auditorCosig.auditorPubkey}\n`);
  }

  // Build the SAS instruction that clears the signer set.
  const multisigVaultPda = new PublicKey(record.multisigVaultPda);
  const innerIx = buildChangeAuthorizedSignersIx({
    payer: multisigVaultPda,
    authority: multisigVaultPda,
    credential: credentialPubkey,
    newSigners: [], // suspension == empty signer set
  });

  if (args.dryRun) {
    process.stdout.write('[adr-081] DRY RUN — would submit:\n');
    process.stdout.write(`  inner ix programId: ${SAS_PROGRAM_ID.toBase58()}\n`);
    process.stdout.write(`  inner ix data (hex): ${innerIx.data.toString('hex')}\n`);
    process.stdout.write(`  inner ix accounts:\n`);
    for (const k of innerIx.keys) {
      process.stdout.write(
        `    - ${k.pubkey.toBase58()} (signer=${k.isSigner}, writable=${k.isWritable})\n`,
      );
    }
    const dryLog: SuspendLog = {
      credentialPda: credentialPubkey.toBase58(),
      credentialName: record.credential.name,
      cluster,
      multisigPda: record.multisigPda,
      multisigVaultPda: record.multisigVaultPda,
      proposalIndex: 'DRY',
      reason: args.reason,
      reasonSha256: crypto
        .createHash('sha256')
        .update(args.reason, 'utf8')
        .digest('hex'),
      auditorCosig: null,
      approvers: [],
      transactions: {},
      suspendedAt: new Date().toISOString(),
      dryRun: true,
      nextSteps: buildNextSteps(new Date()),
    };
    const logPath = writeSuspendLog(dryLog);
    process.stdout.write(`[adr-081] dry-run log: ${logPath}\n`);
    return;
  }

  // Live: load Squads config + signers, drive the ceremony.
  const squads = loadSquadsConfig();
  const multisigPda = new PublicKey(squads.multisigPda);
  const signer1 = loadKeypair(SIGNER_1_PATH);
  const signer2 = loadKeypair(SIGNER_2_PATH);

  const rpcUrl = CLUSTER_RPC[cluster];
  if (!rpcUrl) {
    throw new Error(`unknown cluster ${cluster} — no RPC URL configured`);
  }
  const connection = new Connection(rpcUrl, 'confirmed');
  const rpc = makeLiveSquadsRpc(connection);

  const result = await runProposalFlow({
    rpc,
    multisigPda,
    multisigVaultPda,
    signers: [signer1, signer2],
    innerInstruction: innerIx,
    threshold: squads.threshold,
  });

  const suspendedAt = new Date();
  const log: SuspendLog = {
    credentialPda: credentialPubkey.toBase58(),
    credentialName: record.credential.name,
    cluster,
    multisigPda: record.multisigPda,
    multisigVaultPda: record.multisigVaultPda,
    proposalIndex: result.proposalIndex.toString(),
    reason: args.reason,
    reasonSha256: crypto
      .createHash('sha256')
      .update(args.reason, 'utf8')
      .digest('hex'),
    auditorCosig,
    approvers: result.approvers,
    transactions: result.transactions,
    suspendedAt: suspendedAt.toISOString(),
    dryRun: false,
    nextSteps: buildNextSteps(suspendedAt),
  };
  const logPath = writeSuspendLog(log);
  const transparencyPath = writeTransparencyLogStub(log);
  process.stdout.write(`[adr-081] log written: ${logPath}\n`);
  if (transparencyPath) {
    process.stdout.write(`[adr-081] transparency-log stub: ${transparencyPath}\n`);
  }
  printNextStepGuidance(log);
}

export function buildNextSteps(suspendedAt: Date): SuspendLog['nextSteps'] {
  const oneDayMs = 24 * 60 * 60 * 1000;
  return {
    rotateBy: new Date(suspendedAt.getTime() + oneDayMs).toISOString(),
    rotateScript:
      'scripts/rotate-credential-authority.ts (TODO: implement before mainnet — see ADR-081 §4.1)',
    auditBy: new Date(suspendedAt.getTime() + 7 * oneDayMs).toISOString(),
    auditScript:
      'scripts/audit-suspended-credential-attestations.ts (TODO: implement before mainnet — see ADR-081 §4.2)',
  };
}

// Run as script unless imported (the test file imports the module).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[adr-081] suspend failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

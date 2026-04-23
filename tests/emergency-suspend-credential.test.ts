/**
 * Unit tests for `scripts/emergency-suspend-credential.ts` — ADR-081.
 *
 * Runs under Node's built-in test runner (`node:test`) via `tsx`, the
 * same pattern packages/sas-resolver and packages/capability-manifest-validator
 * use. Does NOT use mocha — the Anchor-rooted suites in tests/ that mocha
 * runs require a solana-test-validator; this script's tests must be
 * runnable without a validator.
 *
 * Run with:
 *   npx tsx --test tests/emergency-suspend-credential.test.ts
 *
 * Mocks the `SquadsRpc` interface so the proposal lifecycle can be
 * exercised without touching a real validator. Asserts:
 *
 *   (a) refuses with --dry-run if the credential pubkey doesn't match
 *       the SAS record config (typo defense per ADR-081 §7);
 *   (b) constructs the right SAS instruction payload (discriminator,
 *       account list, empty-signers data);
 *   (c) handles re-run after partial failure: a proposal already in
 *       `Approved` state skips the create + approve stages and resumes
 *       at execute (idempotent per ADR-081 §5).
 *
 * Plus supporting tests for cosign-message determinism, auditor cosign
 * verification, and the prior-log scan.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

import {
  parseCliArgs,
  resolveCredentialPubkey,
  computeCosignMessage,
  verifyAuditorCosig,
  encodeChangeAuthorizedSignersData,
  buildChangeAuthorizedSignersIx,
  runProposalFlow,
  findExistingSuspendLog,
  writeSuspendLog,
  buildNextSteps,
  type SasRecord,
  type SquadsRpc,
  type ProposalStatus,
  type ProposalState,
  type SuspendLog,
} from "../scripts/emergency-suspend-credential";

// -- Test fixtures ----------------------------------------------------------

function makeRecord(overrides: Partial<SasRecord> = {}): SasRecord {
  return {
    cluster: "devnet",
    sasProgramId: "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
    multisigPda: "EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz",
    multisigVaultPda: "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
    vaultIndex: 0,
    credential: {
      pda: "GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS",
      name: "AEP_PROTOCOL",
      authority: "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
      signers: [],
      createdAt: "2026-04-22T19:06:46.150Z",
    },
    governance: { auditorCosignPubkey: null },
    ...overrides,
  };
}

/**
 * Mock SquadsRpc — drives `runProposalFlow` through scripted stages
 * without any RPC. The mock records every call for later assertion and
 * returns canned values per the configured stage transitions.
 */
class MockSquadsRpc implements SquadsRpc {
  public calls: Array<{ method: string; args: unknown }> = [];
  public proposalStatusSequence: ProposalStatus[];
  public initialApproved: string[];
  public transactionIndex: bigint;

  constructor(opts: {
    transactionIndex?: bigint;
    proposalStatusSequence: ProposalStatus[];
    initialApproved?: string[];
  }) {
    this.transactionIndex = opts.transactionIndex ?? 0n;
    this.proposalStatusSequence = [...opts.proposalStatusSequence];
    this.initialApproved = opts.initialApproved ?? [];
  }

  async fetchMultisig(multisigPda: PublicKey) {
    this.calls.push({ method: "fetchMultisig", args: { multisigPda: multisigPda.toBase58() } });
    return { transactionIndex: this.transactionIndex };
  }

  async fetchProposal(_multisigPda: PublicKey, transactionIndex: bigint): Promise<ProposalState> {
    this.calls.push({
      method: "fetchProposal",
      args: { transactionIndex: transactionIndex.toString() },
    });
    const status = this.proposalStatusSequence.shift() ?? "None";
    return {
      status,
      // Approved list reflects what the multisig has at this point.
      approved: status === "None" || status === "Draft" ? [] : this.initialApproved,
    };
  }

  async vaultTransactionCreate(params: {
    multisigPda: PublicKey;
    multisigVaultPda: PublicKey;
    transactionIndex: bigint;
    creator: Keypair;
    innerInstruction: TransactionInstruction;
  }): Promise<string> {
    this.calls.push({
      method: "vaultTransactionCreate",
      args: {
        transactionIndex: params.transactionIndex.toString(),
        creator: params.creator.publicKey.toBase58(),
        ixProgramId: params.innerInstruction.programId.toBase58(),
        ixDataHex: Buffer.from(params.innerInstruction.data).toString("hex"),
      },
    });
    return "MOCK_VAULT_CREATE_SIG";
  }

  async proposalCreate(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    creator: Keypair;
  }): Promise<string> {
    this.calls.push({
      method: "proposalCreate",
      args: {
        transactionIndex: params.transactionIndex.toString(),
        creator: params.creator.publicKey.toBase58(),
      },
    });
    return "MOCK_PROPOSAL_CREATE_SIG";
  }

  async proposalApprove(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    member: Keypair;
  }): Promise<string> {
    this.calls.push({
      method: "proposalApprove",
      args: {
        transactionIndex: params.transactionIndex.toString(),
        member: params.member.publicKey.toBase58(),
      },
    });
    // Add this approver to the running list so the next fetchProposal
    // sees it. Important for idempotency: re-runs must not double-approve.
    this.initialApproved = [...this.initialApproved, params.member.publicKey.toBase58()];
    return `MOCK_APPROVE_SIG_${params.member.publicKey.toBase58().slice(0, 6)}`;
  }

  async vaultTransactionExecute(params: {
    multisigPda: PublicKey;
    transactionIndex: bigint;
    member: Keypair;
    feePayer: Keypair;
  }): Promise<string> {
    this.calls.push({
      method: "vaultTransactionExecute",
      args: {
        transactionIndex: params.transactionIndex.toString(),
        member: params.member.publicKey.toBase58(),
      },
    });
    return "MOCK_EXECUTE_SIG";
  }
}

// -- Tests ------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("parses all supported flags", () => {
    const args = parseCliArgs([
      "--credential",
      "GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS",
      "--reason",
      "test compromise",
      "--auditor-cosig",
      "/tmp/cosig.json",
      "--dry-run",
    ]);
    assert.equal(args.credential, "GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    assert.equal(args.reason, "test compromise");
    assert.equal(args.auditorCosig, "/tmp/cosig.json");
    assert.equal(args.dryRun, true);
  });

  it("requires --reason", () => {
    assert.throws(
      () => parseCliArgs(["--dry-run"]),
      /--reason is required/,
    );
  });

  it("rejects unknown arguments", () => {
    assert.throws(
      () => parseCliArgs(["--reason", "x", "--bogus"]),
      /unknown argument: --bogus/,
    );
  });
});

describe("resolveCredentialPubkey (typo defense — ADR-081 §7)", () => {
  it("(a) refuses with --dry-run if --credential does not match the config", () => {
    // Different (valid) base58 pubkey — would otherwise pass shape-validation
    // and silently target the wrong credential. We want to refuse.
    const wrongPubkey = Keypair.generate().publicKey.toBase58();
    const record = makeRecord();
    assert.throws(
      () => resolveCredentialPubkey(wrongPubkey, record),
      /does not match SAS record credential\.pda/,
    );
  });

  it("returns the SAS record's credential pubkey when --credential is omitted", () => {
    const record = makeRecord();
    const pubkey = resolveCredentialPubkey(undefined, record);
    assert.equal(pubkey.toBase58(), record.credential.pda);
  });

  it("returns the supplied --credential when it matches the config", () => {
    const record = makeRecord();
    const pubkey = resolveCredentialPubkey(record.credential.pda, record);
    assert.equal(pubkey.toBase58(), record.credential.pda);
  });
});

describe("encodeChangeAuthorizedSignersData (b — right SAS instruction payload)", () => {
  it("encodes empty signer list as [u8 disc=4, u32 count=0]", () => {
    const data = encodeChangeAuthorizedSignersData([]);
    assert.equal(data.length, 5);
    assert.equal(data[0], 4); // discriminator IX_CHANGE_AUTHORIZED_SIGNERS
    // count == 0 LE u32 → bytes 1..5 are zero
    assert.equal(data.readUInt32LE(1), 0);
  });

  it("encodes N pubkeys as [u8 disc, u32 N, 32B * N]", () => {
    const k1 = Keypair.generate().publicKey;
    const k2 = Keypair.generate().publicKey;
    const data = encodeChangeAuthorizedSignersData([k1, k2]);
    assert.equal(data.length, 1 + 4 + 32 + 32);
    assert.equal(data[0], 4);
    assert.equal(data.readUInt32LE(1), 2);
    assert.deepEqual(
      Uint8Array.from(data.slice(5, 37)),
      k1.toBytes(),
    );
    assert.deepEqual(
      Uint8Array.from(data.slice(37, 69)),
      k2.toBytes(),
    );
  });
});

describe("buildChangeAuthorizedSignersIx (b — instruction account layout)", () => {
  it("builds the right account list for suspension", () => {
    const vault = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const ix = buildChangeAuthorizedSignersIx({
      payer: vault,
      authority: vault,
      credential,
      newSigners: [], // suspend == empty
    });
    // 4 accounts: payer (signer+writable), authority (signer), credential
    // (writable), system program.
    assert.equal(ix.keys.length, 4);
    assert.equal(ix.keys[0]!.pubkey.toBase58(), vault.toBase58());
    assert.equal(ix.keys[0]!.isSigner, true);
    assert.equal(ix.keys[0]!.isWritable, true);
    assert.equal(ix.keys[1]!.pubkey.toBase58(), vault.toBase58());
    assert.equal(ix.keys[1]!.isSigner, true);
    assert.equal(ix.keys[1]!.isWritable, false);
    assert.equal(ix.keys[2]!.pubkey.toBase58(), credential.toBase58());
    assert.equal(ix.keys[2]!.isSigner, false);
    assert.equal(ix.keys[2]!.isWritable, true);
    // ix data: [4, 0, 0, 0, 0]
    assert.equal(ix.data.length, 5);
    assert.equal(ix.data[0], 4);
  });

  it("targets the SAS program ID", () => {
    const vault = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const ix = buildChangeAuthorizedSignersIx({
      payer: vault,
      authority: vault,
      credential,
      newSigners: [],
    });
    assert.equal(
      ix.programId.toBase58(),
      "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
    );
  });
});

describe("runProposalFlow (c — idempotency / resumability per ADR-081 §5)", () => {
  it("runs the full ceremony from scratch when no proposal exists", async () => {
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const multisigPda = Keypair.generate().publicKey;
    const multisigVaultPda = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const innerIx = buildChangeAuthorizedSignersIx({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential,
      newSigners: [],
    });

    // Sequence:
    //   fetchProposal (entry)         → None  → vault-create
    //   fetchProposal (post-approval) → Approved → execute
    const rpc = new MockSquadsRpc({
      transactionIndex: 0n,
      proposalStatusSequence: ["None", "Approved"],
    });

    const result = await runProposalFlow({
      rpc,
      multisigPda,
      multisigVaultPda,
      signers: [signer1, signer2],
      innerInstruction: innerIx,
      threshold: 2,
    });

    assert.equal(result.alreadyExecuted, false);
    assert.equal(result.proposalIndex, 1n);
    assert.ok(result.transactions.vaultTransactionCreate);
    assert.ok(result.transactions.proposalCreate);
    assert.equal(result.transactions.proposalApprove?.length, 2);
    assert.ok(result.transactions.vaultTransactionExecute);

    // Trace: the order of mocked RPC calls.
    // Note the trailing `fetchProposal` — runProposalFlow re-reads the
    // proposal after execute to capture the final approver list for the
    // SuspendLog. This matters: the audit trail records who actually
    // signed, not who we asked to sign.
    const methodOrder = rpc.calls.map((c) => c.method);
    assert.deepEqual(methodOrder, [
      "fetchMultisig",
      "fetchProposal", // entry status check
      "vaultTransactionCreate",
      "proposalCreate",
      "proposalApprove", // signer1
      "proposalApprove", // signer2
      "fetchProposal", // post-approval status check
      "vaultTransactionExecute",
      "fetchProposal", // final approver-list capture for the log
    ]);
  });

  it("(c) skips create+approve when proposal is already Approved (resume after crash)", async () => {
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const multisigPda = Keypair.generate().publicKey;
    const multisigVaultPda = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const innerIx = buildChangeAuthorizedSignersIx({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential,
      newSigners: [],
    });

    // Simulate: prior run got all the way to `Approved` then crashed
    // before vaultTransactionExecute. Both signers already approved.
    // Three status reads needed: entry, post-approval, final-capture.
    const rpc = new MockSquadsRpc({
      transactionIndex: 0n,
      proposalStatusSequence: ["Approved", "Approved", "Approved"],
      initialApproved: [signer1.publicKey.toBase58(), signer2.publicKey.toBase58()],
    });

    const result = await runProposalFlow({
      rpc,
      multisigPda,
      multisigVaultPda,
      signers: [signer1, signer2],
      innerInstruction: innerIx,
      threshold: 2,
    });

    assert.equal(result.alreadyExecuted, false);
    // create + approve were skipped; only execute happened.
    assert.equal(result.transactions.vaultTransactionCreate, undefined);
    assert.equal(result.transactions.proposalCreate, undefined);
    assert.equal(result.transactions.proposalApprove, undefined);
    assert.ok(result.transactions.vaultTransactionExecute);

    const methodOrder = rpc.calls.map((c) => c.method);
    assert.deepEqual(methodOrder, [
      "fetchMultisig",
      "fetchProposal", // entry — sees Approved, skips create
      "fetchProposal", // post-approval — still Approved
      "vaultTransactionExecute",
      "fetchProposal", // final approver-list capture
    ]);
  });

  it("(c) is a no-op when proposal is already Executed", async () => {
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const multisigPda = Keypair.generate().publicKey;
    const multisigVaultPda = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const innerIx = buildChangeAuthorizedSignersIx({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential,
      newSigners: [],
    });

    const rpc = new MockSquadsRpc({
      transactionIndex: 5n,
      proposalStatusSequence: ["Executed"],
      initialApproved: [signer1.publicKey.toBase58(), signer2.publicKey.toBase58()],
    });

    const result = await runProposalFlow({
      rpc,
      multisigPda,
      multisigVaultPda,
      signers: [signer1, signer2],
      innerInstruction: innerIx,
      threshold: 2,
    });

    assert.equal(result.alreadyExecuted, true);
    assert.equal(result.proposalIndex, 6n);
    assert.equal(result.transactions.vaultTransactionExecute, undefined);
    // Only fetchMultisig + fetchProposal happened — no submission.
    const methodOrder = rpc.calls.map((c) => c.method);
    assert.deepEqual(methodOrder, ["fetchMultisig", "fetchProposal"]);
  });

  it("(c) resumes mid-approve: signer1 already approved, signer2 still needs to", async () => {
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const multisigPda = Keypair.generate().publicKey;
    const multisigVaultPda = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const innerIx = buildChangeAuthorizedSignersIx({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential,
      newSigners: [],
    });

    // Active proposal with one prior approval. The flow should add only
    // signer2's approval, not re-submit signer1's.
    const rpc = new MockSquadsRpc({
      transactionIndex: 0n,
      proposalStatusSequence: ["Active", "Approved"],
      initialApproved: [signer1.publicKey.toBase58()],
    });

    const result = await runProposalFlow({
      rpc,
      multisigPda,
      multisigVaultPda,
      signers: [signer1, signer2],
      innerInstruction: innerIx,
      threshold: 2,
    });

    assert.equal(result.transactions.vaultTransactionCreate, undefined);
    assert.equal(result.transactions.proposalCreate, undefined);
    assert.equal(result.transactions.proposalApprove?.length, 1);
    // The single approve call was for signer2 (signer1 was already in
    // the approved list).
    const approveCall = rpc.calls.find((c) => c.method === "proposalApprove");
    assert.ok(approveCall);
    assert.equal(
      (approveCall.args as { member: string }).member,
      signer2.publicKey.toBase58(),
    );
  });

  it("refuses to resume a Rejected proposal", async () => {
    const signer1 = Keypair.generate();
    const signer2 = Keypair.generate();
    const multisigPda = Keypair.generate().publicKey;
    const multisigVaultPda = Keypair.generate().publicKey;
    const credential = Keypair.generate().publicKey;
    const innerIx = buildChangeAuthorizedSignersIx({
      payer: multisigVaultPda,
      authority: multisigVaultPda,
      credential,
      newSigners: [],
    });

    const rpc = new MockSquadsRpc({
      transactionIndex: 0n,
      proposalStatusSequence: ["Rejected"],
    });

    await assert.rejects(
      runProposalFlow({
        rpc,
        multisigPda,
        multisigVaultPda,
        signers: [signer1, signer2],
        innerInstruction: innerIx,
        threshold: 2,
      }),
      /is Rejected; cannot resume/,
    );
  });
});

describe("computeCosignMessage", () => {
  it("is deterministic — same credential + reason → same message", () => {
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    const reason = "signer-compromise: K1 leaked";
    const m1 = computeCosignMessage(credential, reason);
    const m2 = computeCosignMessage(credential, reason);
    assert.equal(m1, m2);
  });

  it("hashes the reason (so the cosig commits to the exact reason text)", () => {
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    const m1 = computeCosignMessage(credential, "reason A");
    const m2 = computeCosignMessage(credential, "reason B");
    assert.notEqual(m1, m2);
    const expectedPrefix = "AEP-EMERGENCY-SUSPEND:GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS:";
    assert.ok(m1.startsWith(expectedPrefix));
    // The trailing field is the SHA-256 hex of the reason.
    const expectedHash = crypto.createHash("sha256").update("reason A").digest("hex");
    assert.equal(m1, expectedPrefix + expectedHash);
  });
});

describe("verifyAuditorCosig", () => {
  function makeAuditor(): { secretKey: Uint8Array; publicKeyBase58: string } {
    const secretKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(secretKey);
    return {
      secretKey,
      publicKeyBase58: new PublicKey(publicKey).toBase58(),
    };
  }

  it("accepts a valid Ed25519 signature over the canonical message", () => {
    const auditor = makeAuditor();
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    const reason = "signer-compromise: K1 leaked";
    const message = computeCosignMessage(credential, reason);
    const sig = ed25519.sign(Buffer.from(message, "utf8"), auditor.secretKey);
    const ok = verifyAuditorCosig({
      cosig: {
        auditorPubkey: auditor.publicKeyBase58,
        signature: Buffer.from(sig).toString("base64"),
      },
      credential,
      reason,
      registeredAuditorPubkey: auditor.publicKeyBase58,
    });
    assert.equal(ok, true);
  });

  it("refuses when no auditor pubkey is registered", () => {
    const auditor = makeAuditor();
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    assert.throws(
      () =>
        verifyAuditorCosig({
          cosig: {
            auditorPubkey: auditor.publicKeyBase58,
            signature: Buffer.alloc(64).toString("base64"),
          },
          credential,
          reason: "x",
          registeredAuditorPubkey: null,
        }),
      /No auditor pubkey registered/,
    );
  });

  it("refuses when the cosign auditor differs from the registered auditor", () => {
    const auditor = makeAuditor();
    const decoy = makeAuditor();
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    const reason = "x";
    const message = computeCosignMessage(credential, reason);
    const sig = ed25519.sign(Buffer.from(message, "utf8"), auditor.secretKey);
    assert.throws(
      () =>
        verifyAuditorCosig({
          cosig: {
            auditorPubkey: auditor.publicKeyBase58,
            signature: Buffer.from(sig).toString("base64"),
          },
          credential,
          reason,
          registeredAuditorPubkey: decoy.publicKeyBase58,
        }),
      /does not match registered auditor/,
    );
  });

  it("refuses a forged signature (Ed25519 verification fails)", () => {
    const auditor = makeAuditor();
    const credential = new PublicKey("GvDdPwwqV9wfEaRh1LjLYhjDRFkMxCDRdepVeHGMfRhS");
    const reason = "x";
    // 64 bytes of zero — valid shape but cryptographically wrong.
    const fakeSig = Buffer.alloc(64);
    assert.throws(
      () =>
        verifyAuditorCosig({
          cosig: {
            auditorPubkey: auditor.publicKeyBase58,
            signature: fakeSig.toString("base64"),
          },
          credential,
          reason,
          registeredAuditorPubkey: auditor.publicKeyBase58,
        }),
      /failed Ed25519 verification/,
    );
  });
});

describe("findExistingSuspendLog (idempotency — short-circuit on prior suspend)", () => {
  it("returns null when the logs dir doesn't exist", () => {
    const cred = Keypair.generate().publicKey;
    const tmp = path.join(os.tmpdir(), `aep-test-${crypto.randomUUID()}`);
    assert.equal(findExistingSuspendLog(cred, tmp), null);
  });

  it("returns null when no log matches the credential", () => {
    const cred = Keypair.generate().publicKey;
    const otherCred = Keypair.generate().publicKey;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aep-test-"));
    const log: SuspendLog = {
      credentialPda: otherCred.toBase58(),
      credentialName: "AEP_PROTOCOL",
      cluster: "devnet",
      multisigPda: "EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz",
      multisigVaultPda: "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
      proposalIndex: "1",
      reason: "test",
      reasonSha256: "deadbeef",
      auditorCosig: null,
      approvers: [],
      transactions: { vaultTransactionExecute: "EXEC_SIG" },
      suspendedAt: new Date().toISOString(),
      dryRun: false,
      nextSteps: buildNextSteps(new Date()),
    };
    writeSuspendLog(log, tmp);
    assert.equal(findExistingSuspendLog(cred, tmp), null);
  });

  it("returns the path of a matching, executed, non-dry-run log", () => {
    const cred = Keypair.generate().publicKey;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aep-test-"));
    const log: SuspendLog = {
      credentialPda: cred.toBase58(),
      credentialName: "AEP_PROTOCOL",
      cluster: "devnet",
      multisigPda: "EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz",
      multisigVaultPda: "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
      proposalIndex: "1",
      reason: "test",
      reasonSha256: "deadbeef",
      auditorCosig: null,
      approvers: ["someone"],
      transactions: { vaultTransactionExecute: "EXEC_SIG" },
      suspendedAt: new Date().toISOString(),
      dryRun: false,
      nextSteps: buildNextSteps(new Date()),
    };
    const written = writeSuspendLog(log, tmp);
    assert.equal(findExistingSuspendLog(cred, tmp), written);
  });

  it("ignores dry-run logs (they don't count as a real suspension)", () => {
    const cred = Keypair.generate().publicKey;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aep-test-"));
    const log: SuspendLog = {
      credentialPda: cred.toBase58(),
      credentialName: "AEP_PROTOCOL",
      cluster: "devnet",
      multisigPda: "EHdxwBkcSEcJe3E2UrRwwYozPjqZNe8HZrrBTeU6NPcz",
      multisigVaultPda: "Exs7cm5dKZNr5c7rBAcq52EHUs7nxDWiZtHXzTEh3LPo",
      proposalIndex: "DRY",
      reason: "test",
      reasonSha256: "deadbeef",
      auditorCosig: null,
      approvers: [],
      transactions: {},
      suspendedAt: new Date().toISOString(),
      dryRun: true,
      nextSteps: buildNextSteps(new Date()),
    };
    writeSuspendLog(log, tmp);
    assert.equal(findExistingSuspendLog(cred, tmp), null);
  });
});

describe("buildNextSteps", () => {
  it("emits T+24h and T+7d markers", () => {
    const t = new Date("2026-04-23T01:00:00.000Z");
    const ns = buildNextSteps(t);
    assert.equal(ns.rotateBy, "2026-04-24T01:00:00.000Z");
    assert.equal(ns.auditBy, "2026-04-30T01:00:00.000Z");
    assert.match(ns.rotateScript, /rotate-credential-authority\.ts/);
    assert.match(ns.auditScript, /audit-suspended-credential-attestations\.ts/);
    // Both reference TODO follow-ups so operators see the gap.
    assert.match(ns.rotateScript, /TODO/);
    assert.match(ns.auditScript, /TODO/);
  });
});

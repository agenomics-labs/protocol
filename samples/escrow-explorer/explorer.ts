/**
 * AEP gallery sample — escrow-explorer
 *
 * SCOPE NOTE (read me first):
 *   This sample is READ-ONLY, like every v1 gallery entry. It exercises
 *   the `SettlementClient` read surface:
 *
 *       connect  ->  fetch ProtocolConfig  ->  derive escrow PDA  ->
 *       fetch TaskEscrow  ->  render lifecycle state
 *
 *   `@agenomics/client@0.1.0` ships PDA derivation + typed account
 *   fetch only. The WRITE side of the settlement program
 *   (`createEscrow`, fund, approve milestone, dispute, settle) is out
 *   of scope per ADR-098 — those are the documented SDK roadmap. This
 *   sample is the honest read-side counterpart of the agent-to-agent
 *   settlement thesis: it shows the escrow lifecycle *as observed
 *   on-chain*, not as driven by this script.
 *
 *   The ProtocolConfig PDA is a singleton (one per program); it is
 *   always fetchable when the program is bootstrapped. A specific
 *   TaskEscrow requires its (client, provider, taskId) tuple — supply
 *   these via env vars to inspect a real escrow. Without them, the
 *   sample still demonstrates the full ProtocolConfig read path and
 *   prints exactly how to point it at an escrow.
 *
 * What this script demonstrates, end-to-end:
 *   1. Build an `AnchorProvider` for Solana devnet (read-only).
 *   2. Resolve cluster-keyed program IDs via `getProgramIds("devnet")`.
 *   3. Construct a `SettlementClient`.
 *   4. Derive + fetch the singleton `ProtocolConfig`, rendering
 *      governance parameters (min escrow amount, dispute timeout).
 *   5. If ESCROW_CLIENT / ESCROW_PROVIDER / ESCROW_TASK_ID are set,
 *      derive the escrow PDA and fetch + render the `TaskEscrow`
 *      lifecycle state (status, total, milestone breakdown).
 */

import { AnchorProvider, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import type { Address } from "@solana/kit";

import { SettlementIdl, getProgramIds } from "@agenomics/idl";
import { SettlementClient, EscrowStatus } from "@agenomics/client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Solana devnet RPC endpoint. Override with the RPC_URL env var. */
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

interface EscrowTarget {
  client: string;
  provider: string;
  taskId: bigint;
}

/** Resolve the optional escrow target from env vars. All three or none. */
function resolveEscrowTarget(): EscrowTarget | null {
  const client = process.env.ESCROW_CLIENT?.trim();
  const provider = process.env.ESCROW_PROVIDER?.trim();
  const taskIdRaw = process.env.ESCROW_TASK_ID?.trim();
  if (!client || !provider || !taskIdRaw) return null;
  let taskId: bigint;
  try {
    taskId = BigInt(taskIdRaw);
  } catch {
    throw new Error(
      `ESCROW_TASK_ID must be an integer, got "${taskIdRaw}"`,
    );
  }
  return { client, provider, taskId };
}

/** Render an Anchor enum-shaped status (e.g. `{ active: {} }`) as a label. */
function statusLabel(status: unknown): string {
  if (status && typeof status === "object") {
    const keys = Object.keys(status as Record<string, unknown>);
    if (keys.length === 1) return keys[0];
  }
  return String(status);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`escrow-explorer — read-only settlement inspector (devnet)\n`);

  // Read-only: a generated keypair is sufficient; we never sign or send.
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const programIds = getProgramIds("devnet");
  const settlementProgramId = programIds.settlement as Address;
  console.log(`settlement program: ${settlementProgramId}\n`);

  // Canonical IDL cast pattern, matching examples/register-agent.ts:
  // the IDL JSON is cast through `Idl` at the call site (sdk/client
  // README); the typed client wraps it in an Anchor `Program`.
  const settlement = new SettlementClient(
    provider,
    SettlementIdl as unknown as ConstructorParameters<
      typeof SettlementClient
    >[1],
    settlementProgramId,
  );

  // ----- Step 4: the singleton ProtocolConfig -----------------------------
  const protocolConfigPda = await settlement.protocolConfigPda();
  console.log(`ProtocolConfig PDA: ${protocolConfigPda}`);
  try {
    const cfg = await settlement.fetchProtocolConfig();
    console.log(`  min escrow amount:      ${cfg.minEscrowAmount.toString()}`);
    console.log(
      `  dispute timeout (s):    ${cfg.disputeTimeoutSeconds.toString()}`,
    );
    console.log(`  (governance parameters per ADR-075)\n`);
  } catch {
    console.log(
      `  no ProtocolConfig account at this PDA — the settlement\n` +
        `  program is not bootstrapped on this cluster, or the RPC\n` +
        `  is stale. The config is a one-shot init by the program's\n` +
        `  upgrade authority; this sample only reads it.\n`,
    );
  }

  // ----- Step 5: optional specific escrow ---------------------------------
  const target = resolveEscrowTarget();
  if (!target) {
    console.log(
      `no escrow target set. To inspect a specific TaskEscrow, set:\n` +
        `  ESCROW_CLIENT=<client pubkey> \\\n` +
        `  ESCROW_PROVIDER=<provider pubkey> \\\n` +
        `  ESCROW_TASK_ID=<u64 task id> \\\n` +
        `  npm start\n\n` +
        `Known EscrowStatus variants the SDK decodes: ` +
        `${Object.keys(EscrowStatus)
          .filter((k) => Number.isNaN(Number(k)))
          .join(", ")}.\n` +
        `The write side (createEscrow / fund / approveMilestone /\n` +
        `dispute / settle) is out of scope for @agenomics/client@0.1.0;\n` +
        `see ADR-098 and sdk/client/README.md for the roadmap.`,
    );
    return;
  }

  let escrowPda: string;
  try {
    escrowPda = await settlement.escrowPda(
      target.client as Address,
      target.provider as Address,
      target.taskId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `\ninvalid escrow target (bad client/provider pubkey?): ${message}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nTaskEscrow PDA: ${escrowPda}`);
  console.log(`  client:   ${target.client}`);
  console.log(`  provider: ${target.provider}`);
  console.log(`  task id:  ${target.taskId}`);

  try {
    const escrow = await settlement.fetchEscrow(
      target.client as Address,
      target.provider as Address,
      target.taskId,
    );
    console.log(`\n  status:        ${statusLabel(escrow.status)}`);
    console.log(`  total amount:  ${escrow.totalAmount.toString()}`);
    const milestones = (escrow.milestones ?? []) as Array<{
      amount: { toString(): string };
      status: unknown;
    }>;
    console.log(`  milestones:    ${milestones.length}`);
    milestones.forEach((m, i) => {
      console.log(
        `    [${i}] amount=${m.amount.toString()} ` +
          `status=${statusLabel(m.status)}`,
      );
    });
    if (escrow.disputedAt != null) {
      console.log(`  disputed at:   ${escrow.disputedAt.toString()}`);
    }
  } catch {
    console.log(
      `\n  no TaskEscrow account at this PDA — either the escrow was\n` +
        `  never created for this (client, provider, taskId) tuple, or\n` +
        `  the seeds differ. This sample only reads escrows; creating\n` +
        `  one requires a \`createEscrow\` transaction, which is out of\n` +
        `  scope for @agenomics/client@0.1.0 (ADR-098 roadmap).`,
    );
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});

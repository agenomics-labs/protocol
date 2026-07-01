#!/usr/bin/env node
/**
 * Surface 3 fallback — CCTP V2 relayer.
 *
 * Demo-grade relayer that watches for x402-settle events on the Base side and
 * calls AEP Settlement `approve_milestone` directly with a relayer signing
 * key, bypassing the on-chain Hook. Per the master spec
 * (`docs/aep-reflex-tech-spec.md` §"Surface 3 — Fallback") and the surface
 * spec (`.kiro/specs/surface-3-cctp-hook/spec.md` §"Fallback: off-chain
 * relayer"), this is the safety-net that ships if the Hook integration slips.
 *
 * Scope of THIS file (Day 1-3):
 *   - Polling skeleton with a pluggable Base-side event source.
 *   - Idempotency cache (in-memory; swap for DynamoDB in production).
 *   - Solana-side tx construction stub for `approve_milestone`.
 *   - Step-by-step structured logging.
 *
 * Out of scope (Day 4-7):
 *   - Real Base RPC subscription via viem / ethers.
 *   - DynamoDB conditional-put for idempotency (R9 mitigation).
 *   - Relayer key custody in AgentCore Identity vault.
 *   - Per-session key rotation.
 *
 * Usage (local demo):
 *   npx tsx scripts/cctp-relayer.ts --once   # process pending event(s) and exit
 *   npx tsx scripts/cctp-relayer.ts          # run continuously, polling every 5s
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One pending Base→Solana round-trip the relayer needs to settle.
 *
 * In production, `BaseSettleEvent` is emitted by Surface 2's `pay_x402_service`
 * /CCTP-burn flow on Base mainnet (or Sepolia for devnet). For the Day 1-3
 * skeleton, the event source is pluggable so a stub can feed deterministic
 * fixtures for offline rehearsal.
 */
export interface BaseSettleEvent {
  /** AEP Settlement escrow PDA. */
  escrowPda: string;
  /** Milestone index to approve (u8). */
  milestoneIndex: number;
  /** Base-side burn / settle tx hash, hex (no 0x prefix), 64 chars. */
  baseTxHash: string;
  /** USDC amount returned to Solana, in 6-decimal "micros". */
  amountReturnedMicros: bigint;
  /** Agent CDP wallet address on Base (EVM hex). For Registry binding lookup. */
  agentCdpWalletAddress: string;
}

/** Source of `BaseSettleEvent`s. Plug viem watcher / SQS / DynamoDB stream. */
export interface EventSource {
  poll(): Promise<BaseSettleEvent[]>;
}

/** Idempotency cache. Swap in-memory for DynamoDB conditional-put in prod. */
export interface IdempotencyStore {
  /** Returns true iff the key was newly inserted (first-time). */
  recordIfNew(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory idempotency cache (demo-grade)
// ---------------------------------------------------------------------------

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Set<string>();
  async recordIfNew(key: string): Promise<boolean> {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stub event source — reads from a JSONL file at $CCTP_RELAYER_FIXTURE.
// Production swap: a viem `watchEvent` driving an in-memory queue.
// ---------------------------------------------------------------------------

class FixtureEventSource implements EventSource {
  constructor(private readonly path: string) {}

  async poll(): Promise<BaseSettleEvent[]> {
    if (!fs.existsSync(this.path)) return [];
    const lines = fs
      .readFileSync(this.path, "utf-8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.map((line) => {
      const raw = JSON.parse(line);
      return {
        escrowPda: String(raw.escrowPda),
        milestoneIndex: Number(raw.milestoneIndex),
        baseTxHash: String(raw.baseTxHash),
        amountReturnedMicros: BigInt(raw.amountReturnedMicros),
        agentCdpWalletAddress: String(raw.agentCdpWalletAddress),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Solana-side tx construction
// ---------------------------------------------------------------------------

/**
 * Build the `approve_milestone` instruction for Settlement.
 *
 * STUB. The full account list mirrors `programs/settlement/src/contexts.rs::ApproveMilestone`
 * (11 accounts). The relayer caller is responsible for resolving:
 *   - escrow PDA (provided by `event.escrowPda`)
 *   - escrow + provider token accounts (looked up from on-chain escrow state)
 *   - registry program ID (constant)
 *   - provider authority / owner-nonce / profile (derived from escrow.provider)
 *   - settlement_authority PDA (derived from Settlement program ID)
 *   - protocol_config PDA (derived from Settlement program ID)
 *   - token program (TOKEN_PROGRAM_ID)
 *
 * For Day 1-3 we inline the discriminator + arg encoding only; account
 * resolution is deferred to a follow-up PR (currently the `tests/settlement.ts`
 * suite has all the helpers; the relayer should consume them via the SDK
 * once a `SettlementClient.approveMilestoneIx(...)` builder lands).
 */
export function buildApproveMilestoneIx(args: {
  programId: PublicKey;
  /** Pre-resolved keys; this is a stub – see `cctp-relayer.ts` doc. */
  keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  milestoneIndex: number;
  rating: number;
}): TransactionInstruction {
  // sha256("global:approve_milestone")[..8], pinned in
  // `programs/cctp-hook/src/lib.rs::APPROVE_MILESTONE_DISCRIMINATOR`.
  const DISCRIMINATOR = Buffer.from([145, 85, 92, 60, 50, 130, 219, 106]);
  const data = Buffer.concat([
    DISCRIMINATOR,
    // milestone_index: u32 LE
    Buffer.from(new Uint32Array([args.milestoneIndex >>> 0]).buffer),
    // rating: u8
    Buffer.from([args.rating & 0xff]),
  ]);
  return new TransactionInstruction({
    programId: args.programId,
    keys: args.keys,
    data,
  });
}

// ---------------------------------------------------------------------------
// Relayer
// ---------------------------------------------------------------------------

export interface RelayerConfig {
  rpcUrl: string;
  /** Settlement program ID. */
  settlementProgramId: PublicKey;
  /** Relayer signing key. In prod: rotated per session, sourced from AgentCore Identity vault. */
  relayerKey: Keypair;
  eventSource: EventSource;
  idempotencyStore: IdempotencyStore;
  /** Polling interval (ms). */
  pollIntervalMs: number;
  /** If true, exit after one poll cycle. */
  once: boolean;
  /** Pluggable logger (default: console). */
  log?: (level: "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export class CctpRelayer {
  private readonly conn: Connection;
  private readonly log: NonNullable<RelayerConfig["log"]>;

  constructor(private readonly cfg: RelayerConfig) {
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.log =
      cfg.log ??
      ((level, msg, data) => {
        const line = `[cctp-relayer] [${level.toUpperCase()}] ${msg}` +
          (data === undefined ? "" : " " + JSON.stringify(data));
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
      });
  }

  /** Run the relayer until the process is killed (or `once` is true). */
  async run(): Promise<void> {
    this.log("info", "starting relayer", {
      rpcUrl: this.cfg.rpcUrl,
      settlementProgramId: this.cfg.settlementProgramId.toBase58(),
      relayer: this.cfg.relayerKey.publicKey.toBase58(),
      pollIntervalMs: this.cfg.pollIntervalMs,
      once: this.cfg.once,
    });

    do {
      try {
        const events = await this.cfg.eventSource.poll();
        if (events.length > 0) {
          this.log("info", `polled ${events.length} settle event(s)`);
        }
        for (const ev of events) {
          await this.handleEvent(ev);
        }
      } catch (err: unknown) {
        this.log("error", "poll cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!this.cfg.once) {
        await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
      }
    } while (!this.cfg.once);
  }

  /** Process a single settle event end-to-end. Idempotent. */
  async handleEvent(ev: BaseSettleEvent): Promise<void> {
    const idempotencyKey = `${ev.escrowPda}:${ev.milestoneIndex}:${ev.baseTxHash}`;
    this.log("info", "received settle event", {
      escrow: ev.escrowPda,
      milestone: ev.milestoneIndex,
      baseTxHash: ev.baseTxHash,
      amountMicros: ev.amountReturnedMicros.toString(),
      agent: ev.agentCdpWalletAddress,
    });

    // 1. Idempotency gate (DynamoDB conditional-put in prod, memory cache here).
    const newKey = await this.cfg.idempotencyStore.recordIfNew(idempotencyKey);
    if (!newKey) {
      this.log("info", "duplicate event — skipping (idempotency guard)", {
        idempotencyKey,
      });
      return;
    }

    // 2. (Stub) Verify Base CCTP attestation. Production: call Circle's
    // CCTP V2 attestation API and confirm the burn message corresponds to
    // this event before signing anything on Solana.
    this.log("info", "step 1: verify Base CCTP attestation [STUB]");

    // 3. (Stub) Resolve full account list for `approve_milestone`. See
    // `buildApproveMilestoneIx` doc — this is where the SDK builder will
    // eventually live.
    this.log("info", "step 2: resolve Settlement account list [STUB]");

    // 4. Build + send the Solana transaction. The build step is left as a
    // stub here so the relayer doesn't hold a half-finished tx-construction
    // path; the test harness in `tests/cctp-hook.ts` already pins the
    // discriminator + arg encoding.
    this.log("info", "step 3: build approve_milestone tx [STUB]");

    // const ix = buildApproveMilestoneIx({ ... });
    // const tx = new Transaction().add(ix);
    // const sig = await sendAndConfirmTransaction(this.conn, tx, [this.cfg.relayerKey]);
    // this.log("info", "approve_milestone confirmed", { sig });

    this.log("info", "step 4: would submit to Solana (skipped in stub)", {
      idempotencyKey,
    });
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseArgs(): { once: boolean } {
  return { once: process.argv.includes("--once") };
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const { once } = parseArgs();
  const rpcUrl =
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const settlementProgramId = new PublicKey(
    process.env.SETTLEMENT_PROGRAM_ID ??
      "AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia",
  );
  const keyPath =
    process.env.RELAYER_KEY_PATH ??
    `${process.env.HOME}/.config/solana/id.json`;
  const fixturePath =
    process.env.CCTP_RELAYER_FIXTURE ?? "/tmp/cctp-relayer-events.jsonl";

  const relayer = new CctpRelayer({
    rpcUrl,
    settlementProgramId,
    relayerKey: loadKeypair(keyPath),
    eventSource: new FixtureEventSource(fixturePath),
    idempotencyStore: new MemoryIdempotencyStore(),
    pollIntervalMs: 5_000,
    once,
  });
  await relayer.run();
}

// Only run main() when invoked directly, not when imported for tests.
const invokedDirectly = (() => {
  try {
    // ESM-safe: process.argv[1] equals the script path even when launched via tsx.
    return process.argv[1]?.endsWith("cctp-relayer.ts");
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[cctp-relayer] fatal:", err);
    process.exit(1);
  });
}

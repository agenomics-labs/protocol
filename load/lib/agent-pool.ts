/**
 * Pre-provisioned agent pool for steady-state load scenarios.
 *
 * Phase 1's `full-lifecycle` scenario provisioned a fresh (client,
 * provider) pair for every flow. That dominates wall-clock (airdrop +
 * register × 2 + initialize_vault × 2 + per-flow mint + ATAs ≈ 7-12s
 * per flow on localnet) and biases the per-ix CU profile toward the
 * setup ixes that an established protocol does NOT exercise on the
 * hot path.
 *
 * Phase 2's `settlement-only` scenario instead pre-provisions a
 * **pool** of (client, provider) pairs ONCE at startup, then runs
 * many concurrent flows that ONLY exercise the settlement-phase ixes
 * (create_escrow → accept_task → submit_milestone →
 * approve_milestone), reusing the pool members in round-robin.
 *
 * Two correctness constraints drove the design:
 *
 *   1. **Per-client nonce**. The escrow PDA is derived from
 *      `["escrow", client, provider, task_id-le u64]`. Reusing the
 *      same (client, provider) pair across multiple flows requires
 *      a monotonically-increasing `task_id` per pair, otherwise the
 *      second flow lands on an already-occupied PDA and the
 *      `create_escrow` ix fails with `account already in use`. The
 *      pool tracks `nextTaskId` per pair and bumps it on each
 *      acquire.
 *
 *   2. **Single-writer safety**. A pair must not be in two flows
 *      concurrently — the second flow would race the first on the
 *      escrow-PDA derivation (could land on an occupied PDA between
 *      the first flow's create_escrow and the second flow's task-id
 *      bump) AND on the per-pair token-account balance. The pool
 *      enforces single-writer-per-pair via an async `acquire()` /
 *      `release()` pattern: callers await a free pair, get exclusive
 *      access for the duration of one flow, then return it.
 *
 * The pool also caches the per-pair token plumbing (mint authority +
 * mint + client ATA + provider ATA), provisioned once at pool
 * startup. The client ATA is minted with enough supply for all
 * expected flows on this pair (estimated as `flowsPerPair * escrowAmount
 * * safetyFactor`); if the supply runs low the next acquire performs a
 * just-in-time `mintTo` top-up using the cached mint authority.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  mintTo,
} from "@solana/spl-token";
import {
  provisionAgent,
  provisionFlowTokens,
  type Ed25519Signer,
  type FlowTokens,
  type LoadAgent,
} from "./agent-factory";

/**
 * One pre-provisioned (client, provider) pair plus its per-pair token
 * plumbing and a per-pair task-id counter.
 *
 * `nextTaskId` is initialised to `pairIdx * 10^9 + Date.now()` so that
 * even if two pool members happen to share a client (they don't in the
 * current design — each pair is unique), the task-id ranges don't
 * collide. The Date.now() seed also avoids collisions across multiple
 * harness restarts against a long-lived validator.
 */
export interface PoolMember {
  /** Index in the pool, 0..size-1. Useful for diagnostics. */
  pairIdx: number;
  client: LoadAgent;
  provider: LoadAgent;
  tokens: FlowTokens;
  /** Next task_id to use for the escrow PDA. Bumped on each acquire. */
  nextTaskId: bigint;
  /** True while a flow holds this pair. */
  busy: boolean;
}

export interface PoolConfig {
  size: number;
  /** Per-flow escrow amount (in token base units). */
  escrowAmount: bigint;
  /** Expected flows per pair across the campaign — drives initial mint. */
  expectedFlowsPerPair: number;
  /** Top-up trigger: when the client balance falls below this many flows worth. */
  topUpThresholdFlows: number;
  /** Each top-up mints this many flows worth of supply. */
  topUpFlows: number;
}

export interface ProvisionPoolArgs {
  connection: Connection;
  registryProgram: Program;
  vaultProgram: Program;
  airdropLamports: number;
  ed25519Signer: Ed25519Signer;
  config: PoolConfig;
  /** Per-member progress hook for the operator's console. */
  onMemberReady?: (m: PoolMember) => void;
}

/**
 * Provision the pool sequentially. Sequential rather than concurrent
 * because devnet airdrop is rate-limited per-IP, and even on localnet
 * the airdrop → confirmTransaction round-trip has its own latency
 * floor that doesn't benefit from fan-out at the small scales typical
 * of pool sizing (≤ 50 pairs).
 *
 * Pool provisioning latency is NOT included in the per-ix metric
 * buckets — the steady-state scenario reports throughput / latency
 * for the settlement hot path only, treating the pool as a
 * pre-existing population.
 */
export async function provisionAgentPool(
  args: ProvisionPoolArgs,
): Promise<AgentPool> {
  const { connection, registryProgram, vaultProgram, ed25519Signer, config } =
    args;
  const members: PoolMember[] = [];

  // Initial mint covers expectedFlowsPerPair × escrowAmount with a 2× safety
  // factor so a slightly-over-budgeted campaign doesn't immediately trigger
  // a top-up on the first flow.
  const initialClientBalance =
    config.escrowAmount *
    BigInt(Math.max(1, config.expectedFlowsPerPair)) *
    2n;

  for (let i = 0; i < config.size; i++) {
    const client = await provisionAgent({
      registryProgram,
      vaultProgram,
      connection,
      airdropLamports: args.airdropLamports,
      nameTag: `poolclient${i}`,
      acceptedToken: SystemProgram.programId,
      ed25519Signer,
    });
    const provider = await provisionAgent({
      registryProgram,
      vaultProgram,
      connection,
      airdropLamports: args.airdropLamports,
      nameTag: `poolprov${i}`,
      acceptedToken: SystemProgram.programId,
      ed25519Signer,
    });
    const tokens = await provisionFlowTokens({
      connection,
      client: client.authority,
      provider: provider.authority,
      initialClientBalance,
    });

    const member: PoolMember = {
      pairIdx: i,
      client,
      provider,
      tokens,
      // Monotonic per-pair counter; offset by pairIdx × 10^9 to keep
      // ranges non-overlapping with other pairs and by Date.now() ms to
      // avoid collisions if the harness is re-run against a long-lived
      // validator that retained PDAs from a prior run.
      nextTaskId:
        BigInt(i) * 1_000_000_000n + BigInt(Date.now()) % 1_000_000_000n,
      busy: false,
    };
    members.push(member);
    args.onMemberReady?.(member);
  }

  return new AgentPool(members, connection, config);
}

/**
 * The pool itself: round-robin checkout with per-pair single-writer
 * enforcement. Implemented as a small async-FIFO so workers that
 * arrive while all pairs are busy queue up rather than spin.
 *
 * The pool is intentionally NOT a generic resource pool — it knows
 * about the (client, provider, tokens, nextTaskId) shape of a load
 * agent pair so the scenario file stays small.
 */
export class AgentPool {
  private readonly waiters: Array<(m: PoolMember) => void> = [];

  constructor(
    private readonly members: PoolMember[],
    private readonly connection: Connection,
    private readonly config: PoolConfig,
  ) {}

  size(): number {
    return this.members.length;
  }

  /**
   * Wait for a free pair, mark it busy, bump its task-id, and return
   * the (member, taskId) tuple. Caller MUST call `release(member)`
   * when done with it (use try/finally).
   */
  async acquire(): Promise<{ member: PoolMember; taskId: bigint }> {
    const member = await this.acquireMember();
    // Bump the per-pair task-id BEFORE any await so two awaiting
    // callers can't observe the same nextTaskId. (acquire is itself
    // single-writer because we set busy=true under the same micro-task.)
    const taskId = member.nextTaskId;
    member.nextTaskId += 1n;

    // Just-in-time top-up: if the client balance has dropped below the
    // configured threshold, mint more before handing the pair out.
    // This is NOT counted as a settlement-phase ix; it's pool
    // maintenance and stays out of the per-ix buckets.
    await this.maybeTopUp(member);

    return { member, taskId };
  }

  release(member: PoolMember): void {
    member.busy = false;
    const next = this.waiters.shift();
    if (next) {
      member.busy = true;
      next(member);
    }
  }

  private async acquireMember(): Promise<PoolMember> {
    // Round-robin first-fit: find the first non-busy member, claim it.
    for (const m of this.members) {
      if (!m.busy) {
        m.busy = true;
        return m;
      }
    }
    // All busy — queue up.
    return new Promise<PoolMember>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private async maybeTopUp(member: PoolMember): Promise<void> {
    const threshold =
      this.config.escrowAmount * BigInt(this.config.topUpThresholdFlows);
    let balance: bigint;
    try {
      const acct = await getAccount(
        this.connection,
        member.tokens.clientTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID,
      );
      balance = acct.amount;
    } catch {
      // ATA not readable — skip the check; create_escrow will fail
      // visibly if it actually has no balance, and the scenario's
      // RPC-error bucket will surface it.
      return;
    }
    if (balance >= threshold) return;

    const topUpAmount =
      this.config.escrowAmount * BigInt(this.config.topUpFlows);
    try {
      await mintTo(
        this.connection,
        member.tokens.mintAuthority,
        member.tokens.tokenMint,
        member.tokens.clientTokenAccount,
        member.tokens.mintAuthority.publicKey,
        topUpAmount,
      );
    } catch (err) {
      // Don't throw; the next create_escrow will surface a clear error.
      // Top-up failure is operator-actionable (likely mint-authority SOL
      // exhaustion), but it shouldn't crash a multi-hour campaign.
      console.warn(
        `  [pool] pair ${member.pairIdx} top-up failed: ${(err as Error).message}`,
      );
    }
  }
}

/** Re-export for scenario code that wants the underlying types. */
export type { LoadAgent, FlowTokens };
export type { Keypair, PublicKey };

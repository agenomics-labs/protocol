// ADR-129 §"Resilience primitives" — production-grade subprocess transport
// for the EVO bridge. Closes MCP-300, MCP-301, MCP-302, MCP-305, MCP-307.
//
// The transport owns the EVO subprocess lifecycle. Above this layer, the
// `EvoClient` surface (`evo-bridge.ts`) only sees `send(command) → Promise`.
// All restart, breaker, queue-depth, timeout, and handshake decisions are
// hidden behind that surface.
//
// State machine
// =============
//   idle ─send─▶ starting ─handshake-ok─▶ running
//                                │
//                                ├─send-success─▶ running
//                                ├─send-failure (consecutive < threshold) ─▶ running
//                                ├─send-failure (consecutive >= threshold)─▶ restarting
//                                └─subprocess close ─▶ restarting | breaker_open
//
//   restarting ─cooldown elapsed─▶ starting (restartCount++)
//   restarting ─restartCount > maxRestarts─▶ breaker_open
//   breaker_open ─send─▶ reject immediately (terminal)
//
// Errors
// ======
//   - EvoBridgeTimeoutError      (MCP-300) — call exceeded callTimeoutMs
//   - EvoBridgeBackpressureError (MCP-302) — queue depth exceeded
//   - EvoBridgeBreakerOpenError  (MCP-301) — restarts exhausted
//   - EvoBridgeVersionMismatchError (MCP-305) — protocol major mismatch

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { EventEmitter } from "node:events";

import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "evo-bridge" });

// ---------------------------------------------------------------------------
// Errors — structurally typed so test mocks can satisfy with literals.
// ---------------------------------------------------------------------------

export class EvoBridgeTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, command: string) {
    super(`evo-bridge: call timed out after ${timeoutMs}ms (cmd=${command})`);
    this.name = "EvoBridgeTimeoutError";
  }
}

export class EvoBridgeBackpressureError extends Error {
  constructor(public readonly queueDepth: number, public readonly maxDepth: number) {
    super(
      `evo-bridge: queue depth ${queueDepth} exceeds max ${maxDepth}; rejecting to prevent self-DoS`,
    );
    this.name = "EvoBridgeBackpressureError";
  }
}

export class EvoBridgeBreakerOpenError extends Error {
  constructor(public readonly restartCount: number, public readonly maxRestarts: number) {
    super(
      `evo-bridge: circuit breaker open after ${restartCount}/${maxRestarts} restarts; ` +
        `treating as permanently degraded for this process lifetime`,
    );
    this.name = "EvoBridgeBreakerOpenError";
  }
}

export class EvoBridgeVersionMismatchError extends Error {
  constructor(
    public readonly expectedMajor: number,
    public readonly actual: string,
  ) {
    super(
      `evo-bridge: protocol version mismatch (expected major=${expectedMajor}, got "${actual}")`,
    );
    this.name = "EvoBridgeVersionMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ResiliencePolicy {
  /** MCP-300. Per-call timeout in ms. Default 5000. */
  callTimeoutMs: number;
  /** MCP-302. Maximum queued (pending + inflight) commands. Default 64. */
  maxQueueDepth: number;
  /** MCP-301. Consecutive call failures before tripping the breaker. Default 3. */
  failureThreshold: number;
  /** MCP-301. Restart cooldown floor in ms (exponential backoff up to 30s). Default 1000. */
  restartCooldownMs: number;
  /** MCP-301. Maximum lifetime restarts before the breaker locks open. Default 10. */
  maxRestarts: number;
  /** MCP-305. Required EVO protocol major version. Default 1. */
  protocolMajor: number;
  /**
   * CYCLE4-MCP-002 (Batch I). Reset `restartCount` to 0 when the
   * transport observes ≥ this many ms since the last successful response
   * before scheduling a new restart. Closes the durability gap where a
   * long-running MCP server with sparse transient EVO failures
   * (one-per-week) would eventually exhaust `maxRestarts` and brick.
   *
   * Default 1 hour — well above any realistic transient-failure cluster
   * (which is bounded by the `failureThreshold * restartCooldownMs`
   * exponential-backoff window). The "10 restarts in a tight window
   * trips permanent-brick" semantic is preserved; the long-tail-of-
   * sparse-failures recovery semantic is added.
   */
  restartCountResetAfterMs: number;
  /**
   * CYCLE4-MCP-002 hardening (audit follow-up). NEVER-RESET ceiling on
   * cumulative lifetime restarts. Closes the slow-flap blind spot the
   * windowed reset opened: an EVO bug that crashes once per
   * (`restartCountResetAfterMs` + ε) while serving healthy traffic
   * between would otherwise reset `restartCount` indefinitely and
   * never brick — inverting the cycle-3 invariant that
   * `maxRestarts` was "evidence the binary is structurally broken."
   *
   * This counter is incremented on every restart attempt and is NEVER
   * touched by the windowed reset. Once it exceeds the cap, the
   * breaker locks open permanently regardless of healthy-window state.
   *
   * Default 100 — at one transient/hour, that's ~4 days of flapping
   * before brick; healthy production should never approach it.
   */
  restartCountLifetimeCap: number;
}

export const DEFAULT_RESILIENCE_POLICY: ResiliencePolicy = Object.freeze({
  callTimeoutMs: 5_000,
  maxQueueDepth: 64,
  failureThreshold: 3,
  restartCooldownMs: 1_000,
  maxRestarts: 10,
  protocolMajor: 1,
  restartCountResetAfterMs: 60 * 60 * 1_000, // 1 hour
  restartCountLifetimeCap: 100,
});

const MAX_BACKOFF_MS = 30_000;
const MAX_STARTUP_ERROR_BYTES = 2_048;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type TransportState =
  | "idle"
  | "starting"
  | "running"
  | "restarting"
  | "breaker_open";

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  payload: string;
  cmd: string;
  /** Timestamp when this command was enqueued (queue-wait observability). */
  enqueuedAt: number;
  /** Cleared on settle. Used to drop late stdout responses after timeout. */
  timeoutTimer: NodeJS.Timeout | null;
  /** True once the command has resolved or rejected; further events ignored. */
  settled: boolean;
  /** MCP-305: when true, this command is the version handshake — failure trips
   *  the breaker permanently rather than triggering normal restart. */
  isHandshake?: boolean;
}

export interface SubprocessSpawnHook {
  (binaryPath: string, dbPath: string): ChildProcess;
}

/**
 * Test seam — replaces `readline.createInterface` so unit tests can fire
 * `line` events synchronously without waiting on stream backpressure.
 * Production callers leave this undefined and get the real readline.
 */
export interface LineSourceFactory {
  (proc: ChildProcess): EventEmitter;
}

export interface EvoSubprocessTransportOptions {
  binaryPath: string;
  dbPath: string;
  policy?: Partial<ResiliencePolicy>;
  /** Test seam — replaces the `child_process.spawn` call. */
  spawnFn?: SubprocessSpawnHook;
  /** Test seam — replaces readline so tests can emit `line` synchronously. */
  lineSourceFactory?: LineSourceFactory;
  /** Test seam — replaces `setTimeout` for deterministic time control. */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => NodeJS.Timeout;
    clearTimeout: (t: NodeJS.Timeout) => void;
    now: () => number;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EvoSubprocessTransport {
  private state: TransportState = "idle";
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private inflight: PendingCommand | null = null;
  private readonly queue: PendingCommand[] = [];
  /** Set on every successful response; reset on failure. */
  private consecutiveFailures = 0;
  /** Lifetime restart counter; once this exceeds maxRestarts the breaker locks.
   *  CYCLE4-MCP-002 (Batch I): reset to 0 by `scheduleRestart` when the time
   *  since the last successful response exceeds `policy.restartCountResetAfterMs`,
   *  so a long-running process with sparse transient failures recovers gracefully
   *  instead of accumulating restarts indefinitely. */
  private restartCount = 0;
  /** CYCLE4-MCP-002 hardening (audit follow-up): NEVER-RESET cumulative
   *  restart counter. Bricks the breaker once it exceeds
   *  `policy.restartCountLifetimeCap`, regardless of healthy-window state.
   *  Closes the slow-flap blind spot. */
  private lifetimeRestartCount = 0;
  /** CYCLE4-MCP-002 (Batch I): timestamp of the last successful response.
   *  Null until the first success. Used to decide whether a fresh restart
   *  cluster should reset `restartCount` (long-tail recovery) vs continue
   *  accumulating (tight-window failure pattern). Cleared back to null
   *  immediately after a reset fires (audit follow-up) so the next reset
   *  requires a fresh sustained-healthy window — prevents repeated
   *  resets during a single failure cluster from a stale timestamp. */
  private lastSuccessAt: number | null = null;
  /** MCP-307: accumulate ALL unsolicited startup-time error lines so multi-line
   *  banners aren't silently overwritten. */
  private startupErrorLines: string[] = [];
  /** Cached major protocol version once the handshake completes. Useful for
   *  observability via `getProtocolVersion()`. */
  private negotiatedProtocolVersion: string | null = null;
  /** Pending restart-cooldown timer (cleared on close()). */
  private restartTimer: NodeJS.Timeout | null = null;

  private readonly policy: ResiliencePolicy;
  private readonly spawnFn: SubprocessSpawnHook;
  private readonly lineSourceFactory: LineSourceFactory;
  private readonly scheduler: NonNullable<EvoSubprocessTransportOptions["scheduler"]>;

  constructor(private readonly options: EvoSubprocessTransportOptions) {
    this.policy = { ...DEFAULT_RESILIENCE_POLICY, ...(options.policy ?? {}) };
    this.spawnFn =
      options.spawnFn ??
      ((binaryPath, dbPath) =>
        spawn(binaryPath, ["--json", "--db", dbPath], {
          stdio: ["pipe", "pipe", "pipe"],
        }));
    this.lineSourceFactory =
      options.lineSourceFactory ??
      ((proc: ChildProcess) => {
        if (!proc.stdout) {
          throw new Error("evo-bridge: spawn returned no stdout pipe");
        }
        return createInterface({ input: proc.stdout });
      });
    this.scheduler = options.scheduler ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (t) => clearTimeout(t),
      now: () => Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  send(command: Record<string, unknown>): Promise<unknown> {
    return this.enqueue(command, /* isHandshake */ false);
  }

  /**
   * Negotiated EVO protocol version (e.g. "1.0", "1.4"). Null until the
   * handshake completes. Visible for observability + tests.
   */
  getProtocolVersion(): string | null {
    return this.negotiatedProtocolVersion;
  }

  /** Visible for tests + observability — the current state. */
  getState(): TransportState {
    return this.state;
  }

  async close(): Promise<void> {
    if (this.restartTimer) {
      this.scheduler.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.state = "breaker_open"; // terminal — close is one-way
    await this.killProcess();
  }

  // -------------------------------------------------------------------------
  // Enqueue + dispatch
  // -------------------------------------------------------------------------

  private enqueue(
    command: Record<string, unknown>,
    isHandshake: boolean,
  ): Promise<unknown> {
    if (this.state === "breaker_open") {
      return Promise.reject(
        new EvoBridgeBreakerOpenError(this.restartCount, this.policy.maxRestarts),
      );
    }

    // MCP-302: bound the queue. Inflight slot counts toward depth so a
    // wedged handler doesn't allow unbounded peers to pile up.
    const totalDepth = this.queue.length + (this.inflight ? 1 : 0);
    if (!isHandshake && totalDepth >= this.policy.maxQueueDepth) {
      return Promise.reject(
        new EvoBridgeBackpressureError(totalDepth, this.policy.maxQueueDepth),
      );
    }

    const cmdName =
      typeof command.cmd === "string" ? command.cmd : "<unknown>";
    const payload = JSON.stringify(command) + "\n";

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingCommand = {
        resolve,
        reject,
        payload,
        cmd: cmdName,
        enqueuedAt: this.scheduler.now(),
        timeoutTimer: null,
        settled: false,
        isHandshake,
      };
      // Handshake cuts the line — it must run before user sends so the version
      // assertion either succeeds or fails the entire transport before any
      // user-visible call returns.
      if (isHandshake) {
        this.queue.unshift(pending);
      } else {
        this.queue.push(pending);
      }
      this.ensureRunning();
      this.pump();
    });
  }

  private ensureRunning(): void {
    if (this.state === "idle") {
      this.spawnAndHandshake();
    }
  }

  private spawnAndHandshake(): void {
    this.state = "starting";
    log.info(
      {
        binary: this.options.binaryPath,
        db: this.options.dbPath,
        restart_count: this.restartCount,
      },
      "evo-bridge: spawning EVO subprocess",
    );

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(this.options.binaryPath, this.options.dbPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.handleSpawnFailure(`spawn threw: ${msg}`);
      return;
    }

    this.process = proc;
    this.startupErrorLines = [];
    let lineSource: EventEmitter;
    try {
      lineSource = this.lineSourceFactory(proc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.handleSpawnFailure(msg);
      return;
    }
    this.readline = lineSource as ReadlineInterface;
    lineSource.on("line", (line: string) => this.onLine(line));

    proc.on("error", (err: Error) => {
      this.handleSubprocessFailure(`subprocess error: ${err.message}`);
    });
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const reason = this.startupErrorLines.length > 0
        ? `subprocess exited at startup: ${this.renderStartupError()}`
        : `subprocess exited (code=${code}, signal=${signal})`;
      this.handleSubprocessFailure(reason);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      log.debug(
        { stderr: chunk.toString("utf8").trim() },
        "evo-bridge: subprocess stderr",
      );
    });

    // MCP-305: enqueue the version handshake at the head of the queue. This
    // command must succeed before any user command sees a response.
    this.state = "running";
    void this.enqueue({ cmd: "version" }, /* isHandshake */ true)
      .then((response) => this.onHandshakeOk(response))
      .catch((err: unknown) => this.onHandshakeFail(err));
  }

  private onHandshakeOk(response: unknown): void {
    // Tolerant parse: accept { ok: true, version: "1.x" } OR
    // { ok: true, protocol_version: "1.x" } OR { ok: true, result: {...} }.
    // Legacy EVO binaries that do not implement `version` return
    // { ok: false, error: "unknown command" }; we treat that as protocol v1
    // implicit (today's binary speaks v1) and log a warning.
    let detected: string | null = null;
    if (response && typeof response === "object") {
      const r = response as Record<string, unknown>;
      const candidate =
        (typeof r.protocol_version === "string" && r.protocol_version) ||
        (typeof r.version === "string" && r.version) ||
        (r.result &&
          typeof r.result === "object" &&
          typeof (r.result as Record<string, unknown>).protocol_version === "string"
          ? ((r.result as Record<string, unknown>).protocol_version as string)
          : null);
      if (typeof candidate === "string") detected = candidate;
    }
    if (detected === null) {
      log.warn(
        {
          adr: "ADR-129",
          audit: "MCP-305",
          response: typeof response === "object" ? response : String(response),
        },
        "evo-bridge: version handshake response had no protocol_version; assuming v1 (legacy binary)",
      );
      this.negotiatedProtocolVersion = `${this.policy.protocolMajor}.legacy`;
      return;
    }
    const major = Number.parseInt(detected.split(".")[0] ?? "", 10);
    if (!Number.isFinite(major) || major !== this.policy.protocolMajor) {
      this.tripBreakerPermanently(
        new EvoBridgeVersionMismatchError(this.policy.protocolMajor, detected),
      );
      return;
    }
    this.negotiatedProtocolVersion = detected;
    log.info(
      { adr: "ADR-129", audit: "MCP-305", protocol_version: detected },
      "evo-bridge: version handshake ok",
    );
  }

  private onHandshakeFail(err: unknown): void {
    // EVO binaries predating the version cmd reject with `{ ok: false }`.
    // We surface that as a known shape (`error` field is "unknown command")
    // and treat it like the legacy path. Any other error trips the breaker.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unknown command") || msg.includes("unknown cmd")) {
      log.warn(
        { adr: "ADR-129", audit: "MCP-305" },
        "evo-bridge: version cmd rejected (legacy EVO binary); assuming v1",
      );
      this.negotiatedProtocolVersion = `${this.policy.protocolMajor}.legacy`;
      return;
    }
    if (err instanceof EvoBridgeVersionMismatchError) {
      this.tripBreakerPermanently(err);
      return;
    }
    log.warn(
      { err: msg, adr: "ADR-129", audit: "MCP-305" },
      "evo-bridge: version handshake failed; transport will use normal restart",
    );
  }

  private pump(): void {
    if (this.inflight !== null) return;
    if (this.state !== "running") return;
    const next = this.queue.shift();
    if (!next) return;

    if (!this.process?.stdin?.writable) {
      this.failPending(next, new Error("evo-bridge: subprocess stdin is not writable"));
      this.pump();
      return;
    }

    this.inflight = next;

    // MCP-300: arm per-call timeout. On fire, settle the inflight as a
    // timeout rejection but DO NOT kill the subprocess yet — the breaker
    // owns kill decisions. We do free the inflight slot so the next pump
    // can dispatch.
    next.timeoutTimer = this.scheduler.setTimeout(() => {
      if (next.settled) return;
      this.failPending(next, new EvoBridgeTimeoutError(this.policy.callTimeoutMs, next.cmd));
      this.recordFailure(`timeout cmd=${next.cmd}`);
      // Pump again — but only if state allows. recordFailure may have moved
      // us to restarting.
      if (this.state === "running") this.pump();
    }, this.policy.callTimeoutMs);

    this.process.stdin.write(next.payload, (err) => {
      if (err && !next.settled && this.inflight === next) {
        this.failPending(next, new Error(`evo-bridge: stdin write failed: ${err.message}`));
        this.recordFailure(`stdin-write cmd=${next.cmd}`);
        if (this.state === "running") this.pump();
      }
    });
  }

  private onLine(line: string): void {
    const current = this.inflight;
    if (!current) {
      // MCP-307: append, don't overwrite. Bound the buffer to keep memory
      // sane on a misbehaving binary.
      const extracted = this.extractErrorMessage(line);
      const totalSize =
        this.startupErrorLines.reduce((n, s) => n + s.length + 1, 0) + extracted.length;
      if (totalSize <= MAX_STARTUP_ERROR_BYTES) {
        this.startupErrorLines.push(extracted);
      }
      log.warn({ line }, "evo-bridge: unmatched response line");
      return;
    }
    if (current.settled) {
      // Late response after a timeout already settled the caller; drop.
      log.debug(
        { cmd: current.cmd, line_len: line.length },
        "evo-bridge: dropping stdout line for already-settled command",
      );
      return;
    }
    this.inflight = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failPending(current, new Error(`evo-bridge: failed to parse response: ${msg}`));
      this.recordFailure(`parse cmd=${current.cmd}`);
      if (this.state === "running") this.pump();
      return;
    }
    this.settle(current, parsed);
    this.consecutiveFailures = 0;
    // CYCLE4-MCP-002 (Batch I): record the success timestamp for the
    // sustained-healthy reset check in `scheduleRestart`. Skip handshake
    // commands — the handshake fires on every (re-)spawn and would
    // continuously refresh lastSuccessAt during a tight-window failure
    // cluster, defeating the reset semantic. Only USER commands count
    // as evidence of sustained healthy operation.
    if (!current.isHandshake) {
      this.lastSuccessAt = this.scheduler.now();
    }
    if (this.state === "running") this.pump();
  }

  private settle(pending: PendingCommand, value: unknown): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeoutTimer) {
      this.scheduler.clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = null;
    }
    pending.resolve(value);
  }

  private failPending(pending: PendingCommand, err: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeoutTimer) {
      this.scheduler.clearTimeout(pending.timeoutTimer);
      pending.timeoutTimer = null;
    }
    if (this.inflight === pending) this.inflight = null;
    pending.reject(err);
  }

  // -------------------------------------------------------------------------
  // Failure handling — MCP-301 breaker + restart logic
  // -------------------------------------------------------------------------

  private recordFailure(context: string): void {
    this.consecutiveFailures += 1;
    log.warn(
      {
        consecutive_failures: this.consecutiveFailures,
        threshold: this.policy.failureThreshold,
        context,
      },
      "evo-bridge: call failure recorded",
    );
    if (this.consecutiveFailures >= this.policy.failureThreshold) {
      log.warn(
        { audit: "MCP-301", restart_count: this.restartCount },
        "evo-bridge: failure threshold reached, scheduling restart",
      );
      this.scheduleRestart("failure-threshold");
    }
  }

  private handleSpawnFailure(reason: string): void {
    log.error({ reason, audit: "MCP-301" }, "evo-bridge: spawn failed");
    this.scheduleRestart(`spawn: ${reason}`);
  }

  private handleSubprocessFailure(reason: string): void {
    if (this.state === "breaker_open") {
      // Already terminal; flush any leftover pending so callers don't hang.
      this.failAll(new EvoBridgeBreakerOpenError(this.restartCount, this.policy.maxRestarts));
      return;
    }
    log.warn({ reason, audit: "MCP-301" }, "evo-bridge: subprocess failure");
    // Surface to the inflight caller — the subprocess died mid-call.
    if (this.inflight && !this.inflight.settled) {
      this.failPending(this.inflight, new Error(`evo-bridge: ${reason}`));
    }
    this.scheduleRestart(reason);
  }

  private async killProcess(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.readline = null;
    if (!proc) return;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = this.scheduler.setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      proc.once("close", () => {
        this.scheduler.clearTimeout(timer);
        resolve();
      });
    });
  }

  private scheduleRestart(reason: string): void {
    if (this.state === "breaker_open" || this.state === "restarting") return;

    // CYCLE4-MCP-002 hardening (audit follow-up): bump the never-reset
    // lifetime counter FIRST and check it against the lifetime cap. This
    // closes the slow-flap blind spot that the windowed `restartCount`
    // reset opened — a process flapping at slightly-above-the-reset-
    // window cadence would otherwise reset its windowed count
    // indefinitely and never brick. The lifetime counter is never
    // touched by the windowed reset below.
    this.lifetimeRestartCount += 1;
    if (this.lifetimeRestartCount > this.policy.restartCountLifetimeCap) {
      log.error(
        {
          lifetime_restart_count: this.lifetimeRestartCount,
          lifetime_cap: this.policy.restartCountLifetimeCap,
          audit: "CYCLE4-MCP-002",
        },
        "evo-bridge: lifetime restart cap exceeded; locking breaker open " +
          "(slow-flap brick — see ResiliencePolicy.restartCountLifetimeCap)",
      );
      this.tripBreakerPermanently(
        new EvoBridgeBreakerOpenError(
          this.lifetimeRestartCount,
          this.policy.restartCountLifetimeCap,
        ),
      );
      return;
    }

    // CYCLE4-MCP-002 (Batch I): reset `restartCount` BEFORE incrementing
    // when the transport observed a sustained-healthy window since the
    // last failure cluster. Preserves the "10 restarts in a tight window
    // = brick" semantic while letting "10 restarts spread over a year"
    // recover gracefully. Threshold defaults to 1 hour
    // (`restartCountResetAfterMs`); operators can tune via the policy.
    if (
      this.lastSuccessAt !== null &&
      this.restartCount > 0 &&
      this.scheduler.now() - this.lastSuccessAt >=
        this.policy.restartCountResetAfterMs
    ) {
      log.info(
        {
          previous_restart_count: this.restartCount,
          ms_since_last_success: this.scheduler.now() - this.lastSuccessAt,
          threshold_ms: this.policy.restartCountResetAfterMs,
          lifetime_restart_count: this.lifetimeRestartCount,
          audit: "CYCLE4-MCP-002",
        },
        "evo-bridge: sustained-healthy window observed, resetting restartCount before incrementing",
      );
      this.restartCount = 0;
      // Audit follow-up: clear lastSuccessAt so the NEXT reset requires
      // a fresh sustained-healthy window. Without this, a stale
      // lastSuccessAt could repeatedly fire the reset within a single
      // long-running failure cluster (each scheduleRestart call would
      // see the same old timestamp and re-zero restartCount), defeating
      // the windowed-cap intent.
      this.lastSuccessAt = null;
    }
    this.restartCount += 1;
    if (this.restartCount > this.policy.maxRestarts) {
      this.tripBreakerPermanently(
        new EvoBridgeBreakerOpenError(this.restartCount, this.policy.maxRestarts),
      );
      return;
    }
    this.state = "restarting";
    void this.killProcess();
    const cooldownMs = Math.min(
      this.policy.restartCooldownMs * Math.pow(2, this.restartCount - 1),
      MAX_BACKOFF_MS,
    );
    log.info(
      {
        cooldown_ms: cooldownMs,
        restart_count: this.restartCount,
        max_restarts: this.policy.maxRestarts,
        reason,
        audit: "MCP-301",
      },
      "evo-bridge: scheduling restart after cooldown",
    );
    this.restartTimer = this.scheduler.setTimeout(() => {
      this.restartTimer = null;
      if (this.state !== "restarting") return;
      this.consecutiveFailures = 0;
      this.state = "idle";
      // If commands are queued, kick off the next spawn. Otherwise stay idle
      // until the next send().
      if (this.queue.length > 0) this.spawnAndHandshake();
    }, cooldownMs);
  }

  private tripBreakerPermanently(err: Error): void {
    log.error(
      {
        err: err.message,
        restart_count: this.restartCount,
        max_restarts: this.policy.maxRestarts,
        audit: "MCP-301",
      },
      "evo-bridge: circuit breaker locked open; transport permanently degraded",
    );
    this.state = "breaker_open";
    if (this.restartTimer) {
      this.scheduler.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    void this.killProcess();
    this.failAll(err);
  }

  private failAll(err: Error): void {
    if (this.inflight && !this.inflight.settled) {
      this.failPending(this.inflight, err);
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (!next.settled) this.failPending(next, err);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private renderStartupError(): string {
    return this.startupErrorLines.join(" | ");
  }

  private extractErrorMessage(line: string): string {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error: unknown }).error === "string"
      ) {
        return (parsed as { error: string }).error;
      }
    } catch {
      /* not JSON — fall through */
    }
    return line;
  }
}

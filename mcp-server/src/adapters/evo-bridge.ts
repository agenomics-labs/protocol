// ADR-129 Phase 1 — subprocess lifecycle wrapper around the EVO MCP bridge.
//
// We do NOT import `EVO/dist/mcp/bridge.js` directly. EVO ships a release
// binary (`evo --json --db <path>`) that speaks line-delimited JSON over
// stdio (the same protocol EVO's own bridge wraps). Spawning that binary
// keeps our adapter narrow, avoids a cross-package source dependency on
// EVO's TS, and matches the integration option ADR-129 §"Why out-of-process
// MCP" picked (Option A).
//
// Posture (ADR-129 Phase 1):
//   - Kill-switch via `AEP_EVO_ENABLED`. Default OFF. When false/unset the
//     module exports a no-op `EvoClient` (observe → void, retrieve →
//     `{ ok: true, results: [] }`). Failure mode is bounded.
//   - Lazy spawn on first use. The bridge is created at module load (so
//     misconfig surfaces immediately) but the subprocess is not spawned
//     until the first observe/retrieve/learn/consolidate call.
//   - Best-effort write-path. Callers wrap `observe()` in their own
//     try/catch; this module does not throw on bridge-side errors.
//   - Kill on signal (`beforeExit`, `SIGINT`, `SIGTERM`) so the child
//     subprocess does not outlive the MCP server.
//
// Public surface is intentionally narrow — only the four EVO operations
// Phase 1 / Phase 2 need plus a `health` stub so the adapter can be wired
// into a future operator probe without another bridge round-trip.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "evo-bridge" });

// ---------------------------------------------------------------------------
// Public types — narrow domain shapes, no EVO-specific leakage above this
// adapter.
// ---------------------------------------------------------------------------

/**
 * Domain-shaped observation payload sent into EVO's L1 memory. The adapter
 * translates this into an `evo_observe`-compatible JSON command. Callers
 * hand us text + a free-form string-keyed metadata bag; we do not interpret
 * either.
 */
export interface EvoObservation {
  content: string;
  metadata?: Record<string, string>;
}

/**
 * Domain-shaped retrieval query. `tokenBudget` and `minSimilarity` are
 * forwarded straight through; the adapter fills defaults from the
 * `AEP_EVO_DEFAULT_*` env vars when the caller omits them.
 */
export interface EvoRetrievalQuery {
  query: string;
  topK?: number;
  minSimilarity?: number;
  tokenBudget?: number;
}

/**
 * One retrieved memory. Mirrors what EVO's `evo_retrieve` returns per
 * result — `id` is opaque, `score` is cosine similarity in [0, 1],
 * `content` is the original observation text, `metadata` carries whatever
 * the observer attached.
 */
export interface EvoRetrievalHit {
  id: string;
  score: number;
  content: string;
  metadata?: Record<string, string>;
}

export interface EvoRetrievalResult {
  hits: EvoRetrievalHit[];
}

/**
 * Outcome score for the `learn` credit-assignment loop. Stub today
 * (Phase 2 deliverable per ADR-129); declared here so the EvoClient
 * surface is stable across phases.
 */
export interface EvoLearnOutcome {
  taskId: string;
  score: number;
  success: boolean;
}

/**
 * The narrow public surface every consumer above this adapter sees. Every
 * method is best-effort — the no-op implementation returned when the
 * kill-switch is OFF satisfies this same surface, so callers never branch
 * on "is EVO available."
 */
export interface EvoClient {
  /** True when the bridge will actually talk to EVO; false on the no-op. */
  readonly enabled: boolean;
  observe(observation: EvoObservation): Promise<void>;
  retrieve(query: EvoRetrievalQuery): Promise<EvoRetrievalResult>;
  learn(outcome: EvoLearnOutcome): Promise<void>;
  consolidate(): Promise<void>;
  /** Tear down the bridge subprocess. Idempotent; safe in signal handlers. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config — env-var resolution. Module-load fail-fast for misconfig per the
// ADR-027 / AUD-027 precedent: `AEP_EVO_ENABLED=true` with a missing binary
// is operator error and should surface at boot, not silently degrade.
// ---------------------------------------------------------------------------

export interface EvoBridgeConfig {
  enabled: boolean;
  binaryPath: string;
  dbPath: string;
  defaultTopK: number;
  defaultTokenBudget: number;
  defaultMinSimilarity: number;
}

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off" || v === "") {
    return false;
  }
  // Unknown value → treat as disabled (cautious default per ADR-129 §
  // "Migration"). Log so operators notice.
  log.warn(
    { env: name, value: raw },
    "evo-bridge: unrecognized boolean env value; treating as false",
  );
  return false;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    log.warn(
      { env: name, value: raw, fallback },
      "evo-bridge: invalid int env value; using fallback",
    );
    return fallback;
  }
  return n;
}

function envFloat01(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    log.warn(
      { env: name, value: raw, fallback },
      "evo-bridge: invalid float-in-[0,1] env value; using fallback",
    );
    return fallback;
  }
  return n;
}

/**
 * Resolve the EVO bridge configuration from the supplied env (defaults to
 * `process.env`). Pure — does not touch the filesystem; existence checks
 * happen in `createEvoClient` so operators get one consolidated diagnostic
 * at boot.
 */
export function resolveEvoBridgeConfig(env: NodeJS.ProcessEnv = process.env): EvoBridgeConfig {
  return {
    enabled: envFlag(env, "AEP_EVO_ENABLED", false),
    binaryPath: env.AEP_EVO_BINARY?.trim() || "evo",
    dbPath: env.AEP_EVO_DB?.trim() || ".aep-evo/agent-memory.db",
    defaultTopK: envInt(env, "AEP_EVO_DEFAULT_TOPK", 10),
    defaultTokenBudget: envInt(env, "AEP_EVO_DEFAULT_TOKEN_BUDGET", 4096),
    defaultMinSimilarity: envFloat01(env, "AEP_EVO_DEFAULT_MIN_SIMILARITY", 0.3),
  };
}

// ---------------------------------------------------------------------------
// Errors. Kept structural so test mocks can satisfy them with a literal.
// ---------------------------------------------------------------------------

/**
 * Thrown by `createEvoClient` when `AEP_EVO_ENABLED=true` but the runtime
 * environment cannot support a live bridge. Module-load fail-fast.
 */
export class EvoBridgeMisconfigError extends Error {
  constructor(
    public readonly check: string,
    message: string,
  ) {
    super(message);
    this.name = "EvoBridgeMisconfigError";
  }
}

// ---------------------------------------------------------------------------
// Internal: low-level subprocess transport. Single in-flight request at a
// time — sufficient for Phase 1 since `evo --json` writes one response per
// command in order. We serialize the queue ourselves so two concurrent
// `observe`/`retrieve` callers don't interleave their JSONL frames.
// ---------------------------------------------------------------------------

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  payload: string;
}

class EvoSubprocessTransport {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private inflight: PendingCommand | null = null;
  private readonly queue: PendingCommand[] = [];
  private closed = false;
  /**
   * Captures a startup-time JSON error line emitted by `cmd_json_mode`
   * before we sent any command (e.g. the binary refusing the DB path
   * outright). Without this, the line gets dropped because `inflight` is
   * empty, and operators see "process exited" with no context.
   */
  private startupError: string | null = null;

  constructor(
    private readonly binaryPath: string,
    private readonly dbPath: string,
  ) {}

  private start(): void {
    log.info(
      { binary: this.binaryPath, db: this.dbPath },
      "evo-bridge: spawning EVO subprocess",
    );
    this.process = spawn(this.binaryPath, ["--json", "--db", this.dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.process.stdout) {
      throw new Error("evo-bridge: spawn returned no stdout pipe");
    }

    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line: string) => this.onLine(line));

    this.process.on("error", (err: Error) => {
      this.failAll(new Error(`evo-bridge: subprocess error: ${err.message}`));
    });

    this.process.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true;
      const reason = this.startupError
        ? `evo-bridge: subprocess exited at startup: ${this.startupError}`
        : `evo-bridge: subprocess exited unexpectedly (code ${code}, signal ${signal})`;
      this.failAll(new Error(reason));
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      // EVO writes startup banners + diagnostics to stderr. Surface them
      // at debug so operators can opt in via LOG_LEVEL=debug without us
      // spamming info-level logs on every spawn.
      log.debug({ stderr: chunk.toString("utf8").trim() }, "evo-bridge: subprocess stderr");
    });
  }

  private onLine(line: string): void {
    const current = this.inflight;
    if (!current) {
      // Unsolicited line — almost always a startup-time write_json_error.
      this.startupError = this.extractErrorMessage(line);
      log.warn({ line }, "evo-bridge: unmatched response line");
      return;
    }
    this.inflight = null;
    try {
      const parsed: unknown = JSON.parse(line);
      current.resolve(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      current.reject(new Error(`evo-bridge: failed to parse response: ${msg}`));
    }
    this.pump();
  }

  private failAll(error: Error): void {
    if (this.inflight) {
      this.inflight.reject(error);
      this.inflight = null;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.reject(error);
    }
  }

  private pump(): void {
    if (this.inflight !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.process?.stdin?.writable) {
      next.reject(new Error("evo-bridge: subprocess stdin is not writable"));
      this.pump();
      return;
    }
    this.inflight = next;
    this.process.stdin.write(next.payload, (err) => {
      if (err && this.inflight === next) {
        this.inflight = null;
        next.reject(new Error(`evo-bridge: stdin write failed: ${err.message}`));
        this.pump();
      }
    });
  }

  send(command: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new Error(
          this.startupError
            ? `evo-bridge: subprocess exited at startup: ${this.startupError}`
            : "evo-bridge: subprocess is not running",
        ),
      );
    }
    if (!this.process) {
      try {
        this.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Promise.reject(new Error(`evo-bridge: failed to start subprocess: ${msg}`));
      }
    }
    const payload = JSON.stringify(command) + "\n";
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ resolve, reject, payload });
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (!this.process) {
      this.closed = true;
      return;
    }
    this.closed = true;
    const proc = this.process;
    proc.stdin?.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 5000);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = null;
    this.readline = null;
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
      // not JSON — fall through
    }
    return line;
  }
}

// ---------------------------------------------------------------------------
// Live client. Wraps the subprocess transport in the narrow `EvoClient`
// surface, translates domain shapes into EVO's `cmd: 'observe_text'` etc.,
// and parses responses back into our `EvoRetrievalResult` shape.
// ---------------------------------------------------------------------------

class LiveEvoClient implements EvoClient {
  readonly enabled = true;

  constructor(
    private readonly transport: EvoSubprocessTransport,
    private readonly defaults: Pick<
      EvoBridgeConfig,
      "defaultTopK" | "defaultTokenBudget" | "defaultMinSimilarity"
    >,
  ) {}

  async observe(observation: EvoObservation): Promise<void> {
    const command: Record<string, unknown> = {
      cmd: "observe_text",
      content: observation.content,
    };
    if (observation.metadata && Object.keys(observation.metadata).length > 0) {
      command.metadata = observation.metadata;
    }
    const response = (await this.transport.send(command)) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        `evo-bridge: observe rejected: ${response.error ?? "unknown error"}`,
      );
    }
  }

  async retrieve(query: EvoRetrievalQuery): Promise<EvoRetrievalResult> {
    const command: Record<string, unknown> = {
      cmd: "retrieve_text",
      text: query.query,
      top_k: query.topK ?? this.defaults.defaultTopK,
      min_similarity: query.minSimilarity ?? this.defaults.defaultMinSimilarity,
      token_budget: query.tokenBudget ?? this.defaults.defaultTokenBudget,
    };
    const response = (await this.transport.send(command)) as {
      ok?: boolean;
      error?: string;
      result?: unknown;
    };
    if (!response.ok) {
      throw new Error(
        `evo-bridge: retrieve rejected: ${response.error ?? "unknown error"}`,
      );
    }
    return parseRetrievalResult(response.result);
  }

  async learn(outcome: EvoLearnOutcome): Promise<void> {
    const command = {
      cmd: "learn",
      task_id: outcome.taskId,
      score: outcome.score,
      success: outcome.success,
    };
    const response = (await this.transport.send(command)) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        `evo-bridge: learn rejected: ${response.error ?? "unknown error"}`,
      );
    }
  }

  async consolidate(): Promise<void> {
    const response = (await this.transport.send({ cmd: "consolidate" })) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        `evo-bridge: consolidate rejected: ${response.error ?? "unknown error"}`,
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * Tolerant parser for EVO's retrieval result shape. EVO returns
 * `{ ok: true, result: { results: [...], ... } }`; the result entries
 * carry various fields, but Phase 1 only consumes id/score/content/metadata.
 * Unknown fields are dropped, malformed entries are skipped (best-effort).
 */
function parseRetrievalResult(result: unknown): EvoRetrievalResult {
  if (!result || typeof result !== "object") {
    return { hits: [] };
  }
  const r = result as Record<string, unknown>;
  const rawHits =
    Array.isArray(r.results)
      ? r.results
      : Array.isArray(r.hits)
        ? r.hits
        : Array.isArray(r)
          ? r
          : [];
  const hits: EvoRetrievalHit[] = [];
  for (const raw of rawHits) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : String(entry.id ?? "");
    const score =
      typeof entry.score === "number"
        ? entry.score
        : typeof entry.similarity === "number"
          ? entry.similarity
          : 0;
    const content =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.text === "string"
          ? entry.text
          : "";
    const metadata =
      entry.metadata && typeof entry.metadata === "object"
        ? (entry.metadata as Record<string, string>)
        : undefined;
    if (!id) continue;
    hits.push({ id, score, content, metadata });
  }
  return { hits };
}

// ---------------------------------------------------------------------------
// No-op client. Returned when the kill-switch is OFF. Same surface; observe
// is a void-promise; retrieve resolves to an empty hit list. This is the
// "bounded failure mode" ADR-129 mandates.
// ---------------------------------------------------------------------------

class DisabledEvoClient implements EvoClient {
  readonly enabled = false;
  async observe(_observation: EvoObservation): Promise<void> {
    return;
  }
  async retrieve(_query: EvoRetrievalQuery): Promise<EvoRetrievalResult> {
    return { hits: [] };
  }
  async learn(_outcome: EvoLearnOutcome): Promise<void> {
    return;
  }
  async consolidate(): Promise<void> {
    return;
  }
  async shutdown(): Promise<void> {
    return;
  }
}

// ---------------------------------------------------------------------------
// Factory. Module-load entrypoint. Misconfig fails here so operators see
// the real cause at boot rather than the first observe-call no-op.
// ---------------------------------------------------------------------------

export interface CreateEvoClientOptions {
  /** Override `process.env` for tests. Production callers leave undefined. */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether to register `beforeExit` / `SIGINT` / `SIGTERM` handlers that
   * shut the bridge down. Default true. Tests that construct several
   * clients in-process should pass false to avoid leaking listeners.
   */
  installSignalHandlers?: boolean;
}

export function createEvoClient(options: CreateEvoClientOptions = {}): EvoClient {
  const env = options.env ?? process.env;
  const config = resolveEvoBridgeConfig(env);

  if (!config.enabled) {
    log.info(
      { adr: "ADR-129" },
      "evo-bridge: AEP_EVO_ENABLED is false (default); EVO integration disabled",
    );
    return new DisabledEvoClient();
  }

  // Misconfig fail-fast (mirrors AUD-027 JWT_SECRET pattern). The binary
  // path may be a bare filename ("evo") that the OS PATH will resolve at
  // spawn time — only validate filesystem existence when the operator gave
  // us an absolute path, otherwise we'd reject every PATH-resolved binary.
  if (isAbsolute(config.binaryPath) && !existsSync(config.binaryPath)) {
    throw new EvoBridgeMisconfigError(
      "binary-exists",
      `AEP_EVO_ENABLED=true but AEP_EVO_BINARY=${config.binaryPath} does not exist. ` +
        `Build the EVO release binary or point AEP_EVO_BINARY at one.`,
    );
  }

  // ADR-129 §"New env vars" makes AEP_EVO_MODEL_DIR a hard requirement when
  // EVO is enabled — without it the engine silently degrades to BLAKE3
  // pseudo-embeddings (semantically meaningless). We do not load the model
  // ourselves; we just fail loudly so operators don't ship a degraded EVO.
  const modelDir = env.AEP_EVO_MODEL_DIR?.trim();
  if (!modelDir) {
    throw new EvoBridgeMisconfigError(
      "model-dir",
      "AEP_EVO_ENABLED=true requires AEP_EVO_MODEL_DIR to be set so the " +
        "ONNX all-MiniLM-L6-v2 embedder can load. Without it EVO falls " +
        "back to BLAKE3 pseudo-embeddings (semantically meaningless). " +
        "See docs/adr/ADR-129-evo-agent-memory-integration.md §'New env vars'.",
    );
  }
  if (isAbsolute(modelDir) && !existsSync(modelDir)) {
    throw new EvoBridgeMisconfigError(
      "model-dir-exists",
      `AEP_EVO_MODEL_DIR=${modelDir} does not exist. Run EVO's ` +
        `scripts/download_minilm.sh to materialize it.`,
    );
  }

  const transport = new EvoSubprocessTransport(config.binaryPath, config.dbPath);
  const client = new LiveEvoClient(transport, {
    defaultTopK: config.defaultTopK,
    defaultTokenBudget: config.defaultTokenBudget,
    defaultMinSimilarity: config.defaultMinSimilarity,
  });

  if (options.installSignalHandlers !== false) {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void client.shutdown().catch((err: unknown) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "evo-bridge: shutdown failed",
        );
      });
    };
    process.once("beforeExit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  log.info(
    {
      adr: "ADR-129",
      binary: config.binaryPath,
      db: config.dbPath,
      default_top_k: config.defaultTopK,
      default_token_budget: config.defaultTokenBudget,
      default_min_similarity: config.defaultMinSimilarity,
    },
    "evo-bridge: enabled (subprocess will spawn lazily on first call)",
  );

  return client;
}

// ---------------------------------------------------------------------------
// Module-load singleton. mcp-server constructs one EvoClient at boot and
// every call site (the agent-memory facade, the find_similar_agents
// handler, handleRegisterAgent) reuses it. Tests can replace the singleton
// via `setEvoClient` so they don't need to spawn a real subprocess.
// ---------------------------------------------------------------------------

let cachedClient: EvoClient | null = null;

export function getEvoClient(): EvoClient {
  if (!cachedClient) {
    cachedClient = createEvoClient();
  }
  return cachedClient;
}

/**
 * Test seam. Replaces (or clears, when called with `null`) the cached
 * singleton. Production code must never call this — it's exported so the
 * `find-similar-agents.test.ts` and registry-handler tests can inject
 * mocks without spawning a real EVO subprocess.
 */
export function setEvoClient(client: EvoClient | null): void {
  cachedClient = client;
}

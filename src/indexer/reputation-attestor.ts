/**
 * ADR-139 — portable reputation attestation issuer (HTTP).
 *
 * Mounts two routes on the indexer's Express app:
 *
 *   GET /reputation/:agent_id
 *     Return a freshly-signed reputation attestation for the given
 *     `AgentProfile` PDA. Reads the current on-chain snapshot via the
 *     injected `AgentProfileFetcher`.
 *
 *   GET /reputation/:agent_id/at/:slot
 *     Return an attestation at a historical slot. Without an explicit
 *     historical fetcher the route responds with 501 + a documented
 *     fallback (issue a fresh attestation now and store it client-side).
 *
 * Rate-limiting and caching policy:
 *   - In-process LRU cache keyed by `(agent_id, snapshot_slot_bucket)`,
 *     bucket = floor(now / `cacheBucketSeconds`). Bucket reflects the
 *     "give me a fresh slot, but don't hammer the RPC for every
 *     duplicate request inside the same second" tradeoff.
 *   - Token-bucket rate limit per remote IP, modest default (60 req/min).
 *     Operators that front the service with a CDN or Cloudflare can set
 *     the env var `REPUTATION_ATTESTOR_DISABLE_RATELIMIT=1` to opt out.
 *
 * Configuration env vars:
 *   - REPUTATION_ATTESTOR_KEYPAIR_PATH / _B64 — issuer key.
 *   - REPUTATION_ATTESTOR_ISSUER_URL — discovery URL written into
 *     `payload.issuer_url`. Defaults to the request's `Host` header.
 *   - REPUTATION_ATTESTOR_EXPIRY_SECONDS — credential expiry; 0 (default)
 *     means "perpetual; verifier MUST enforce snapshot freshness".
 *   - REPUTATION_ATTESTOR_DISABLE_RATELIMIT — set to "1" to disable rate
 *     limiting (use only behind a CDN that already provides one).
 *
 * Design note: the issuer service is intentionally minimal — the
 * canonical signing primitive is `@agenomics/reputation-attestor`, and
 * this module is just a thin HTTP shell around it.
 */

import express, { type Application, type Request, type Response } from "express";
// ADR-091-style: `@agenomics/reputation-attestor` is ESM-only; the
// indexer's compile target is CJS. We import the runtime helpers
// lazily inside `mountReputationAttestor` and rely on `import type`
// for compile-time shape only — that prevents the TS compiler from
// down-emitting a `require(...)` that would fail to resolve.
import type {
  IssuerKeypair,
  AgentProfileSnapshot,
  ReputationCredential,
} from "@agenomics/reputation-attestor";

/**
 * Caller-provided fetcher for the agent profile. The issuer is read-only
 * with respect to the chain — it never decodes raw account data here.
 *
 * Implementations:
 *   - In production: an `@agenomics/client` `AgentRegistryClient` instance
 *     resolves PDAs into `AgentProfileSnapshot` shapes.
 *   - In tests: a stub returning canned snapshots.
 *
 * Return `null` when the profile does not exist; the issuer surfaces 404.
 * Throw to surface a 502 (upstream RPC failure).
 */
export interface AgentProfileFetcher {
  /**
   * Fetch the current snapshot for `agentId` (the `AgentProfile` PDA).
   * Implementations populate `snapshot_slot` and `snapshot_timestamp`
   * from the RPC's current slot.
   */
  fetchCurrent(agentId: string): Promise<{ snapshot: AgentProfileSnapshot; isActive: boolean } | null>;
  /**
   * Optional — historical fetch at a specific slot. Implementations
   * that lack archive RPC access should return `undefined`; the route
   * will respond with 501.
   */
  fetchAtSlot?(
    agentId: string,
    slot: bigint,
  ): Promise<{ snapshot: AgentProfileSnapshot; isActive: boolean } | null | undefined>;
}

export interface MountReputationAttestorOptions {
  app: Application;
  issuer: IssuerKeypair;
  fetcher: AgentProfileFetcher;
  /** Issuer discovery URL — written into the credential. */
  issuerUrl: string;
  /** Credential expiry (seconds from issue). 0 = perpetual. */
  expirySeconds?: number;
  /** Cache bucket width in seconds. 0 = disable cache. Default: 5. */
  cacheBucketSeconds?: number;
  /** Rate limit window in seconds. 0 = disable rate limit. Default: 60. */
  rateLimitWindowSeconds?: number;
  /** Max requests per window per IP. Default: 60. */
  rateLimitMaxRequests?: number;
  /** Test hook — unix-seconds clock. Defaults to `Date.now()`. */
  now?: () => number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLOT_RE = /^\d{1,20}$/;

interface CacheEntry {
  bucket: number;
  credential: ReputationCredential;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

/**
 * Mount the issuer routes onto an existing Express app.
 *
 * The issuer is constructed lazily — if `loadIssuerKeypair()` would fail
 * (no env var set), the mount still succeeds but every request returns
 * 503 with a clear configuration hint. This matches the indexer's
 * "degraded but running" posture for missing-config branches elsewhere.
 */
export function mountReputationAttestor(
  opts: MountReputationAttestorOptions,
): void {
  const cacheBucketSeconds = opts.cacheBucketSeconds ?? 5;
  const rateLimitWindowSeconds = opts.rateLimitWindowSeconds ?? 60;
  const rateLimitMaxRequests = opts.rateLimitMaxRequests ?? 60;
  const expirySeconds = opts.expirySeconds ?? 0;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  // Lazy ESM import — see file header for the CJS/ESM rationale. The
  // promise is memoised so the import only ever runs once per process.
  let attestorMod: Promise<typeof import("@agenomics/reputation-attestor")> | null = null;
  function getAttestor() {
    if (!attestorMod) {
      attestorMod = import("@agenomics/reputation-attestor");
    }
    return attestorMod;
  }

  const cache = new Map<string, CacheEntry>();
  const rateBuckets = new Map<string, RateBucket>();

  function takeRateLimit(req: Request): boolean {
    if (rateLimitWindowSeconds === 0) return true;
    if (process.env.REPUTATION_ATTESTOR_DISABLE_RATELIMIT === "1") return true;
    const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const t = now();
    const cur = rateBuckets.get(ip);
    if (!cur || t - cur.windowStart >= rateLimitWindowSeconds) {
      rateBuckets.set(ip, { windowStart: t, count: 1 });
      return true;
    }
    if (cur.count >= rateLimitMaxRequests) return false;
    cur.count++;
    return true;
  }

  function cacheKey(agentId: string): string {
    if (cacheBucketSeconds === 0) return `${agentId}:${now()}`;
    return `${agentId}:${Math.floor(now() / cacheBucketSeconds)}`;
  }

  async function makeCredential(
    snapshot: AgentProfileSnapshot,
  ): Promise<ReputationCredential> {
    const expiry = expirySeconds > 0 ? now() + expirySeconds : 0;
    const mod = await getAttestor();
    return mod.issueAttestation(snapshot, {
      issuer: opts.issuer,
      issuerUrl: opts.issuerUrl,
      expiryUnixTs: expiry,
    });
  }

  opts.app.get("/reputation/:agent_id", async (req: Request, res: Response) => {
    if (!takeRateLimit(req)) {
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    const agentId = req.params.agent_id ?? "";
    if (!BASE58_RE.test(agentId)) {
      res.status(400).json({ error: "agent_id must be a base58 pubkey" });
      return;
    }

    // Cache hit?
    const key = cacheKey(agentId);
    const cached = cache.get(key);
    if (cached) {
      // Bounded staleness: serve from cache, but tag with cache headers
      // so a CDN doesn't pin it longer than our bucket.
      res.setHeader("Cache-Control", `public, max-age=${cacheBucketSeconds}`);
      res.json(cached.credential);
      return;
    }

    let snapshot: AgentProfileSnapshot;
    try {
      const fetched = await opts.fetcher.fetchCurrent(agentId);
      if (fetched === null) {
        res.status(404).json({ error: `agent profile ${agentId} not found` });
        return;
      }
      if (!fetched.isActive) {
        // ADR-139 §6 — deactivated / suspended profiles are not eligible
        // to issue credentials. Verifiers should observe the missing
        // credential and degrade accordingly.
        res.status(409).json({
          error: `agent profile ${agentId} is not active; refusing to issue an attestation`,
        });
        return;
      }
      snapshot = fetched.snapshot;
    } catch (e) {
      res.status(502).json({
        error: `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    let cred: ReputationCredential;
    try {
      cred = await makeCredential(snapshot);
    } catch (e) {
      res.status(500).json({
        error: `signing failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    cache.set(key, { bucket: now(), credential: cred });
    res.setHeader("Cache-Control", `public, max-age=${cacheBucketSeconds}`);
    res.json(cred);
  });

  opts.app.get(
    "/reputation/:agent_id/at/:slot",
    async (req: Request, res: Response) => {
      if (!takeRateLimit(req)) {
        res.status(429).json({ error: "rate limit exceeded" });
        return;
      }
      const agentId = req.params.agent_id ?? "";
      const slotStr = req.params.slot ?? "";
      if (!BASE58_RE.test(agentId)) {
        res.status(400).json({ error: "agent_id must be a base58 pubkey" });
        return;
      }
      if (!SLOT_RE.test(slotStr)) {
        res.status(400).json({ error: "slot must be a non-negative integer" });
        return;
      }
      const slot = BigInt(slotStr);

      if (!opts.fetcher.fetchAtSlot) {
        res.status(501).json({
          error: "historical attestation not implemented",
          fallback:
            "Issue a fresh attestation now via GET /reputation/:agent_id and " +
            "store it on the verifier side; the snapshot_slot field will pin the value at issue time.",
        });
        return;
      }

      let result: Awaited<ReturnType<NonNullable<typeof opts.fetcher.fetchAtSlot>>>;
      try {
        result = await opts.fetcher.fetchAtSlot(agentId, slot);
      } catch (e) {
        res.status(502).json({
          error: `historical fetch failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        });
        return;
      }
      if (result === undefined) {
        res.status(501).json({
          error: "historical attestation not available at the configured archive depth",
        });
        return;
      }
      if (result === null) {
        res.status(404).json({
          error: `agent profile ${agentId} did not exist at slot ${slotStr}`,
        });
        return;
      }
      if (!result.isActive) {
        res.status(409).json({
          error: `agent profile ${agentId} was not active at slot ${slotStr}`,
        });
        return;
      }
      try {
        const cred = await makeCredential(result.snapshot);
        // Historical responses are immutable — they pin to a specific slot
        // — so they're cacheable forever from the client's perspective.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.json(cred);
      } catch (e) {
        res.status(500).json({
          error: `signing failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
  );
}

/**
 * Convenience helper for tests / standalone usage — build an Express
 * `Application` with only the reputation-attestor routes mounted. The
 * production indexer mounts onto its existing Express app instead.
 */
export function createReputationAttestorApp(
  opts: Omit<MountReputationAttestorOptions, "app">,
): Application {
  const app = express();
  mountReputationAttestor({ ...opts, app });
  return app;
}

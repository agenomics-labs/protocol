// ADR-139 §3 — `@agenomics/sas-resolver` integration helper for
// `agenomics.reputation.v1` portable reputation attestations.
//
// This file lives in `sas-resolver` rather than `reputation-attestor`
// because:
//   - the resolver already owns the cache primitive (`CacheBackend`),
//     including the production Redis backend (ADR-065),
//   - downstream consumers (mcp-server, dashboard) already speak the
//     resolver's `Result<_>` shape, and
//   - the resolver is the canonical SAS-side trust root; portable
//     attestations are the "exported" variant of the same signal, so
//     hosting both behind one resolver shape keeps the surface coherent.
//
// We deliberately do NOT depend on `@agenomics/reputation-attestor`
// statically — it's loaded dynamically so the resolver keeps a clean
// import graph and consumers that never call this helper don't pay the
// load cost.

import type { CacheBackend } from "./cache.js";
import { InMemoryCache } from "./cache.js";

const REPUTATION_TTL_MS_DEFAULT = 300_000; // 5 m
const REPUTATION_CACHE_PREFIX = "aep:cache:reputation-attestation:";

/**
 * Compact resolver-level result for a portable reputation attestation.
 *
 * Mirrors the `@agenomics/reputation-attestor` `VerifyResult` shape
 * (with structured `reasons`), but typed against `Result<_>` so callers
 * that already consume the SAS resolver can use the same control flow.
 */
export interface AgenomicsReputationResolved {
  /** Agent profile PDA (base58) — copied from the verified payload. */
  agent_id: string;
  /** Authority pubkey (base58). */
  authority: string;
  /** Reputation score, clamped `[0, 100]`. */
  reputation_score: number;
  /** Cumulative slash count. */
  slash_count: number;
  /** Issuer key (base58). */
  issuer: string;
  /** Snapshot slot (decimal string for u64 fidelity). */
  snapshot_slot: string;
  /** Unix-seconds timestamp of the snapshot. */
  snapshot_timestamp: number;
  /** True if the cache served this lookup. */
  fromCache: boolean;
  /** Optional advisory diagnostic reasons (e.g. STALE_SNAPSHOT). */
  reasons: Array<{ code: string; message: string }>;
}

export interface ResolveAgenomicsReputationOptions {
  /**
   * Issuer allowlist — base58 pubkeys. If set, the credential's issuer
   * MUST be in this list. Mandatory in production: the verifier MUST
   * pin the issuer set to its trust root (ADR-139 §7).
   */
  allowedIssuers?: readonly string[];
  /**
   * Snapshot-age tolerance (seconds). Defaults to 24 h — verifiers can
   * tighten this for high-trust gates (e.g. 5 m) or relax for advisory
   * surfaces.
   */
  maxSnapshotAgeSeconds?: number;
  /**
   * Cache backend (`InMemoryCache` / `RedisCache` / `LayeredCache`).
   * Reuses the resolver's existing primitives so consumers can wire one
   * backend for both SAS attestations and portable reputation creds.
   */
  cache?: CacheBackend;
  /** Cache TTL in ms. Defaults to 5 m (matches SAS attestation TTL). */
  cacheTtlMs?: number;
  /** Test hook — unix-seconds wall clock. */
  now?: () => number;
  /** Force fresh (skip cache). */
  forceFresh?: boolean;
}

interface CachedResolved {
  payload: AgenomicsReputationResolved;
}

/**
 * Verify a portable reputation credential and surface a compact view,
 * with a cache around the verify step so a flood of identical credential
 * payloads doesn't re-hash. The cache key is the credential's
 * `(agent_id, snapshot_slot, signature)` triple — that triple uniquely
 * identifies a signed credential because the signature is over the
 * canonical-JSON of every field.
 *
 * Returns a `Result`-shaped tuple to match the rest of the resolver.
 */
export async function resolveAgenomicsReputation(
  credential: unknown,
  opts: ResolveAgenomicsReputationOptions = {},
): Promise<
  | { ok: true; value: AgenomicsReputationResolved }
  | { ok: false; error: { code: string; message: string; reasons?: Array<{ code: string; message: string }> } }
> {
  const cache = opts.cache ?? new InMemoryCache();
  const ttlMs = opts.cacheTtlMs ?? REPUTATION_TTL_MS_DEFAULT;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  // Cache key — extract just enough from the raw credential to build the
  // triple. We do not validate yet (Zod runs inside verify) — failures
  // simply skip the cache.
  const cacheKey = tryCacheKey(credential);
  if (cacheKey && !opts.forceFresh) {
    const hit = await cache.get<CachedResolved>(cacheKey);
    if (hit !== null) {
      return {
        ok: true,
        value: { ...hit.value.payload, fromCache: true },
      };
    }
  }

  // Dynamic import — keeps the @agenomics/reputation-attestor load cost
  // out of the resolver's hot path for consumers that never call this
  // helper.
  const attestorMod = await import("@agenomics/reputation-attestor").catch(
    (e) => {
      throw new Error(
        `resolveAgenomicsReputation: failed to import @agenomics/reputation-attestor — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    },
  );
  const result = attestorMod.verifyAttestation(credential, {
    allowedIssuers: opts.allowedIssuers,
    maxSnapshotAgeSeconds: opts.maxSnapshotAgeSeconds ?? 24 * 60 * 60,
    now,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: result.reasons[0]?.code ?? "VERIFY_FAILED",
        message:
          result.reasons[0]?.message ?? "credential failed verification",
        reasons: result.reasons,
      },
    };
  }

  const payload = result.payload;
  const value: AgenomicsReputationResolved = {
    agent_id: payload.agent_id,
    authority: payload.authority,
    reputation_score: payload.reputation_score,
    slash_count: payload.slash_count,
    issuer: payload.issuer,
    snapshot_slot: payload.snapshot_slot,
    snapshot_timestamp: payload.snapshot_timestamp,
    fromCache: false,
    reasons: result.reasons.map((r) => ({ code: r.code, message: r.message })),
  };

  if (cacheKey) {
    await cache.set<CachedResolved>(cacheKey, { payload: value }, ttlMs);
  }
  return { ok: true, value };
}

/**
 * Build a stable cache key for a credential. Best-effort — if the
 * credential doesn't have the expected shape, return `null` and the
 * caller skips the cache. The full structural validation happens inside
 * `verifyAttestation`.
 */
function tryCacheKey(credential: unknown): string | null {
  if (typeof credential !== "object" || credential === null) return null;
  const c = credential as { payload?: unknown; signature?: unknown };
  if (typeof c.signature !== "string") return null;
  if (typeof c.payload !== "object" || c.payload === null) return null;
  const p = c.payload as {
    agent_id?: unknown;
    snapshot_slot?: unknown;
  };
  if (typeof p.agent_id !== "string") return null;
  if (typeof p.snapshot_slot !== "string") return null;
  return `${REPUTATION_CACHE_PREFIX}${p.agent_id}:${p.snapshot_slot}:${c.signature.slice(0, 16)}`;
}

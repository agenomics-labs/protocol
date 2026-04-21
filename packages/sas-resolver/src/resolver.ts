// ADR-064 — `@agenomics/sas-resolver` main resolver class.
//
// Implements the ADR-061 §4 resolution flow end-to-end for off-chain
// consumers. Steps 1–3 (Registry fetch + manifest integrity check) are
// out of scope per ADR-061 §8 (those belong to the Registry indexer
// and `@agenomics/capability-manifest-validator` respectively); the resolver
// assumes the caller has already validated the manifest.
//
// The §4 failure-mode table is implemented row-for-row in
// `#resolveSingle` below — comments mark each row.
//
// --------------------------------------------------------------------
// Error-handling contract
// --------------------------------------------------------------------
// Most SAS-layer failures degrade to `absent: true` because SAS is
// additive (ADR-061 §4). The one exception is row 4f (subject
// mismatch), which is a HARD error — either an agent mistake or an
// adversarial attempt to borrow another agent's reputation. That
// case returns `err({ code: 'SUBJECT_MISMATCH', ... })` and is
// surfaced to the caller as a `Result<_>` failure, distinct from
// `absent: true`.
//
// INVALID_INPUT / INVALID_CONFIG / RPC_ERROR are the only other
// hard-error shapes; everything else is absorbed into `ResolvedReputation`.

import { z } from "zod";
import type {
  ManifestLike,
  ResolvedReputation,
  ResolverConfig,
  ResolverRpc,
  ResolveOptions,
  ResolverTtlConfig,
  Result,
  ResolverError,
  AttestationReputation,
} from "./types.js";
import {
  parseAttestationAccount,
  parseReputationData,
  toAttestationReputation,
} from "./schema.js";
import { isAllowed } from "./allowlist.js";
import {
  InMemoryCache,
  type CacheBackend,
  type CacheMetrics,
} from "./cache.js";

// --------------------------------------------------------------------
// Input validation — zod schemas at the boundary (AEP project rule:
// "Ensure input validation at system boundaries").
// --------------------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ManifestInputSchema = z.object({
  agent: z.object({
    pubkey: z.string().regex(BASE58, "agent.pubkey must be base58"),
    owner_attestation: z
      .string()
      .regex(BASE58, "agent.owner_attestation must be base58")
      .optional(),
  }),
});

// --------------------------------------------------------------------
// Stale threshold — 90 days per ADR-061 §6.
// --------------------------------------------------------------------
const STALE_SECONDS = 90 * 86_400;

// --------------------------------------------------------------------
// Cache defaults — ADR-065 §1. All in milliseconds.
// --------------------------------------------------------------------
const DEFAULT_TTL: Required<ResolverTtlConfig> = {
  registry: 30_000,
  manifest: 86_400_000,
  attestation: 300_000,
  schema: 3_600_000,
  credential: 3_600_000,
};

const CACHE_KEY_PREFIX = "aep:cache:";

/** Cache key format per ADR-065 §3 "Key format". */
function attestationCacheKey(pda: string): string {
  return `${CACHE_KEY_PREFIX}attestation:${pda}`;
}

/**
 * Shape we store in the cache. Kept deliberately narrow — just the raw
 * bytes plus the PDA that was fetched. We avoid caching the decoded
 * `ResolvedReputation` because downstream interpretation (subject check,
 * stale-by-age) is cheap and depends on the caller's `now()`.
 */
interface CachedAttestationBytes {
  /** base64-encoded account bytes — JSON-safe for the Redis backend. */
  bytesB64: string;
}

export class SasResolver {
  readonly #rpc: ResolverRpc;
  readonly #allowed: Set<string>;
  readonly #schemaPda: string;
  readonly #now: () => number;
  readonly #warn: (message: string, details?: unknown) => void;
  readonly #cache: CacheBackend;
  readonly #ttl: Required<ResolverTtlConfig>;
  /**
   * Wall-clock millisecond source for cache `maxAge` arithmetic. The
   * resolver's `#now` returns unix *seconds* (ADR-064 contract, to
   * match SAS's on-chain timestamp format); the cache primitive uses
   * milliseconds (ADR-065 §5 `cachedAt: number` — Unix ms). We keep
   * them separate: production defaults to `Date.now()`, tests that
   * want to freeze cache time should inject their own `CacheBackend`
   * constructed with a custom `now` (see `InMemoryCacheOptions`).
   * Mixing the two clocks in one `now` callback would force every
   * caller to choose between controlling cache freshness and the
   * resolver's stale-by-age threshold.
   */
  readonly #cacheNow: () => number;
  /**
   * Aggregated cache counters. We tally in the resolver rather than
   * poking the backend's internals because (a) the `CacheBackend`
   * interface is deliberately layer-agnostic and (b) tests need
   * resolver-observable hit/miss counts even when a Redis backend
   * that doesn't expose metrics is in use.
   */
  readonly #cacheMetrics: CacheMetrics = { hits: 0, misses: 0, evictions: 0 };

  constructor(config: ResolverConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("SasResolver: config is required");
    }
    if (!config.rpc) {
      throw new Error("SasResolver: config.rpc is required");
    }
    if (!(config.allowedCredentials instanceof Set)) {
      throw new Error(
        "SasResolver: config.allowedCredentials must be a Set<string>",
      );
    }
    if (typeof config.schemaPda !== "string" || !BASE58.test(config.schemaPda)) {
      throw new Error(
        "SasResolver: config.schemaPda must be a base58 pubkey string",
      );
    }
    this.#rpc = config.rpc;
    this.#allowed = config.allowedCredentials;
    this.#schemaPda = config.schemaPda;
    this.#now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.#warn = config.warn ?? ((m, d) => (d !== undefined ? console.warn(m, d) : console.warn(m)));
    this.#cache = config.cache ?? new InMemoryCache();
    this.#ttl = {
      registry: config.ttl?.registry ?? DEFAULT_TTL.registry,
      manifest: config.ttl?.manifest ?? DEFAULT_TTL.manifest,
      attestation: config.ttl?.attestation ?? DEFAULT_TTL.attestation,
      schema: config.ttl?.schema ?? DEFAULT_TTL.schema,
      credential: config.ttl?.credential ?? DEFAULT_TTL.credential,
    };
    // Cache freshness math uses ms; resolver math uses seconds. Use
    // `config.cacheNow` if supplied (tests that want to freeze cache
    // time), otherwise `Date.now()`. See the JSDoc on `#cacheNow`
    // above for why we don't overload the seconds-clock `config.now`.
    this.#cacheNow = config.cacheNow ?? (() => Date.now());
  }

  /**
   * Resolve a single agent's SAS-referenced reputation.
   *
   * @param manifest - The caller's already-validated CapabilityManifest
   *   (or any object with an `agent.owner_attestation?` field).
   * @param subjectAuthority - The agent's on-chain authority pubkey,
   *   as fetched from `AgentProfile.authority`. The resolver verifies
   *   the attestation's `subject` matches this value (§4 row 4f).
   * @param opts - Optional per-call cache policy override. See
   *   {@link ResolveOptions} and ADR-065 §5 for the `maxAge` semantics.
   * @returns A `Result<ResolvedReputation>`. `ok: true` is the normal
   *   path — check `value.absent`, `value.stale`, `value.attestation`
   *   to interpret. `ok: false` only triggers for hard errors
   *   (SUBJECT_MISMATCH, INVALID_INPUT, INVALID_CONFIG, RPC_ERROR).
   */
  async resolve(
    manifest: ManifestLike,
    subjectAuthority: string,
    opts?: ResolveOptions,
  ): Promise<Result<ResolvedReputation>> {
    return this.#resolveSingle(manifest, subjectAuthority, opts);
  }

  /**
   * Resolve multiple agents in parallel. Preserves input order in the
   * output array — callers can zip against their original list.
   *
   * Each entry is resolved independently; one entry's failure does not
   * affect the others (each gets its own `Result`). The per-call cache
   * policy applies uniformly to every entry in the batch — entries that
   * need different staleness thresholds should split into separate
   * `resolve` calls.
   */
  async resolveBatch(
    entries: Array<{ manifest: ManifestLike; subjectAuthority: string }>,
    opts?: ResolveOptions,
  ): Promise<Result<ResolvedReputation>[]> {
    if (!Array.isArray(entries)) {
      throw new Error("resolveBatch: entries must be an array");
    }
    return Promise.all(
      entries.map((e) => this.#resolveSingle(e.manifest, e.subjectAuthority, opts)),
    );
  }

  /**
   * Evict the cache entry for a specific attestation PDA. The caller
   * already did the manifest validation that produced this PDA, so
   * passing it explicitly avoids an index-by-subject lookup we would
   * otherwise need to maintain.
   *
   * A broader `invalidate(subjectAuthority)` that evicts every SAS
   * entry tied to an agent authority requires the cache to maintain a
   * secondary index (subject → attestation PDA) — deferred to a
   * follow-up PR per ADR-065 §2 "Explicit consumer API" with a v1
   * shape. Wiring an on-chain event subscription to call this method
   * is the canonical "push-based invalidation" pattern.
   */
  async invalidate(attestationPda: string): Promise<void> {
    if (typeof attestationPda !== "string" || attestationPda.length === 0) {
      throw new Error("invalidate: attestationPda must be a non-empty string");
    }
    await this.#cache.delete(attestationCacheKey(attestationPda));
  }

  /**
   * Snapshot of cache hit / miss / eviction counters. The counter
   * record is shaped per ADR-065 §7 and is deliberately flat — per-layer
   * breakdown is a follow-up PR that lands alongside Registry and
   * manifest-body caching (§3).
   *
   * The eviction counter reflects the resolver's view of TTL-based
   * evictions observed on `get`. In-memory LRU evictions happen on the
   * backend's internal path and are visible to the operator via the
   * backend's own metrics (`InMemoryCache.metrics()`), not via this
   * method — the two counters are additive but distinct.
   */
  cacheMetrics(): CacheMetrics {
    return { ...this.#cacheMetrics };
  }

  // ------------------------------------------------------------------
  // Per-entry resolution — ADR-061 §4 rows 4a..4g.
  // ------------------------------------------------------------------
  async #resolveSingle(
    manifest: ManifestLike,
    subjectAuthority: string,
    opts?: ResolveOptions,
  ): Promise<Result<ResolvedReputation>> {
    // Boundary validation.
    const manifestParsed = ManifestInputSchema.safeParse(manifest);
    if (!manifestParsed.success) {
      return err("INVALID_INPUT", "manifest failed boundary validation", {
        issues: manifestParsed.error.issues,
      });
    }
    if (typeof subjectAuthority !== "string" || !BASE58.test(subjectAuthority)) {
      return err(
        "INVALID_INPUT",
        "subjectAuthority must be a base58 pubkey string",
      );
    }

    const subject = subjectAuthority;
    const attestationPubkey = manifestParsed.data.agent.owner_attestation;

    // Row 4a — owner_attestation unset or empty. Not an error, just
    // "no signal".
    if (!attestationPubkey) {
      return ok({ subject, absent: true });
    }

    // Fetch the SAS attestation account — with cache.
    // Row 4b — account missing / closed -> absent: true.
    let accountBytes: Uint8Array | null;
    try {
      accountBytes = await this.#fetchAttestationBytes(attestationPubkey, opts);
    } catch (e) {
      // RPC-layer failure — hard error. Distinct from "account not
      // found" (which resolves to null below).
      return err(
        "RPC_ERROR",
        `failed to fetch attestation account ${attestationPubkey}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (accountBytes === null) {
      return ok({ subject, absent: true });
    }

    // Parse the account. A decode failure here covers rows 4b
    // (malformed account) and 4g (data parse failure) — both route
    // to skip-with-warn.
    let raw: ReturnType<typeof parseAttestationAccount>;
    try {
      raw = parseAttestationAccount(accountBytes);
    } catch (e) {
      this.#warn(
        `[sas-resolver] attestation account ${attestationPubkey} is malformed — skipping`,
        { error: e instanceof Error ? e.message : String(e) },
      );
      return ok({ subject, absent: true });
    }

    const schema = encodeBase58(raw.schema);
    const credential = encodeBase58(raw.credential);
    const signer = encodeBase58(raw.signer);
    const accountSubject = encodeBase58(raw.subject);

    // Row 4c — schema mismatch -> skip + warn.
    if (schema !== this.#schemaPda) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} references unsupported schema — skipping`,
        { observed: schema, expected: this.#schemaPda },
      );
      return ok({ subject, absent: true });
    }

    // Row 4d — credential not allowlisted -> skip + warn.
    if (!isAllowed(this.#allowed, credential)) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} uses non-allowlisted credential — skipping`,
        { credential, allowlist_size: this.#allowed.size },
      );
      return ok({ subject, absent: true });
    }

    // Row 4f — subject mismatch. HARD ERROR. This check is before the
    // expiry check on purpose: an expired attestation about the wrong
    // subject is still a provenance violation worth surfacing.
    if (accountSubject !== subject) {
      return err(
        "SUBJECT_MISMATCH",
        `attestation subject does not match agent authority`,
        {
          attestation: attestationPubkey,
          expected: subject,
          observed: accountSubject,
        },
      );
    }

    // Row 4e — expired -> absent + stale. ADR-061 §6: treat expired as
    // absent (silent skip, not hard error) but tag `stale: true` for
    // UX differentiation.
    const now = this.#now();
    if (raw.expiry > 0 && raw.expiry <= now) {
      return ok({ subject, absent: true, stale: true });
    }

    // Row 4g — schema-data parse failure -> skip + warn.
    let data: ReturnType<typeof parseReputationData>;
    try {
      data = parseReputationData(raw.data);
    } catch (e) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} data did not decode as AEP_AGENT_REPUTATION_v1 — skipping`,
        { error: e instanceof Error ? e.message : String(e) },
      );
      return ok({ subject, absent: true });
    }

    const attestation: AttestationReputation = toAttestationReputation(data, {
      signer,
      credential,
      expiry: raw.expiry,
    });

    // Stale-by-age per §6 — `last_updated` older than 90 days. Still
    // returned; just flagged so the caller can weight it.
    const resolved: ResolvedReputation = {
      subject,
      attestation,
    };
    if (now - data.last_updated > STALE_SECONDS) {
      resolved.stale = true;
    }
    return ok(resolved);
  }

  /**
   * Fetch an attestation account's raw bytes, consulting the cache
   * first (ADR-065 §3). Policy:
   *
   *   - `opts.maxAge` undefined → respect configured TTL (cache hit
   *     returns immediately).
   *   - `opts.maxAge === 0`     → bypass cache on read, still
   *     write-through on the fresh fetch.
   *   - `opts.maxAge > 0`       → use cache only if the entry is
   *     fresher than `maxAge`; otherwise refetch.
   *
   * A successful fetch (account found OR explicitly absent) is cached
   * with the configured `attestation` TTL. Transport errors are NOT
   * cached — they propagate to the caller and stay the caller's
   * decision to retry.
   */
  async #fetchAttestationBytes(
    pubkey: string,
    opts: ResolveOptions | undefined,
  ): Promise<Uint8Array | null> {
    const key = attestationCacheKey(pubkey);
    const maxAge = opts?.maxAge;

    // Cache read — skipped when `maxAge === 0` (force-fresh).
    if (maxAge !== 0) {
      const cached = await this.#cache.get<CachedAttestationBytes | null>(key);
      if (cached !== null) {
        const age = this.#cacheNow() - cached.cachedAt;
        const fresh =
          maxAge === undefined ? true /* respect TTL, which the backend already enforced */
                               : age <= maxAge;
        if (fresh) {
          this.#cacheMetrics.hits++;
          // `null` entry means "we fetched and confirmed absent" — the
          // resolver's row-4b path. Treat as `null` bytes.
          if (cached.value === null) return null;
          return base64Decode(cached.value.bytesB64);
        }
        // Entry exists but is older than the caller's maxAge. Count as
        // a miss so the metrics reflect the RPC hit the caller got.
        this.#cacheMetrics.misses++;
      } else {
        this.#cacheMetrics.misses++;
      }
    }
    // maxAge === 0 path also counts as a miss so metrics reflect the
    // RPC call the resolver is about to issue.
    if (maxAge === 0) this.#cacheMetrics.misses++;

    const bytes = await this.#fetchAccountData(pubkey);

    // Write-through — populate the cache (including the "absent"
    // negative entry so row-4b lookups also cache).
    const payload: CachedAttestationBytes | null =
      bytes === null ? null : { bytesB64: base64Encode(bytes) };
    await this.#cache.set(key, payload, this.#ttl.attestation);

    return bytes;
  }

  /**
   * Fetch an account's raw bytes. Returns `null` if the account does
   * not exist (row 4b). Throws on RPC-layer failure so the caller can
   * distinguish transport errors from "no such account".
   */
  async #fetchAccountData(pubkey: string): Promise<Uint8Array | null> {
    // Duck-typed call into `@solana/kit`'s Rpc. We type `this.#rpc` as
    // `ResolverRpc` (a narrow subset) so the resolver works with
    // either the full Rpc<SolanaRpcApi> from createSolanaRpc() or a
    // test shim. The runtime shape is the same either way: call
    // `.getAccountInfo(addr, opts).send()` and inspect `.value`.
    const rpc = this.#rpc as {
      getAccountInfo: (addr: unknown, opts?: unknown) => { send(): Promise<unknown> };
    };

    // `@solana/kit` expects an Address branded type, but at runtime it
    // is just a base58 string. We accept the string form for mock
    // RPCs in tests; production consumers can wrap with `address()` if
    // they want the stronger type signature, but the resolver itself
    // never inspects the brand.
    const result = (await rpc.getAccountInfo(pubkey, { encoding: "base64" }).send()) as {
      value: AccountInfoResponse | null;
    } | null;

    if (!result || result.value === null || result.value === undefined) {
      return null;
    }

    return decodeAccountData(result.value.data);
  }
}

// --------------------------------------------------------------------
// RPC response shape — only what we inspect.
// --------------------------------------------------------------------
interface AccountInfoResponse {
  data:
    | readonly [string, "base64"]
    | readonly [string, "base58"]
    | string // jsonParsed / base58 direct
    | Uint8Array // tests may hand us bytes directly
    | Array<number>; // rare, but some mocks use number[]
  lamports?: number;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number;
}

function decodeAccountData(
  data: AccountInfoResponse["data"],
): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) {
    // `[b64string, 'base64']` or `[b58string, 'base58']` or number[]
    if (data.length === 2 && typeof data[0] === "string") {
      const [payload, encoding] = data as unknown as [string, string];
      if (encoding === "base64") {
        return base64Decode(payload);
      }
      if (encoding === "base58") {
        return base58Decode(payload);
      }
      throw new Error(`unsupported account data encoding: ${encoding}`);
    }
    if (data.every((n: unknown) => typeof n === "number")) {
      return Uint8Array.from(data as number[]);
    }
    throw new Error("malformed account data tuple");
  }
  if (typeof data === "string") {
    // Older RPC shape: a bare base58 string. Decode.
    return base58Decode(data);
  }
  throw new Error("unrecognized account data shape");
}

// --------------------------------------------------------------------
// Base58 / base64 codec helpers. Kept local (no extra dep) because
// these are the only two encodings the resolver touches.
// --------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function encodeBase58(bytes: Uint8Array): string {
  // Count leading zero-bytes — base58 preserves them as '1' chars.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to big-int, then base58-encode by successive division.
  // For 32-byte pubkeys this is plenty fast; no native dep required.
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);

  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHABET[rem]! + out;
  }
  for (let i = 0; i < zeros; i++) out = "1" + out;
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  let num = 0n;
  for (const ch of s) {
    const v = B58_MAP[ch];
    if (v === undefined) {
      throw new Error(`invalid base58 character: ${ch}`);
    }
    num = num * 58n + BigInt(v);
  }

  // Convert back to big-endian bytes.
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

export function base64Decode(s: string): Uint8Array {
  // Node's Buffer.from(s, 'base64') is available in every supported
  // runtime target for this package (Node 20+). Using it avoids
  // atob() inconsistencies across environments.
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  // Fallback for non-Node runtimes.
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  // Paired with `base64Decode` — same env preference (Node `Buffer`
  // first, falls back to `btoa` via binary-string intermediate).
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

// --------------------------------------------------------------------
// Result helpers
// --------------------------------------------------------------------
function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function err(
  code: ResolverError["code"],
  message: string,
  details?: unknown,
): Result<never> {
  return { ok: false, error: { code, message, details } };
}

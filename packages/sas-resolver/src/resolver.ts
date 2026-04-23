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
// INVALID_INPUT / INVALID_CONFIG / RPC_ERROR / RESOLVER_INIT are the
// only other hard-error shapes; everything else is absorbed into
// `ResolvedReputation`.
//
// --------------------------------------------------------------------
// ADR-076 (DEEP-AUDIT-2026-04-22 SEC-3 + SEC-15) trust-boundary hardening
// --------------------------------------------------------------------
//   - Per-credential signer / schema scoping at the allowlist layer.
//     A leaked credential-authority key cannot mint attestations for
//     a foreign schema, and cannot be bypassed by an unintended signer.
//   - Strict resolver-init mode: asserts `schemaPda` is owned by the
//     SAS program before any resolve. A misconfigured schema is a
//     protocol-level trust failure — refusing to resolve is safer than
//     silently trusting attacker-owned accounts.

import { z } from "zod";
import type {
  AllowedCredential,
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
import { normalizeAllowlist } from "./allowlist.js";
import {
  InMemoryCache,
  type CacheBackend,
  type CacheMetrics,
} from "./cache.js";

// --------------------------------------------------------------------
// SAS program ID — canonical devnet deployment per STATUS.md. Used as
// the default for `ResolverConfig.sasProgramId` at resolver init so
// `strict` mode (DEEP-AUDIT-2026-04-22 SEC-15 / ADR-076 §2) has a
// working default. Override in `ResolverConfig.sasProgramId` for test
// clusters or a future on-chain upgrade.
// --------------------------------------------------------------------
export const DEFAULT_SAS_PROGRAM_ID =
  "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";

/**
 * Error thrown (or surfaced via `Result`) when the resolver cannot
 * complete its strict-init schema-PDA owner check (ADR-076 §2). This is
 * distinct from `RPC_ERROR` (transport failure) and `INVALID_CONFIG`
 * (malformed config) — it specifically flags a schema PDA that does
 * not belong to the configured SAS program, which would let any
 * attacker-controlled account masquerade as an AEP reputation schema
 * if not caught. See DEEP-AUDIT-2026-04-22 SEC-15.
 */
export class ResolverInitError extends Error {
  public readonly code = "RESOLVER_INIT" as const;
  constructor(
    message: string,
    public readonly details?: {
      schemaPda: string;
      expectedOwner: string;
      observedOwner?: string | null;
    },
  ) {
    super(message);
    this.name = "ResolverInitError";
  }
}

/**
 * Error thrown when a credential's allowlist entry has no signer history
 * (i.e. `entry.signers` is `undefined` or empty). Per ADR-101, a
 * credential without an explicit signer list must hard-fail rather than
 * silently pass signer validation. This closes the security hole where
 * an unsigned or history-free credential could bypass the per-credential
 * signer scope check (ADR-076 §3, DEEP-AUDIT-2026-04-22 SEC-3).
 *
 * Callers that previously relied on the flat v0 allowlist shape
 * (`Set<string>`, mapping to `signers: undefined`) must migrate to the
 * scoped `AllowedCredential` shape with an explicit `signers` list.
 *
 * See ADR-101 for the full decision record.
 */
export class SignerHistoryMissingError extends Error {
  constructor(credentialId: string) {
    super(
      `Credential '${credentialId}' has no signer history (entry.signers is undefined or empty). ` +
        `This credential cannot be validated. See ADR-101.`,
    );
    this.name = "SignerHistoryMissingError";
  }
}

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
  readonly #allowed: Map<string, AllowedCredential>;
  readonly #schemaPda: string;
  readonly #sasProgramId: string;
  readonly #strict: boolean;
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
   */
  readonly #cacheNow: () => number;
  readonly #cacheMetrics: CacheMetrics = { hits: 0, misses: 0, evictions: 0 };

  /**
   * Lazy resolver-init guard (ADR-076 §2, DEEP-AUDIT SEC-15). In strict
   * mode (default), the first `resolve()` call awaits an RPC fetch of
   * `schemaPda` and asserts `owner == sasProgramId`. The promise is
   * memoized so parallel `resolve()` calls share one RPC hit. If the
   * check definitively fails (owner mismatch / account missing),
   * `#initError` latches and every subsequent `resolve()` returns a
   * `RESOLVER_INIT` error. Transport failures do NOT latch — they
   * bubble to the caller so a flaky RPC can be retried.
   */
  #initPromise: Promise<void> | null = null;
  #initError: ResolverInitError | null = null;
  #initOk = false;

  constructor(config: ResolverConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("SasResolver: config is required");
    }
    if (!config.rpc) {
      throw new Error("SasResolver: config.rpc is required");
    }
    if (
      !(config.allowedCredentials instanceof Set) &&
      !(config.allowedCredentials instanceof Map)
    ) {
      throw new Error(
        "SasResolver: config.allowedCredentials must be a Set<string> or Map<string, AllowedCredential>",
      );
    }
    if (typeof config.schemaPda !== "string" || !BASE58.test(config.schemaPda)) {
      throw new Error(
        "SasResolver: config.schemaPda must be a base58 pubkey string",
      );
    }
    const sasProgramId = config.sasProgramId ?? DEFAULT_SAS_PROGRAM_ID;
    if (typeof sasProgramId !== "string" || !BASE58.test(sasProgramId)) {
      throw new Error(
        "SasResolver: config.sasProgramId must be a base58 pubkey string",
      );
    }
    this.#rpc = config.rpc;
    this.#allowed = normalizeAllowlist(config.allowedCredentials);
    this.#schemaPda = config.schemaPda;
    this.#sasProgramId = sasProgramId;
    // DEEP-AUDIT-2026-04-22 SEC-15: strict mode defaults ON. Tests that
    // cannot reach an RPC (MockRpc with no getAccountInfo responses for
    // the schema PDA) should set `strict: false` explicitly.
    this.#strict = config.strict ?? true;
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
    this.#cacheNow = config.cacheNow ?? (() => Date.now());
  }

  /**
   * Eager-init factory. Constructs a resolver and immediately runs the
   * strict schema-PDA owner check (ADR-076 §2). Rejects with a
   * `ResolverInitError` if the schema PDA is not owned by
   * `sasProgramId`. Prefer this over `new SasResolver(...)` in
   * production — callers that want to detect a misconfigured schema at
   * boot rather than at the first resolve.
   */
  static async create(config: ResolverConfig): Promise<SasResolver> {
    const r = new SasResolver(config);
    if (r.#strict) {
      await r.#ensureInitialized();
      if (r.#initError) throw r.#initError;
    }
    return r;
  }

  /**
   * Resolve a single agent's SAS-referenced reputation.
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

  /** Evict the cache entry for a specific attestation PDA. */
  async invalidate(attestationPda: string): Promise<void> {
    if (typeof attestationPda !== "string" || attestationPda.length === 0) {
      throw new Error("invalidate: attestationPda must be a non-empty string");
    }
    await this.#cache.delete(attestationCacheKey(attestationPda));
  }

  /** Snapshot of cache hit / miss / eviction counters. */
  cacheMetrics(): CacheMetrics {
    return { ...this.#cacheMetrics };
  }

  // ------------------------------------------------------------------
  // Strict-init — assert schemaPda is owned by sasProgramId.
  // ADR-076 §2, DEEP-AUDIT-2026-04-22 SEC-15.
  // ------------------------------------------------------------------
  /**
   * Run the one-time strict init check. Memoized so parallel
   * `resolve()` calls share a single RPC hit. On success, `#initOk`
   * flips true and subsequent calls short-circuit. On definitive
   * failure (owner mismatch / account missing), `#initError` is stored
   * and every subsequent `resolve()` returns the cached error rather
   * than re-querying — an attacker who flips the schema back to
   * SAS-owned later is still running against a resolver we can't
   * trust. Transport failures do not latch; they bubble so retries
   * are possible.
   */
  async #ensureInitialized(): Promise<void> {
    if (this.#initOk || this.#initError) return;
    if (!this.#initPromise) {
      this.#initPromise = this.#runInit();
    }
    return this.#initPromise;
  }

  async #runInit(): Promise<void> {
    try {
      const info = await this.#fetchAccountInfo(this.#schemaPda);
      if (info === null) {
        this.#initError = new ResolverInitError(
          `SAS schema PDA ${this.#schemaPda} does not exist on-chain`,
          {
            schemaPda: this.#schemaPda,
            expectedOwner: this.#sasProgramId,
            observedOwner: null,
          },
        );
        return;
      }
      if (info.owner !== this.#sasProgramId) {
        this.#initError = new ResolverInitError(
          `SAS schema PDA ${this.#schemaPda} is owned by ${info.owner ?? "<unknown>"}, expected ${this.#sasProgramId} — refusing to trust schema-derived attestations`,
          {
            schemaPda: this.#schemaPda,
            expectedOwner: this.#sasProgramId,
            observedOwner: info.owner ?? null,
          },
        );
        return;
      }
      this.#initOk = true;
    } catch (e) {
      // Transport failures do not poison the init state — reset the
      // promise so the next `resolve()` re-attempts. Only a definitive
      // owner-mismatch (or "account does not exist") latches into
      // `#initError`.
      this.#initPromise = null;
      throw e;
    }
  }

  // ------------------------------------------------------------------
  // Per-entry resolution — ADR-061 §4 rows 4a..4g.
  // ------------------------------------------------------------------
  async #resolveSingle(
    manifest: ManifestLike,
    subjectAuthority: string,
    opts?: ResolveOptions,
  ): Promise<Result<ResolvedReputation>> {
    // Strict-init gate (ADR-076 §2) — runs once per resolver instance.
    if (this.#strict) {
      try {
        await this.#ensureInitialized();
      } catch (e) {
        return err(
          "RESOLVER_INIT",
          e instanceof Error ? e.message : String(e),
          e instanceof ResolverInitError ? e.details : undefined,
        );
      }
      if (this.#initError) {
        return err(
          "RESOLVER_INIT",
          this.#initError.message,
          this.#initError.details,
        );
      }
    }

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
    const entry = this.#allowed.get(credential);
    if (!entry) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} uses non-allowlisted credential — skipping`,
        { credential, allowlist_size: this.#allowed.size },
      );
      return ok({ subject, absent: true });
    }

    // ADR-076 §3 / DEEP-AUDIT SEC-3 / ADR-101: per-credential signer scoping.
    // A credential MUST have an explicit, non-empty signer list. An undefined
    // or empty list is a hard-fail (SignerHistoryMissingError) per ADR-101 —
    // silently bypassing signer validation would allow any signer to mint
    // attestations under this credential, which is a security hole.
    if (!entry.signers || entry.signers.length === 0) {
      throw new SignerHistoryMissingError(entry.authority ?? "unknown");
    }
    if (!entry.signers.includes(signer)) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} signed by signer outside the credential's scoped signer list — skipping`,
        { credential, signer, allowed_signers: entry.signers.length },
      );
      return ok({ subject, absent: true });
    }

    // ADR-076 §3 / DEEP-AUDIT SEC-3: per-credential schema binding. If
    // the allowlist entry binds this credential to a specific schema
    // set, the attestation's schema MUST be in it for THAT credential
    // (defense-in-depth against a legitimate credential being reused
    // under a foreign schema). Missing `authorizedSchemas` means
    // "any schema this resolver accepts under this credential".
    if (entry.authorizedSchemas && !entry.authorizedSchemas.includes(schema)) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} uses a schema not authorized for this credential — skipping`,
        {
          credential,
          schema,
          authorized_schema_count: entry.authorizedSchemas.length,
        },
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

    // Row 4e — expired -> absent + stale.
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
   * first (ADR-065 §3).
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
          if (cached.value === null) return null;
          return base64Decode(cached.value.bytesB64);
        }
        this.#cacheMetrics.misses++;
      } else {
        this.#cacheMetrics.misses++;
      }
    }
    if (maxAge === 0) this.#cacheMetrics.misses++;

    const bytes = await this.#fetchAccountData(pubkey);

    const payload: CachedAttestationBytes | null =
      bytes === null ? null : { bytesB64: base64Encode(bytes) };
    await this.#cache.set(key, payload, this.#ttl.attestation);

    return bytes;
  }

  /**
   * Fetch an account's full info (for owner check in strict init).
   * Returns `null` if the account does not exist. Throws on
   * RPC-transport failure.
   */
  async #fetchAccountInfo(
    pubkey: string,
  ): Promise<AccountInfoResponse | null> {
    const rpc = this.#rpc as {
      getAccountInfo: (addr: unknown, opts?: unknown) => { send(): Promise<unknown> };
    };
    const result = (await rpc.getAccountInfo(pubkey, { encoding: "base64" }).send()) as {
      value: AccountInfoResponse | null;
    } | null;
    if (!result || result.value === null || result.value === undefined) {
      return null;
    }
    return result.value;
  }

  /**
   * Fetch an account's raw data bytes. Returns `null` if the account
   * does not exist. Throws on RPC-transport failure.
   */
  async #fetchAccountData(pubkey: string): Promise<Uint8Array | null> {
    const info = await this.#fetchAccountInfo(pubkey);
    if (info === null) return null;
    return decodeAccountData(info.data);
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
    return base58Decode(data);
  }
  throw new Error("unrecognized account data shape");
}

// --------------------------------------------------------------------
// Base58 / base64 codec helpers. Internal to the resolver — previously
// exported via `src/index.ts`, demoted in v0.1.0 (DEEP-AUDIT-2026-04-22
// Audit 2 blocker #1). Test fixtures that need these should use the
// helpers in `test/fixtures.ts`, which wrap these same functions.
// --------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function encodeBase58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

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
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
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

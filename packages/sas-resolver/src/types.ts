// ADR-064 @agenomics/sas-resolver — public type surface.
//
// Kept in a separate module so consumers can type-annotate without
// dragging in the runtime code (schema decoders, resolver class).
//
// ADR-061 §4 defines the resolution flow; these types mirror the
// structure of its success + failure signals. The resolver treats
// failures asymmetrically (§4 failure-mode table):
//   - Most step-4 failures degrade to `absent: true` (no signal).
//   - Subject mismatch (4f) is a HARD error — never silently papered over.

import type { Rpc, SolanaRpcApi } from "@solana/kit";
import type { CacheBackend } from "./cache.js";

/**
 * Minimal RPC surface the resolver uses. We accept the full
 * `@solana/kit` `Rpc<SolanaRpcApi>` but the resolver only ever calls
 * `getAccountInfo`; constraining the type here documents that and makes
 * the mock shim in tests trivial.
 */
export type ResolverRpc = Rpc<Pick<SolanaRpcApi, "getAccountInfo">> | Rpc<SolanaRpcApi>;

/**
 * Configuration for a `SasResolver` instance.
 *
 * Per ADR-061 §3, the allowlist is consumer-owned. The v1 AEP-published
 * defaults are `AEP_PROTOCOL` and `AEP_VALIDATORS` — but this package
 * does not hardcode them; consumers pass whichever credentials they
 * trust. `packages/sas-resolver/src/allowlist.ts` exposes helpers for
 * building and validating allowlists.
 */
export interface ResolverConfig {
  /** @solana/kit RPC client (from `createSolanaRpc(url)`). */
  rpc: ResolverRpc;
  /** Base58 pubkeys of credential authorities a caller trusts. */
  allowedCredentials: Set<string>;
  /** Base58 pubkey of the AEP_AGENT_REPUTATION_v1 schema PDA. */
  schemaPda: string;
  /** Test hook — defaults to `() => Math.floor(Date.now() / 1000)` (unix seconds). */
  now?: () => number;
  /**
   * Test hook — cache-freshness wall clock in **milliseconds**. Defaults
   * to `Date.now`. Kept separate from `now` because the resolver's
   * stale-by-age math runs in seconds (matches SAS on-chain expiry
   * fields) while the cache primitive runs in ms (matches `Date.now`
   * and `setTimeout`'s ms semantics per ADR-065 §5). Production callers
   * should leave both unset.
   */
  cacheNow?: () => number;
  /**
   * Optional override for console.warn — tests swap this to capture
   * warn messages without polluting test output. Defaults to
   * `console.warn.bind(console)`.
   */
  warn?: (message: string, details?: unknown) => void;
  /**
   * Cache backend used for the SAS-layer fetches this resolver makes
   * (attestation / schema / credential). Defaults to a fresh
   * `InMemoryCache`. Pass a `RedisCache` / `LayeredCache` for
   * multi-instance deployments. See ADR-065 §3.
   *
   * Note: Registry (`AgentProfile`) and manifest-body caching are out
   * of scope for this resolver — the caller passes an already-validated
   * manifest. Both layers live in follow-up PRs.
   */
  cache?: CacheBackend;
  /**
   * Per-layer TTLs (milliseconds). Defaults from ADR-065 §1:
   *   - `registry`     → 30 000       (30s; reserved for future use)
   *   - `manifest`     → 86 400 000   (24h; reserved for future use)
   *   - `attestation`  → 300 000      (5m)
   *   - `schema`       → 3 600 000    (1h)
   *   - `credential`   → 3 600 000    (1h)
   *
   * `registry` and `manifest` slots are present for forward-compat —
   * the resolver does not fetch either layer today.
   */
  ttl?: ResolverTtlConfig;
}

/**
 * Cache TTLs per ADR-065 §1. All values in milliseconds. Any field left
 * undefined falls back to the ADR default.
 */
export interface ResolverTtlConfig {
  /** Reserved — Registry caching is a follow-up PR. Default 30 000 ms. */
  registry?: number;
  /** Reserved — manifest-body caching is a follow-up PR. Default 86 400 000 ms. */
  manifest?: number;
  /** Default 300 000 ms (5 m). Mutable layer; ADR-061 §6 tolerates bounded staleness. */
  attestation?: number;
  /** Default 3 600 000 ms (1 h). Effectively immutable — new schema versions are new PDAs. */
  schema?: number;
  /** Default 3 600 000 ms (1 h). ADR-063 governance cadence is weeks-to-months. */
  credential?: number;
}

/**
 * Per-call cache-policy override (ADR-065 §5 "Staleness surfaces").
 *
 *   resolve(manifest, subj)                       // respect TTL (default)
 *   resolve(manifest, subj, { maxAge: 0 })        // force fresh
 *   resolve(manifest, subj, { maxAge: 5_000 })    // tighter than TTL
 *
 * Protocol-logic consumers (reputation gates, dispute eligibility) MUST
 * pass `maxAge: 0` for authoritative reads — see ADR-065 "Consequences
 * → Negative".
 */
export interface ResolveOptions {
  /**
   * "No data older than this, in milliseconds." If the cached entry's
   * `now - cachedAt > maxAge`, the resolver bypasses the cache and
   * hits the RPC. `maxAge: 0` is the canonical "give me a fresh read"
   * signal.
   */
  maxAge?: number;
}

/**
 * Decoded AEP_AGENT_REPUTATION_v1 payload (ADR-061 §2).
 *
 * All fields come straight from `attestation.data` except `signer`,
 * `credential`, and `expiry` which come from the attestation account
 * header.
 */
export interface AttestationReputation {
  /** 0..10000 basis points — normalized reputation score. */
  score: number;
  /** Count of successfully completed tasks observed by the signer. */
  completed_tasks: number;
  /** Disputes / total tasks in basis points (0..10000). */
  dispute_ratio_bps: number;
  /** Unix timestamp (seconds) of observation window end. */
  last_updated: number;
  /** Attestation signer pubkey (base58). */
  signer: string;
  /** Credential authority pubkey (base58). */
  credential: string;
  /** Optional unix expiry (seconds). ADR-061 §6: expired -> absent. */
  expiry?: number;
}

/**
 * Raw on-chain Solana attestation account (ADR-061 §4 step 4b+). This
 * is the decoded header + data slice fetched from the RPC; it is the
 * input to the `parseReputationData` and verification checks in the
 * resolution flow.
 */
export interface SolanaAttestation {
  /** Attestation PDA (base58). */
  pubkey: string;
  /** Schema PDA referenced by this attestation (base58). */
  schema: string;
  /** Credential PDA (base58). */
  credential: string;
  /** Signer pubkey (base58). */
  signer: string;
  /** Subject pubkey (base58) — the agent authority the claim is about. */
  subject: string;
  /** Nonce byte (per-credential unique). */
  nonce: string;
  /** Unix expiry (seconds); 0 means "no expiry". */
  expiry: number;
  /** Raw typed data bytes per the schema. */
  data: Uint8Array;
}

/**
 * The resolver's return value for a single agent lookup (ADR-061 §4
 * merge semantics). Callers display `attestation` side-by-side with
 * Registry state (§4 UI convention), never summed. `absent` and
 * `stale` are advisory UX flags.
 */
export interface ResolvedReputation {
  /** Agent authority pubkey (base58) the caller asked about. */
  subject: string;
  /** Decoded attestation signal, if one is present and valid. */
  attestation?: AttestationReputation;
  /**
   * True if no signal is available — either because the manifest did
   * not reference an attestation (§4 step 4a), the account is missing
   * (4b), schema/credential mismatch (4c–d), expiry (4e), or data
   * parse failure (4g). Consumers should treat this as "no SAS signal"
   * rather than "failure".
   */
  absent?: boolean;
  /**
   * True if the attestation was expired or `last_updated` is older
   * than the staleness threshold (90 days per ADR-061 §6). Resolver
   * surfaces `stale: true` alongside `absent: true` for the expiry
   * case so UX can distinguish "expired" from "never attested".
   */
  stale?: boolean;
}

/**
 * Resolver error codes. Only `SUBJECT_MISMATCH` is propagated as a
 * hard error from the §4 flow; the rest cover invalid input, config,
 * or RPC-layer failures the caller should know about.
 */
export type ResolverErrorCode =
  | "SUBJECT_MISMATCH"
  | "INVALID_INPUT"
  | "INVALID_CONFIG"
  | "RPC_ERROR";

export interface ResolverError {
  code: ResolverErrorCode;
  message: string;
  /** Structured context — e.g. the observed vs expected subject. */
  details?: unknown;
}

/** Lightweight Result type; mirrors `@agenomics/capability-manifest-validator`. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ResolverError };

/**
 * Shape the resolver consumes for manifests. We deliberately do not
 * re-declare the full `CapabilityManifest` interface — consumers pass
 * in whatever shape they have. Only the fields below are read.
 */
export interface ManifestLike {
  agent: {
    pubkey: string;
    owner_attestation?: string;
  };
}

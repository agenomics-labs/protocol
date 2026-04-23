// ADR-064 @agenomics/sas-resolver — public entry point.
//
// Consumers should import from the root:
//   import { SasResolver, buildAllowlist } from "@agenomics/sas-resolver";
//
// ADR-061 §4 resolution flow + §2 schema + §3 credential allowlist
// semantics + §4 merge convention helpers are all surfaced from this
// one file. v0.1.0 collapses the surface to a single `.` export plus
// `./cache-redis` for callers that want to wire Redis without pulling
// in the lazy env factory (see `package.json` "exports").
//
// Notes on removed symbols (DEEP-AUDIT-2026-04-22.md Audit 2):
//   - Base58/base64 codecs (`encodeBase58`, `base58Decode`,
//     `base64Decode`, `base64Encode`) were exported as implementation
//     details of the RPC decoder. They are now private to the resolver;
//     test fixtures that need them live in `test/fixtures.ts`.
//   - `encodeReputationData` and `encodeAttestationAccount` were only
//     ever used by the test harness; they have moved to
//     `test/fixtures.ts` for producer-side round-trip tests.
//   - `ReputationDataFields` and `RawAttestationAccount` exposed on-chain
//     byte layout as public type shapes; they are now internal to
//     `./schema.ts`. The public contract is `AttestationReputation`.

export { SasResolver, ResolverInitError } from "./resolver.js";

export {
  InMemoryCache,
  LayeredCache,
  createCache,
  activeCacheBackend,
  type CacheBackend,
  type CacheMetrics,
  type InMemoryCacheOptions,
} from "./cache.js";

export {
  RedisCache,
  type RedisCacheOptions,
  type RedisClient,
} from "./cache-redis.js";

export {
  AEP_AGENT_REPUTATION_V1_SIZE,
  parseReputationData,
  toAttestationReputation,
  parseAttestationAccount,
} from "./schema.js";

export {
  buildAllowlist,
  isAllowed,
  normalizeAllowlist,
  type AllowlistEntry,
} from "./allowlist.js";

export {
  detectDisagreement,
  renderSideBySide,
  scoreFreshness,
  type RegistryReputationView,
  type Freshness,
} from "./merge.js";

export type {
  ResolverConfig,
  ResolverRpc,
  ResolverTtlConfig,
  ResolveOptions,
  ResolvedReputation,
  SolanaAttestation,
  AttestationReputation,
  AllowedCredential,
  ResolverError,
  ResolverErrorCode,
  KnownResolverErrorCode,
  ManifestLike,
  Result,
} from "./types.js";

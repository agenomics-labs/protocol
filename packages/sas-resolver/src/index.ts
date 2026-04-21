// ADR-064 @aeap/sas-resolver — public entry point.
//
// Consumers should import from the root:
//   import { SasResolver, buildAllowlist } from "@aeap/sas-resolver";
//
// ADR-061 §4 resolution flow + §2 schema + §3 credential allowlist
// semantics + §4 merge convention helpers are all surfaced from this
// one file. Submodule entry points (./resolver, ./schema, ./allowlist,
// ./merge, ./types) are also available if the consumer wants to
// import a narrower subset (reduces TS program size in large trees).

export {
  SasResolver,
  encodeBase58,
  base58Decode,
  base64Decode,
  base64Encode,
} from "./resolver.js";

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
  AEAP_AGENT_REPUTATION_V1_SIZE,
  parseReputationData,
  toAttestationReputation,
  parseAttestationAccount,
  encodeReputationData,
  encodeAttestationAccount,
  type ReputationDataFields,
  type RawAttestationAccount,
} from "./schema.js";

export { buildAllowlist, isAllowed, type AllowlistEntry } from "./allowlist.js";

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
  ResolverError,
  ResolverErrorCode,
  ManifestLike,
  Result,
} from "./types.js";

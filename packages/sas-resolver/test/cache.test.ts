// ADR-065 — cache behavioral tests.
//
// Runs under Node's built-in test runner (`node:test`) via `tsx` —
// same pattern as `resolver.test.ts` and friends. Covers the
// `InMemoryCache` / `LayeredCache` primitives, the resolver wiring
// (`maxAge`, `invalidate`, `cacheMetrics`), the env-driven factory,
// and the Redis backend via `ioredis-mock`.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  InMemoryCache,
  LayeredCache,
  createCache,
  SasResolver,
  RedisCache,
  encodeAttestationAccount,
  encodeReputationData,
  encodeBase58,
  base58Decode,
  buildAllowlist,
  type CacheBackend,
} from "../src/index.js";

// `ioredis-mock` is a CJS module; bridge it into ESM via createRequire.
const require = createRequire(import.meta.url);
const RedisMock = require("ioredis-mock") as new () => {
  set: (...args: unknown[]) => Promise<unknown>;
  get: (k: string) => Promise<string | null>;
  del: (...k: string[]) => Promise<number>;
  flushall: () => Promise<"OK">;
};

// ------------------------------------------------------------------
// Fixtures — minimal, just enough for the resolver cache path.
// ------------------------------------------------------------------

function pubkey(fillByte: number): string {
  const bytes = new Uint8Array(32).fill(fillByte);
  return encodeBase58(bytes);
}

const SUBJECT_AUTHORITY = pubkey(0x11);
const SCHEMA_PDA = pubkey(0x33);
const ALLOWED_CREDENTIAL = pubkey(0x55);
const SIGNER = pubkey(0x77);
const NONCE = pubkey(0x88);
const ATTESTATION_ADDR = pubkey(0x99);

const NOW_SECONDS = 1_700_000_000;

function manifest(opts: { owner_attestation?: string } = {}): {
  agent: { pubkey: string; owner_attestation?: string };
} {
  return {
    agent: {
      pubkey: SUBJECT_AUTHORITY,
      ...(opts.owner_attestation ? { owner_attestation: opts.owner_attestation } : {}),
    },
  };
}

function makeAttestation(opts: { last_updated?: number } = {}): Uint8Array {
  const data = encodeReputationData({
    score: 8600,
    completed_tasks: 118,
    dispute_ratio_bps: 150,
    last_updated: opts.last_updated ?? NOW_SECONDS - 7 * 86_400,
  });
  return encodeAttestationAccount({
    nonce: base58Decode(NONCE),
    credential: base58Decode(ALLOWED_CREDENTIAL),
    schema: base58Decode(SCHEMA_PDA),
    subject: base58Decode(SUBJECT_AUTHORITY),
    signer: base58Decode(SIGNER),
    expiry: 0,
    data,
  });
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Mock RPC — canned responses keyed by address. Records call count. */
class MockRpc {
  readonly responses = new Map<string, Uint8Array | null>();
  readonly calls: string[] = [];

  set(addr: string, bytes: Uint8Array | null): void {
    this.responses.set(addr, bytes);
  }

  getAccountInfo(addr: unknown): { send(): Promise<unknown> } {
    const addrStr = String(addr);
    this.calls.push(addrStr);
    const bytes = this.responses.get(addrStr) ?? null;
    return {
      send: async () => {
        if (bytes === null) return { value: null };
        return { value: { data: [b64(bytes), "base64"] as const } };
      },
    };
  }
}

function makeResolver(
  rpc: MockRpc,
  opts: {
    cache?: CacheBackend;
    ttl?: { attestation?: number };
    now?: () => number;
    cacheNow?: () => number;
  } = {},
): SasResolver {
  return new SasResolver({
    rpc: rpc as unknown as import("../src/types.js").ResolverRpc,
    allowedCredentials: buildAllowlist([ALLOWED_CREDENTIAL]),
    schemaPda: SCHEMA_PDA,
    now: opts.now ?? (() => NOW_SECONDS),
    warn: () => {},
    ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
    ...(opts.ttl !== undefined ? { ttl: opts.ttl } : {}),
    ...(opts.cacheNow !== undefined ? { cacheNow: opts.cacheNow } : {}),
  });
}

// ------------------------------------------------------------------
// InMemoryCache
// ------------------------------------------------------------------

describe("ADR-065 InMemoryCache", () => {
  it("set then get returns value within TTL", async () => {
    const cache = new InMemoryCache({ now: () => 1_000 });
    await cache.set("k1", { payload: "hello" }, 5_000);
    const hit = await cache.get<{ payload: string }>("k1");
    assert.ok(hit, "expected hit");
    assert.equal(hit!.value.payload, "hello");
    assert.equal(hit!.cachedAt, 1_000);
  });

  it("get returns null after TTL expires (injected clock)", async () => {
    let t = 1_000;
    const cache = new InMemoryCache({ now: () => t });
    await cache.set("k1", "v", 5_000);

    // 1s in — still fresh.
    t = 2_000;
    const mid = await cache.get<string>("k1");
    assert.ok(mid);

    // 6s in — expired.
    t = 7_001;
    const late = await cache.get<string>("k1");
    assert.equal(late, null);

    const metrics = cache.metrics();
    assert.equal(metrics.hits, 1);
    assert.equal(metrics.misses, 1);
    // Lazy-expiry eviction shows up as 1.
    assert.ok(metrics.evictions >= 1);
  });

  it("evicts LRU when maxEntries exceeded", async () => {
    const cache = new InMemoryCache({ maxEntries: 3, now: () => 1 });

    await cache.set("a", 1, 60_000);
    await cache.set("b", 2, 60_000);
    await cache.set("c", 3, 60_000);

    // Touch 'a' so it becomes most-recently-used.
    await cache.get("a");

    // Overflow → 'b' (now the LRU) should go.
    await cache.set("d", 4, 60_000);

    assert.ok(await cache.get("a"), "a should still be present (was touched)");
    assert.equal(await cache.get("b"), null, "b should have been evicted");
    assert.ok(await cache.get("c"));
    assert.ok(await cache.get("d"));
    assert.ok(cache.metrics().evictions >= 1);
  });

  it("delete removes the entry and subsequent get misses", async () => {
    const cache = new InMemoryCache({ now: () => 1 });
    await cache.set("k", "v", 60_000);
    await cache.delete("k");
    assert.equal(await cache.get("k"), null);
  });

  it("ttlMs <= 0 is treated as delete (no slot consumed)", async () => {
    const cache = new InMemoryCache({ now: () => 1 });
    await cache.set("k", "v", 0);
    assert.equal(await cache.get("k"), null);
    assert.equal(cache.size(), 0);
  });

  it("CacheMetrics increments correctly across hits and misses", async () => {
    const cache = new InMemoryCache({ now: () => 1 });
    await cache.set("k", "v", 60_000);
    await cache.get("k"); // hit
    await cache.get("k"); // hit
    await cache.get("missing"); // miss

    const m = cache.metrics();
    assert.equal(m.hits, 2);
    assert.equal(m.misses, 1);
  });
});

// ------------------------------------------------------------------
// LayeredCache
// ------------------------------------------------------------------

describe("ADR-065 LayeredCache", () => {
  it("hit on L1 does not touch L2", async () => {
    const l1 = new InMemoryCache({ now: () => 1 });
    const l2Calls: string[] = [];
    const l2: CacheBackend = {
      async get(k) {
        l2Calls.push(`get:${k}`);
        return null;
      },
      async set(k) { l2Calls.push(`set:${k}`); },
      async delete(k) { l2Calls.push(`del:${k}`); },
    };

    const layered = new LayeredCache([l1, l2]);
    await layered.set("k", "v", 60_000);
    // Clear the set log — we only care about read behavior.
    l2Calls.length = 0;

    const hit = await layered.get("k");
    assert.ok(hit);
    assert.deepEqual(l2Calls, [], "L2 should not be read when L1 hits");
  });

  it("miss on L1 populates from L2 to L1", async () => {
    const l1 = new InMemoryCache({ now: () => 1 });
    const l2 = new InMemoryCache({ now: () => 1 });
    await l2.set("k", "from-L2", 60_000);

    const layered = new LayeredCache([l1, l2]);
    const hit = await layered.get<string>("k");
    assert.ok(hit);
    assert.equal(hit!.value, "from-L2");

    // L1 should now have the entry — confirm by reading l1 directly.
    const l1Hit = await l1.get<string>("k");
    assert.ok(l1Hit, "expected L2 hit to back-fill L1");
    assert.equal(l1Hit!.value, "from-L2");
  });

  it("set fans out to all layers", async () => {
    const l1 = new InMemoryCache({ now: () => 1 });
    const l2 = new InMemoryCache({ now: () => 1 });

    const layered = new LayeredCache([l1, l2]);
    await layered.set("k", "v", 60_000);

    assert.ok(await l1.get("k"));
    assert.ok(await l2.get("k"));
  });

  it("delete propagates to every layer", async () => {
    const l1 = new InMemoryCache({ now: () => 1 });
    const l2 = new InMemoryCache({ now: () => 1 });
    const layered = new LayeredCache([l1, l2]);
    await layered.set("k", "v", 60_000);
    await layered.delete("k");
    assert.equal(await l1.get("k"), null);
    assert.equal(await l2.get("k"), null);
  });
});

// ------------------------------------------------------------------
// Resolver integration — maxAge / invalidate / cacheMetrics
// ------------------------------------------------------------------

describe("ADR-065 SasResolver cache integration", () => {
  it("reads cached attestation on second call (single RPC fetch)", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, makeAttestation());
    const resolver = makeResolver(rpc);

    const r1 = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(r1.ok, true);
    assert.equal(rpc.calls.length, 1);

    const r2 = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(r2.ok, true);
    assert.equal(rpc.calls.length, 1, "second call should hit the cache");

    const m = resolver.cacheMetrics();
    assert.equal(m.hits, 1);
    assert.equal(m.misses, 1);
  });

  it("maxAge: 0 bypasses cache (verify by RPC call counter)", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, makeAttestation());
    const resolver = makeResolver(rpc);

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 1);

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
      { maxAge: 0 },
    );
    assert.equal(rpc.calls.length, 2, "maxAge: 0 should force a fresh RPC");

    const m = resolver.cacheMetrics();
    // First call: miss+set. Second call: bypass → miss counted for RPC, no hit.
    assert.equal(m.hits, 0);
    assert.equal(m.misses, 2);
  });

  it("maxAge > 0 uses cache iff entry is fresher than maxAge", async () => {
    // Drive the cache clock explicitly via `cacheNow` (ms). Keep the
    // resolver's seconds clock frozen so the attestation's
    // stale-by-age check is independent of the cache-freshness test.
    let cacheMs = 1_700_000_000_000;
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, makeAttestation());
    const cache = new InMemoryCache({ now: () => cacheMs });
    const resolver = makeResolver(rpc, { cache, cacheNow: () => cacheMs });

    // Prime the cache.
    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 1);

    // Advance 2s. maxAge 5s → entry is fresh enough.
    cacheMs += 2_000;
    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
      { maxAge: 5_000 },
    );
    assert.equal(rpc.calls.length, 1, "still a cache hit within maxAge");

    // Advance further. Entry is now 10s old; maxAge 5s → refetch.
    cacheMs += 8_000;
    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
      { maxAge: 5_000 },
    );
    assert.equal(rpc.calls.length, 2, "entry older than maxAge should refetch");
  });

  it("invalidate(pda) forces refetch on the next call", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, makeAttestation());
    const resolver = makeResolver(rpc);

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 1);

    await resolver.invalidate(ATTESTATION_ADDR);

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 2, "invalidate should clear the entry");
  });

  it("negative cache — row 4b 'absent' is also cached", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, null); // account does not exist
    const resolver = makeResolver(rpc);

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    assert.equal(
      rpc.calls.length,
      1,
      "second 'absent' lookup should hit the negative cache",
    );
  });

  it("attestation TTL expiry triggers a refetch after enough time", async () => {
    let cacheMs = 1_700_000_000_000;
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, makeAttestation());
    // Inject an InMemoryCache whose clock we drive.
    const cache = new InMemoryCache({ now: () => cacheMs });
    // Short TTL so we can advance past it.
    const resolver = makeResolver(rpc, {
      cache,
      cacheNow: () => cacheMs,
      ttl: { attestation: 1_000 },
    });

    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 1);

    // Advance past the 1s TTL — cache backend lazy-expiry kicks in.
    cacheMs += 2_000;
    await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );
    assert.equal(rpc.calls.length, 2, "TTL-expired entry should refetch");
  });
});

// ------------------------------------------------------------------
// Factory
// ------------------------------------------------------------------

describe("ADR-065 createCache() factory", () => {
  it("returns InMemoryCache by default (no AEAP_REDIS_URL)", () => {
    const c = createCache({});
    assert.ok(c instanceof InMemoryCache);
  });

  it("env detection — activeCacheBackend reports the selected backend", async () => {
    // The real factory lazy-requires `ioredis`, which would try a live
    // connection. We verify the env detection via the helper
    // `activeCacheBackend` instead of standing up a real Redis.
    const { activeCacheBackend } = await import("../src/cache.js");
    assert.equal(activeCacheBackend({}), "memory");
    assert.equal(
      activeCacheBackend({ AEAP_REDIS_URL: "redis://localhost:6379" }),
      "redis",
    );
  });
});

// ------------------------------------------------------------------
// RedisCache — ioredis-mock
// ------------------------------------------------------------------

describe("ADR-065 RedisCache via ioredis-mock", () => {
  it("set / get / delete round-trip", async () => {
    const client = new RedisMock();
    const cache = new RedisCache({ client: client as unknown as import("../src/cache-redis.js").RedisClient });

    await cache.set("k1", { hello: "world" }, 60_000);
    const hit = await cache.get<{ hello: string }>("k1");
    assert.ok(hit);
    assert.equal(hit!.value.hello, "world");
    assert.ok(typeof hit!.cachedAt === "number");

    await cache.delete("k1");
    assert.equal(await cache.get("k1"), null);
  });

  it("applies the aeap:cache: prefix by default", async () => {
    const client = new RedisMock();
    const cache = new RedisCache({ client: client as unknown as import("../src/cache-redis.js").RedisClient });
    await cache.set("foo", "bar", 60_000);

    // Peek at raw key — should be prefixed.
    const raw = await client.get("aeap:cache:foo");
    assert.ok(raw !== null, "expected prefixed key to exist");
    assert.equal(await client.get("foo"), null, "unprefixed key should not exist");
  });

  it("malformed payload surfaces as miss (not a throw)", async () => {
    const client = new RedisMock();
    // Inject a non-JSON value under the prefixed key.
    await client.set("aeap:cache:bogus", "not-json{");
    const cache = new RedisCache({ client: client as unknown as import("../src/cache-redis.js").RedisClient });

    const hit = await cache.get("bogus");
    assert.equal(hit, null);
  });

  it("custom prefix is respected", async () => {
    const client = new RedisMock();
    const cache = new RedisCache({
      client: client as unknown as import("../src/cache-redis.js").RedisClient,
      prefix: "test:",
    });
    await cache.set("k", "v", 60_000);
    assert.ok(await client.get("test:k"));
  });
});

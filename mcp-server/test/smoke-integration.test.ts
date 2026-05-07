/**
 * Mocked-RPC smoke integration tests for the off-chain stack (no network,
 * no keys). Runs under `node --import tsx --test` alongside the existing
 * pipeline.test.ts / action-shape.test.ts harness.
 *
 * Scope:
 *   - @agenomics/capability-manifest-validator round-trips: valid / hash /
 *     sig / schema-invalid / input-shape.
 *   - @agenomics/sas-resolver: ADR-061 §4 failure-mode table rows 4a..4g,
 *     each one test, against a hand-built Kit RPC stub.
 *   - Cache behaviour: repeat resolve() collapses to one RPC hit; `maxAge:0`
 *     bypasses; metrics count hits vs misses.
 *   - Composed validator + resolver: back-to-back, proves the merged error
 *     surface lines up with what `handleGetAgentReputation` does at runtime.
 *
 * Both @agenomics/* packages are ESM. Under ADR-091 (mcp-server moved to
 * NodeNext) plain dynamic `await import(...)` resolves them — the prior
 * `new Function("s", "return import(s);")` shim has been removed.
 */

import { describe, it, before } from "node:test";
import * as assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  encodeBase58,
  base58Decode,
  base64Encode,
  encodeReputationData,
  encodeAttestationAccount,
} from "./test-fixtures.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dyn = any;
let V: Dyn; // capability-manifest-validator
let R: Dyn; // sas-resolver
let SCHEMA_URL: string;

before(async () => {
  V = await import("@agenomics/capability-manifest-validator");
  R = await import("@agenomics/sas-resolver");
  SCHEMA_URL = V.MANIFEST_SCHEMA_V1_URL;
});

// ==========================================================================
// Helpers
// ==========================================================================

function makeManifest(agentPubkey: string, name: string, ownerAttestation?: string): any {
  return {
    $schema: SCHEMA_URL,
    version: "1.0",
    agent: { pubkey: agentPubkey, name, ...(ownerAttestation ? { owner_attestation: ownerAttestation } : {}) },
    agent_version: "0.1.0",
    capabilities: [{
      name: "smoke-test",
      description: "integration smoke capability",
      input_schema: { type: "object" }, output_schema: { type: "object" },
      required_capabilities: [], side_effects: ["read-onchain"], stability: "experimental",
    }],
    published_at: "2026-04-21T00:00:00.000Z",
  };
}

function sign(kp: Keypair, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, kp.secretKey.slice(0, 32));
}

/** Deterministic 32-byte "random" from a seed — used for pubkeys/nonces. */
function rand32(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7 + 11) & 0xff;
  return out;
}

/**
 * Hand-built Kit RPC. Only `getAccountInfo(...).send()` is called by the
 * resolver. `state.callCount` lets cache tests assert "N RPC calls" exactly.
 */
function mockRpc(map: Map<string, Uint8Array | null>) {
  const state = { callCount: 0 };
  const rpc = {
    getAccountInfo(addr: unknown, _opts: unknown) {
      return {
        async send() {
          state.callCount++;
          const bytes = map.get(String(addr));
          if (bytes === undefined || bytes === null) return { value: null };
          return { value: { data: [base64Encode(bytes), "base64" as const] } };
        },
      };
    },
  };
  return { rpc: rpc as any, state };
}

interface AttArgs {
  schemaPda: string; credential: string; signer: string; subject: string;
  expiry?: number;
  data?: { score: number; completed_tasks: number; dispute_ratio_bps: number; last_updated: number };
}
function buildAtt(a: AttArgs): Uint8Array {
  const data = encodeReputationData(
    a.data ?? { score: 8500, completed_tasks: 42, dispute_ratio_bps: 50, last_updated: Math.floor(Date.now() / 1000) },
  );
  // SAS attestation accounts have no on-chain `subject` field — per
  // ADR-061 §2, the subject is encoded as the `nonce`. Drive the
  // resolver's SUBJECT_MISMATCH check via the nonce here.
  return encodeAttestationAccount({
    nonce: base58Decode(a.subject),
    credential: base58Decode(a.credential),
    schema: base58Decode(a.schemaPda),
    signer: base58Decode(a.signer),
    expiry: a.expiry ?? 0,
    data,
  });
}

/** Shared SAS "environment" — schema PDA, allowlisted credential, untrusted one. */
function sasEnv() {
  return {
    SCHEMA: encodeBase58(rand32(101)),
    CRED_OK: encodeBase58(rand32(102)),
    CRED_UNTRUSTED: encodeBase58(rand32(103)),
    SIGNER: encodeBase58(rand32(104)),
  };
}

function makeResolver(
  map: Map<string, Uint8Array | null>,
  env: ReturnType<typeof sasEnv>,
  opts?: { nowSecs?: number },
) {
  const { rpc, state } = mockRpc(map);
  const resolver = new R.SasResolver({
    rpc,
    allowedCredentials: R.buildAllowlist([{ authority: env.CRED_OK, signers: [env.SIGNER] }]),
    schemaPda: env.SCHEMA,
    // Smoke mocks never canned-respond for the schema PDA owner check
    // (ADR-076 §2). The resolver unit tests cover strict init directly;
    // here we opt out so the existing §4 failure-mode rows still run.
    strict: false,
    now: () => opts?.nowSecs ?? Math.floor(Date.now() / 1000),
    warn: () => void 0,
  });
  return { resolver, state };
}

// ==========================================================================
// 1. Validator round-trips
// ==========================================================================

describe("smoke/integration: capability-manifest-validator", () => {
  it("valid manifest → ok:true with parsed fields", () => {
    const agent = Keypair.generate();
    const m = makeManifest(agent.publicKey.toBase58(), "AgentA");
    const hash = V.manifestHash(m);
    // ADR-092 (commit a16c8a1): signature must be over taggedManifestHash(rawHash),
    // not the raw hash. The on-chain registry stores/verifies tagged_hash, so the
    // off-chain validator does the same. Signing over raw_hash now yields
    // SIGNATURE_MISMATCH — by design, as a cross-protocol replay defense.
    const taggedHash = V.taggedManifestHash(hash);
    const res = V.validateManifest({
      manifest: m, onChainHash: hash, onChainSignature: sign(agent, taggedHash),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.version, "1.0");
      assert.equal(res.value.agent.name, "AgentA");
    }
  });

  it("hash mismatch → HASH_MISMATCH", () => {
    const agent = Keypair.generate();
    const m = makeManifest(agent.publicKey.toBase58(), "A");
    const hash = V.manifestHash(m);
    const bogus = new Uint8Array(hash); bogus[0] ^= 0xff;
    const res = V.validateManifest({
      manifest: m, onChainHash: bogus, onChainSignature: sign(agent, hash),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "HASH_MISMATCH");
  });

  it("signature mismatch → SIGNATURE_MISMATCH", () => {
    const agent = Keypair.generate();
    const imposter = Keypair.generate();
    const m = makeManifest(agent.publicKey.toBase58(), "A");
    const hash = V.manifestHash(m);
    const res = V.validateManifest({
      manifest: m, onChainHash: hash, onChainSignature: sign(imposter, hash),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "SIGNATURE_MISMATCH");
  });

  it("schema-invalid ($schema wrong URL) → SCHEMA_INVALID", () => {
    const agent = Keypair.generate();
    const bad = { ...makeManifest(agent.publicKey.toBase58(), "A"), $schema: "nope" };
    const hash = V.manifestHash(bad);
    const res = V.validateManifest({
      manifest: bad, onChainHash: hash, onChainSignature: sign(agent, hash),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "SCHEMA_INVALID");
  });

  it("short hash buffer → INVALID_INPUT (boundary guard)", () => {
    const agent = Keypair.generate();
    const m = makeManifest(agent.publicKey.toBase58(), "A");
    const res = V.validateManifest({
      manifest: m, onChainHash: new Uint8Array(16), onChainSignature: new Uint8Array(64),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "INVALID_INPUT");
  });

  it("canonicalBytes round-trips to canonicalJson exactly", () => {
    const m = makeManifest(Keypair.generate().publicKey.toBase58(), "X");
    assert.equal(new TextDecoder().decode(V.unstable_canonicalBytes(m)), V.unstable_canonicalJson(m));
  });
});

// ==========================================================================
// 2. SasResolver — ADR-061 §4 failure modes
// ==========================================================================

describe("smoke/integration: SasResolver ADR-061 §4 failure modes", () => {
  it("HAPPY: attestation fields surfaced with score / credential / signer", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(200));
    const now = 1_900_000_000;
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
      data: { score: 9000, completed_tasks: 100, dispute_ratio_bps: 25, last_updated: now - 10 },
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env, { nowSecs: now });
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.value.attestation);
      assert.equal(res.value.attestation.score, 9000);
      assert.equal(res.value.attestation.credential, env.CRED_OK);
      assert.notEqual(res.value.absent, true);
    }
  });

  it("row 4a — no owner_attestation on manifest → absent:true", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const { resolver } = makeResolver(new Map(), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58() } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.absent, true);
  });

  it("row 4b — attestation account missing → absent:true", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(201));
    const { resolver } = makeResolver(new Map([[attPk, null]]), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.absent, true);
  });

  it("row 4c — schema mismatch → absent:true", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(202));
    const wrongSchema = encodeBase58(rand32(299));
    const bytes = buildAtt({
      schemaPda: wrongSchema, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.absent, true);
  });

  it("row 4d — credential not in allowlist → absent:true", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(203));
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_UNTRUSTED, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.absent, true);
  });

  it("row 4e — expired attestation → absent:true + stale:true", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(204));
    const now = 1_900_000_000;
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(), expiry: now - 10,
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env, { nowSecs: now });
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.absent, true);
      assert.equal(res.value.stale, true);
    }
  });

  it("row 4f — subject mismatch → HARD ERROR (SUBJECT_MISMATCH)", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const other = Keypair.generate();
    const attPk = encodeBase58(rand32(205));
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: other.publicKey.toBase58(), // NOT the caller's subject
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "SUBJECT_MISMATCH");
  });

  it("row 4g — truncated data slice → absent:true (data parse failure)", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(206));
    const full = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    // Shorten the payload so parseReputationData throws; rewrite data_len in
    // the header (offset 169, u32 LE) so parseAttestationAccount passes the
    // header check and hands the (now-too-short) data slice to the parser.
    const truncated = full.slice(0, full.length - 8);
    new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength)
      .setUint32(169, truncated.length - 173 /* header size */, true);
    const { resolver } = makeResolver(new Map([[attPk, truncated]]), env);
    const res = await resolver.resolve(
      { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } },
      subject.publicKey.toBase58(),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.absent, true);
  });

  it("INVALID_INPUT on non-base58 subject authority (boundary guard)", async () => {
    const env = sasEnv();
    const { resolver } = makeResolver(new Map(), env);
    const res = await resolver.resolve(
      { agent: { pubkey: Keypair.generate().publicKey.toBase58(), owner_attestation: encodeBase58(rand32(3)) } },
      "not-base58!!!",
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "INVALID_INPUT");
  });
});

// ==========================================================================
// 3. Cache behaviour
// ==========================================================================

describe("smoke/integration: SasResolver cache", () => {
  it("repeat resolve() → 1 RPC call (cache hit on the second)", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(400));
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    const { resolver, state } = makeResolver(new Map([[attPk, bytes]]), env);
    const m = { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } };
    const subj = subject.publicKey.toBase58();
    await resolver.resolve(m, subj);
    await resolver.resolve(m, subj);
    assert.equal(state.callCount, 1);
  });

  it("`maxAge: 0` bypass → 2 RPC calls for 2 consecutive requests", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(401));
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    const { resolver, state } = makeResolver(new Map([[attPk, bytes]]), env);
    const m = { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } };
    const subj = subject.publicKey.toBase58();
    await resolver.resolve(m, subj, { maxAge: 0 });
    await resolver.resolve(m, subj, { maxAge: 0 });
    assert.equal(state.callCount, 2);
  });

  it("cacheMetrics reports hits and misses", async () => {
    const env = sasEnv();
    const subject = Keypair.generate();
    const attPk = encodeBase58(rand32(402));
    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: subject.publicKey.toBase58(),
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env);
    const m = { agent: { pubkey: subject.publicKey.toBase58(), owner_attestation: attPk } };
    const subj = subject.publicKey.toBase58();
    await resolver.resolve(m, subj); // miss
    await resolver.resolve(m, subj); // hit
    await resolver.resolve(m, subj); // hit
    const metrics = resolver.cacheMetrics();
    assert.equal(metrics.hits, 2);
    assert.equal(metrics.misses, 1);
  });
});

// ==========================================================================
// 4. Composed: validator + resolver back-to-back (mirrors reputation handler)
// ==========================================================================

describe("smoke/integration: validator + resolver composed", () => {
  it("clean manifest + valid attestation → merged view has both signals", async () => {
    const env = sasEnv();
    const agent = Keypair.generate();
    const attPk = encodeBase58(rand32(601));
    const manifest = makeManifest(agent.publicKey.toBase58(), "AgentMerged", attPk);
    const hash = V.manifestHash(manifest);
    // ADR-092 (commit a16c8a1): sign over taggedManifestHash(rawHash). See note
    // on the "valid manifest" test above for the cross-protocol replay rationale.
    const taggedHash = V.taggedManifestHash(hash);

    const vRes = V.validateManifest({
      manifest, onChainHash: hash, onChainSignature: sign(agent, taggedHash),
      authorityPubkey: new Uint8Array(agent.publicKey.toBytes()),
    });
    assert.equal(vRes.ok, true);

    const bytes = buildAtt({
      schemaPda: env.SCHEMA, credential: env.CRED_OK, signer: env.SIGNER,
      subject: agent.publicKey.toBase58(),
      data: { score: 8200, completed_tasks: 30, dispute_ratio_bps: 40, last_updated: Math.floor(Date.now() / 1000) },
    });
    const { resolver } = makeResolver(new Map([[attPk, bytes]]), env);
    const rRes = await resolver.resolve(
      { agent: (vRes as any).value.agent },
      agent.publicKey.toBase58(),
    );
    assert.equal(rRes.ok, true);
    if (rRes.ok) {
      assert.equal(rRes.value.attestation.score, 8200);
      assert.notEqual(rRes.value.absent, true);
    }
  });

  it("detectDisagreement flags >20pp gap between Registry and SAS scores", () => {
    const diverges = R.detectDisagreement(
      { reputation_score: 4000, total_tasks_completed: 50 },
      { score: 9000, completed_tasks: 50, dispute_ratio_bps: 0, last_updated: Math.floor(Date.now() / 1000), signer: "x", credential: "y" },
    );
    assert.equal(diverges, true);
    // Matching Registry/SAS scores should NOT diverge.
    const matching = R.detectDisagreement(
      { reputation_score: 8500, total_tasks_completed: 50 },
      { score: 8400, completed_tasks: 50, dispute_ratio_bps: 0, last_updated: Math.floor(Date.now() / 1000), signer: "x", credential: "y" },
    );
    assert.equal(matching, false);
  });

  it("scoreFreshness buckets: fresh / aging / stale", () => {
    const now = 1_900_000_000;
    assert.equal(R.scoreFreshness(now - 86_400 * 10, now), "fresh");
    assert.equal(R.scoreFreshness(now - 86_400 * 60, now), "aging");
    assert.equal(R.scoreFreshness(now - 86_400 * 120, now), "stale");
  });
});

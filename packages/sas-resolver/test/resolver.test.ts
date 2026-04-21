// ADR-064 resolver behavioral tests — ADR-061 §4 failure-mode table.
//
// Runs under Node's built-in test runner (`node:test`) via `tsx` —
// same pattern as @agenomics/capability-manifest-validator's tests.
//
// The SAS RPC is mocked via a `MockRpc` shim that returns canned
// `getAccountInfo` responses. No network calls.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  SasResolver,
  encodeAttestationAccount,
  encodeReputationData,
  encodeBase58,
  base58Decode,
  buildAllowlist,
  type ResolvedReputation,
  type Result,
} from "../src/index.js";

// ------------------------------------------------------------------
// Test fixtures
// ------------------------------------------------------------------

/** 32-byte pubkey filled with the given byte, as base58. */
function pubkey(fillByte: number): string {
  const bytes = new Uint8Array(32).fill(fillByte);
  return encodeBase58(bytes);
}

const SUBJECT_AUTHORITY = pubkey(0x11);
const OTHER_AUTHORITY = pubkey(0x22);
const SCHEMA_PDA = pubkey(0x33);
const OTHER_SCHEMA = pubkey(0x34);
const ALLOWED_CREDENTIAL = pubkey(0x55);
const FOREIGN_CREDENTIAL = pubkey(0x56);
const SIGNER = pubkey(0x77);
const NONCE = pubkey(0x88);
const ATTESTATION_ADDR = pubkey(0x99);

const NOW = 1_700_000_000; // frozen test clock — unix seconds, ~2023-11-14

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

/** Mock RPC — canned `getAccountInfo` responses keyed by address. */
class MockRpc {
  readonly responses = new Map<string, AccountResponse | null | "throw">();
  readonly calls: string[] = [];

  set(addr: string, resp: AccountResponse | null | "throw"): void {
    this.responses.set(addr, resp);
  }

  getAccountInfo(addr: unknown, _opts?: unknown): { send(): Promise<unknown> } {
    const addrStr = String(addr);
    this.calls.push(addrStr);
    const resp = this.responses.get(addrStr);
    return {
      send: async (): Promise<unknown> => {
        if (resp === "throw") throw new Error("simulated rpc failure");
        if (resp === null || resp === undefined) return { value: null };
        return { value: resp };
      },
    };
  }
}

interface AccountResponse {
  data: readonly [string, "base64"] | Uint8Array | number[];
}

/** Build a syntactically-correct attestation account blob. */
function makeAttestation(opts: {
  schema?: string;
  credential?: string;
  subject?: string;
  signer?: string;
  expiry?: number;
  data?: Uint8Array;
} = {}): Uint8Array {
  const data =
    opts.data ??
    encodeReputationData({
      score: 8600,
      completed_tasks: 118,
      dispute_ratio_bps: 150,
      last_updated: NOW - 7 * 86_400, // 7 days ago — fresh
    });
  return encodeAttestationAccount({
    nonce: base58Decode(NONCE),
    credential: base58Decode(opts.credential ?? ALLOWED_CREDENTIAL),
    schema: base58Decode(opts.schema ?? SCHEMA_PDA),
    subject: base58Decode(opts.subject ?? SUBJECT_AUTHORITY),
    signer: base58Decode(opts.signer ?? SIGNER),
    expiry: opts.expiry ?? 0,
    data,
  });
}

function base64OfBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Convenience — wrap bytes in the RPC tuple-shape the resolver prefers. */
function accountResponse(bytes: Uint8Array): AccountResponse {
  return { data: [base64OfBytes(bytes), "base64"] as const };
}

function makeResolver(rpc: MockRpc, opts: { warnSink?: string[] } = {}): SasResolver {
  // `MockRpc` quacks like the slice of `@solana/kit`'s Rpc the resolver
  // uses (`getAccountInfo`). The resolver uses duck-typing internally,
  // so the `as unknown as` cast is structural-only — no runtime lying.
  return new SasResolver({
    rpc: rpc as unknown as import("../src/types.js").ResolverRpc,
    allowedCredentials: buildAllowlist([ALLOWED_CREDENTIAL]),
    schemaPda: SCHEMA_PDA,
    now: () => NOW,
    warn: opts.warnSink
      ? (m: string, _d?: unknown) => {
          opts.warnSink!.push(m);
        }
      : () => {},
  });
}

function unwrapOk<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got err: ${JSON.stringify(r.error)}`);
  return r.value;
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe("ADR-064 SasResolver — ADR-061 §4 resolution flow", () => {
  it("happy path — valid manifest, valid attestation, subject matches", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

    const resolver = makeResolver(rpc);
    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.subject, SUBJECT_AUTHORITY);
    assert.equal(value.absent, undefined);
    assert.equal(value.stale, undefined);
    assert.ok(value.attestation, "attestation should be populated");
    assert.equal(value.attestation!.score, 8600);
    assert.equal(value.attestation!.completed_tasks, 118);
    assert.equal(value.attestation!.dispute_ratio_bps, 150);
    assert.equal(value.attestation!.signer, SIGNER);
    assert.equal(value.attestation!.credential, ALLOWED_CREDENTIAL);
    // Row 4e no-expiry path — `expiry: 0` maps to undefined.
    assert.equal(value.attestation!.expiry, undefined);
    assert.equal(rpc.calls.length, 1, "single RPC fetch");
  });

  it("row 4a — owner_attestation absent → absent: true, no RPC fetch", async () => {
    const rpc = new MockRpc();
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(manifest(), SUBJECT_AUTHORITY);

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(value.attestation, undefined);
    assert.equal(rpc.calls.length, 0, "no RPC fetch when owner_attestation unset");
  });

  it("row 4b — attestation account not found → absent: true", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, null); // account does not exist
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(value.attestation, undefined);
  });

  it("row 4c — schema mismatch → skipped, warn emitted, absent: true", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation({ schema: OTHER_SCHEMA })));
    const warnings: string[] = [];
    const resolver = makeResolver(rpc, { warnSink: warnings });

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(value.attestation, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unsupported schema/);
  });

  it("row 4d — credential not in allowlist → skipped + warn", async () => {
    const rpc = new MockRpc();
    rpc.set(
      ATTESTATION_ADDR,
      accountResponse(makeAttestation({ credential: FOREIGN_CREDENTIAL })),
    );
    const warnings: string[] = [];
    const resolver = makeResolver(rpc, { warnSink: warnings });

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /non-allowlisted credential/);
  });

  it("row 4e — expired attestation → absent: true + stale: true", async () => {
    const rpc = new MockRpc();
    rpc.set(
      ATTESTATION_ADDR,
      accountResponse(makeAttestation({ expiry: NOW - 1 })), // expired 1s ago
    );
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(value.stale, true);
    assert.equal(value.attestation, undefined);
  });

  it("row 4f — subject mismatch → HARD ERROR (SUBJECT_MISMATCH)", async () => {
    const rpc = new MockRpc();
    rpc.set(
      ATTESTATION_ADDR,
      accountResponse(makeAttestation({ subject: OTHER_AUTHORITY })),
    );
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "SUBJECT_MISMATCH");
      // Details should carry both sides so the caller can log them.
      const details = result.error.details as { expected: string; observed: string };
      assert.equal(details.expected, SUBJECT_AUTHORITY);
      assert.equal(details.observed, OTHER_AUTHORITY);
    }
  });

  it("row 4g — data parse failure → skipped + warn", async () => {
    const rpc = new MockRpc();
    // Valid attestation envelope but with malformed schema data
    // (not 16 bytes). Schema check passes (PDA matches) but the
    // data decoder throws.
    const badData = new Uint8Array([1, 2, 3]); // too short for AEP_AGENT_REPUTATION_v1
    rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation({ data: badData })));
    const warnings: string[] = [];
    const resolver = makeResolver(rpc, { warnSink: warnings });

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.equal(value.attestation, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /did not decode as AEP_AGENT_REPUTATION/);
  });

  it("malformed account bytes → absent + warn (row 4b / 4g defense-in-depth)", async () => {
    const rpc = new MockRpc();
    // Completely garbled account — discriminator mismatch.
    rpc.set(ATTESTATION_ADDR, accountResponse(new Uint8Array(200).fill(0xee)));
    const warnings: string[] = [];
    const resolver = makeResolver(rpc, { warnSink: warnings });

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.absent, true);
    assert.match(warnings[0]!, /malformed/);
  });

  it("RPC-layer throw → RPC_ERROR hard error (distinct from account-not-found)", async () => {
    const rpc = new MockRpc();
    rpc.set(ATTESTATION_ADDR, "throw");
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RPC_ERROR");
  });

  it("invalid subjectAuthority input → INVALID_INPUT", async () => {
    const rpc = new MockRpc();
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      "not-a-base58-pubkey!!",
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");
  });

  it("stale-by-age — last_updated > 90d but not expired → attestation + stale: true", async () => {
    const rpc = new MockRpc();
    rpc.set(
      ATTESTATION_ADDR,
      accountResponse(
        makeAttestation({
          data: encodeReputationData({
            score: 7000,
            completed_tasks: 40,
            dispute_ratio_bps: 500,
            last_updated: NOW - 120 * 86_400, // 120 days ago
          }),
        }),
      ),
    );
    const resolver = makeResolver(rpc);

    const result = await resolver.resolve(
      manifest({ owner_attestation: ATTESTATION_ADDR }),
      SUBJECT_AUTHORITY,
    );

    const value = unwrapOk(result);
    assert.equal(value.stale, true);
    assert.ok(value.attestation, "stale-by-age still surfaces the payload");
    assert.equal(value.attestation!.score, 7000);
  });

  describe("resolveBatch", () => {
    it("resolves multiple entries in parallel, preserves input order", async () => {
      const rpc = new MockRpc();

      // Entry 0 — happy path
      const addr0 = pubkey(0xa0);
      rpc.set(addr0, accountResponse(makeAttestation({
        data: encodeReputationData({ score: 100, completed_tasks: 1, dispute_ratio_bps: 0, last_updated: NOW }),
      })));

      // Entry 1 — absent (no owner_attestation)
      // (no RPC set — the resolver will skip the fetch entirely)

      // Entry 2 — subject mismatch -> HARD error
      const addr2 = pubkey(0xa2);
      rpc.set(addr2, accountResponse(makeAttestation({ subject: OTHER_AUTHORITY })));

      const resolver = makeResolver(rpc);

      const results = await resolver.resolveBatch([
        { manifest: manifest({ owner_attestation: addr0 }), subjectAuthority: SUBJECT_AUTHORITY },
        { manifest: manifest(), subjectAuthority: SUBJECT_AUTHORITY },
        { manifest: manifest({ owner_attestation: addr2 }), subjectAuthority: SUBJECT_AUTHORITY },
      ]);

      assert.equal(results.length, 3, "one result per input, same order");
      // 0 — happy
      assert.equal(results[0]!.ok, true);
      if (results[0]!.ok) {
        const v = results[0]!.value as ResolvedReputation;
        assert.equal(v.attestation?.score, 100);
      }
      // 1 — absent
      assert.equal(results[1]!.ok, true);
      if (results[1]!.ok) {
        assert.equal((results[1]!.value as ResolvedReputation).absent, true);
      }
      // 2 — subject-mismatch hard error
      assert.equal(results[2]!.ok, false);
      if (!results[2]!.ok) {
        assert.equal(results[2]!.error.code, "SUBJECT_MISMATCH");
      }

      // Parallel fetch: the RPC was called for addr0 and addr2 (not for
      // entry 1's absent owner_attestation).
      assert.ok(rpc.calls.includes(addr0));
      assert.ok(rpc.calls.includes(addr2));
      assert.equal(rpc.calls.length, 2);
    });
  });
});

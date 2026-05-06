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
  ResolverInitError,
  SignerHistoryMissingError,
  buildAllowlist,
  type AllowedCredential,
  type ResolvedReputation,
  type Result,
} from "../src/index.js";
import {
  encodeAttestationAccount,
  encodeReputationData,
  encodeBase58,
  base58Decode,
} from "./fixtures.js";

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
  /** Optional account owner pubkey (base58). Used by strict-init tests. */
  owner?: string;
}

/**
 * Build a syntactically-correct attestation account blob.
 *
 * SAS attestation accounts have no separate `subject` field — per
 * ADR-061 §2 the subject is encoded as the nonce. So `opts.subject`
 * here drives the on-chain `nonce` field, which the resolver compares
 * against `subjectAuthority` for SUBJECT_MISMATCH detection. The
 * default is SUBJECT_AUTHORITY, matching the resolver's expectation
 * in the happy path. SUBJECT_MISMATCH tests pass a different value
 * (typically OTHER_AUTHORITY) to trigger row 4f.
 */
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
  void NONCE;
  return encodeAttestationAccount({
    nonce: base58Decode(opts.subject ?? SUBJECT_AUTHORITY),
    credential: base58Decode(opts.credential ?? ALLOWED_CREDENTIAL),
    schema: base58Decode(opts.schema ?? SCHEMA_PDA),
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

interface MakeResolverOpts {
  warnSink?: string[];
  /**
   * Allowlist override — accepts either a bare pubkey array (flat v0
   * shape) or full `AllowedCredential` entries (ADR-076 scoped shape).
   * Defaults to a one-entry allowlist containing `ALLOWED_CREDENTIAL`
   * with no scoping.
   */
  allowlist?: Array<string | AllowedCredential>;
  /**
   * Enable strict mode. Off by default because `MockRpc` does not
   * canned-respond for the schema PDA; ADR-076 §2 init tests wire
   * their own schema response explicitly.
   */
  strict?: boolean;
  /** Override the SAS program ID (for init-mismatch tests). */
  sasProgramId?: string;
  /** Override the schema PDA (rarely used, lets tests mint alternate schemas). */
  schemaPda?: string;
}

function makeResolver(rpc: MockRpc, opts: MakeResolverOpts = {}): SasResolver {
  // `MockRpc` quacks like the slice of `@solana/kit`'s Rpc the resolver
  // uses (`getAccountInfo`). The resolver uses duck-typing internally,
  // so the `as unknown as` cast is structural-only — no runtime lying.
  //
  // ADR-101: the default allowlist uses the scoped `AllowedCredential`
  // shape with an explicit `signers` list. The flat v0 shape (`string[]`)
  // no longer works at signer-validation time because `entry.signers`
  // would be `undefined`, triggering a `SignerHistoryMissingError`.
  const defaultAllowlist: AllowedCredential[] = [
    { authority: ALLOWED_CREDENTIAL, signers: [SIGNER] },
  ];
  return new SasResolver({
    rpc: rpc as unknown as import("../src/types.js").ResolverRpc,
    allowedCredentials: buildAllowlist(opts.allowlist ?? defaultAllowlist),
    schemaPda: opts.schemaPda ?? SCHEMA_PDA,
    sasProgramId: opts.sasProgramId,
    strict: opts.strict ?? false,
    now: () => NOW,
    warn: opts.warnSink
      ? (m: string, _d?: unknown) => {
          opts.warnSink!.push(m);
        }
      : () => {},
  });
}

/**
 * Helper for strict-init tests — plant a canned `getAccountInfo`
 * response for a schema PDA so `#runInit` sees the owner field it
 * expects. Returns an `{ data, owner }` shape that matches
 * `AccountInfoResponse` in the resolver (kit v6-ish).
 */
function schemaAccountResponse(owner: string): AccountResponse {
  // Any non-zero-length byte blob is fine; the init check looks at
  // `owner`, not at the schema data. base64 "" decodes to an empty
  // Uint8Array but `decodeAccountData` accepts that and `#runInit`
  // doesn't inspect the data payload.
  return { data: ["", "base64"] as const, owner } as AccountResponse;
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

  // ----------------------------------------------------------------
  // ADR-076 / DEEP-AUDIT-2026-04-22 SEC-3 + SEC-15 hardening.
  // ----------------------------------------------------------------

  describe("ADR-076 §3 — per-credential signer scoping (SEC-3)", () => {
    it("accepts an attestation signed by a credential-scoped signer", async () => {
      const rpc = new MockRpc();
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      const resolver = makeResolver(rpc, {
        allowlist: [
          {
            authority: ALLOWED_CREDENTIAL,
            signers: [SIGNER],
          },
        ],
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.ok(value.attestation, "scoped allowlist with matching signer accepts");
      assert.equal(value.attestation!.signer, SIGNER);
    });

    it("skips with warn when attestation's signer is outside the credential's scoped signer list", async () => {
      const rpc = new MockRpc();
      const OTHER_SIGNER = pubkey(0x78);
      rpc.set(
        ATTESTATION_ADDR,
        accountResponse(makeAttestation({ signer: OTHER_SIGNER })),
      );
      const warnings: string[] = [];
      const resolver = makeResolver(rpc, {
        warnSink: warnings,
        allowlist: [
          {
            authority: ALLOWED_CREDENTIAL,
            signers: [SIGNER],
          },
        ],
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.equal(value.absent, true, "mismatched signer routes to skip-with-warn");
      assert.equal(value.attestation, undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /signer outside the credential's scoped signer list/);
    });
  });

  describe("ADR-076 §3 — per-credential schema binding (SEC-3)", () => {
    it("skips with warn when attestation's schema is not authorized for that credential", async () => {
      const rpc = new MockRpc();
      // Attestation points at the resolver's configured schema (so
      // row 4c passes) but the credential's allowlist entry binds it
      // to a *different* schema; the per-credential schema binding
      // must reject the attestation.
      const EXPECTED_FOR_CRED = pubkey(0x3a);
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));
      const warnings: string[] = [];
      const resolver = makeResolver(rpc, {
        warnSink: warnings,
        allowlist: [
          {
            authority: ALLOWED_CREDENTIAL,
            // ADR-101: signers must be explicit and non-empty.
            signers: [SIGNER],
            authorizedSchemas: [EXPECTED_FOR_CRED],
          },
        ],
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.equal(value.absent, true);
      assert.equal(value.attestation, undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /schema not authorized for this credential/);
    });

    it("accepts when attestation's schema matches the credential's authorized list", async () => {
      const rpc = new MockRpc();
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));
      const resolver = makeResolver(rpc, {
        allowlist: [
          {
            authority: ALLOWED_CREDENTIAL,
            // ADR-101: signers must be explicit and non-empty.
            signers: [SIGNER],
            authorizedSchemas: [SCHEMA_PDA],
          },
        ],
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.ok(value.attestation, "schema-in-list accepts");
      assert.equal(value.attestation!.credential, ALLOWED_CREDENTIAL);
    });
  });

  describe("ADR-076 §2 — strict init schema-PDA owner check (SEC-15)", () => {
    const SAS_PROGRAM = pubkey(0xfa);
    const NOT_SAS = pubkey(0xfb);

    it("accepts when schemaPda is owned by the configured SAS program", async () => {
      const rpc = new MockRpc();
      rpc.set(SCHEMA_PDA, schemaAccountResponse(SAS_PROGRAM));
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      const resolver = makeResolver(rpc, {
        strict: true,
        sasProgramId: SAS_PROGRAM,
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.ok(value.attestation, "strict init passes when owner matches");
      // Ensure the schema PDA was fetched exactly once (memoized init).
      const schemaFetches = rpc.calls.filter((a) => a === SCHEMA_PDA).length;
      assert.equal(schemaFetches, 1);
    });

    it("returns RESOLVER_INIT when schemaPda is owned by a non-SAS program", async () => {
      const rpc = new MockRpc();
      // Plant a schema-PDA account owned by the WRONG program.
      rpc.set(SCHEMA_PDA, schemaAccountResponse(NOT_SAS));
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      const resolver = makeResolver(rpc, {
        strict: true,
        sasProgramId: SAS_PROGRAM,
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      assert.equal(result.ok, false, "resolve must fail with init error");
      if (!result.ok) {
        assert.equal(result.error.code, "RESOLVER_INIT");
        const details = result.error.details as {
          expectedOwner: string;
          observedOwner: string | null;
          schemaPda: string;
        };
        assert.equal(details.expectedOwner, SAS_PROGRAM);
        assert.equal(details.observedOwner, NOT_SAS);
        assert.equal(details.schemaPda, SCHEMA_PDA);
      }
    });

    it("returns RESOLVER_INIT when schemaPda account does not exist on-chain", async () => {
      const rpc = new MockRpc();
      // No canned response for SCHEMA_PDA — MockRpc.getAccountInfo
      // returns `{ value: null }`, meaning the account does not exist.
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      const resolver = makeResolver(rpc, {
        strict: true,
        sasProgramId: SAS_PROGRAM,
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "RESOLVER_INIT");
        assert.match(result.error.message, /does not exist/);
      }
    });

    it("SasResolver.create() fails fast on owner mismatch", async () => {
      const rpc = new MockRpc();
      rpc.set(SCHEMA_PDA, schemaAccountResponse(NOT_SAS));

      await assert.rejects(
        async () => {
          await SasResolver.create({
            rpc: rpc as unknown as import("../src/types.js").ResolverRpc,
            allowedCredentials: buildAllowlist([ALLOWED_CREDENTIAL]),
            schemaPda: SCHEMA_PDA,
            sasProgramId: SAS_PROGRAM,
            now: () => NOW,
            warn: () => {},
          });
        },
        (e) => e instanceof ResolverInitError,
      );
    });

    it("init failure latches — subsequent resolves return the same error without re-querying", async () => {
      const rpc = new MockRpc();
      rpc.set(SCHEMA_PDA, schemaAccountResponse(NOT_SAS));
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      const resolver = makeResolver(rpc, {
        strict: true,
        sasProgramId: SAS_PROGRAM,
      });

      const r1 = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );
      const r2 = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      assert.equal(r1.ok, false);
      assert.equal(r2.ok, false);
      // Schema PDA fetched exactly once; attestation never fetched
      // because init latched.
      const schemaFetches = rpc.calls.filter((a) => a === SCHEMA_PDA).length;
      const attFetches = rpc.calls.filter((a) => a === ATTESTATION_ADDR).length;
      assert.equal(schemaFetches, 1, "schema PDA fetched once, memoized");
      assert.equal(attFetches, 0, "attestation never fetched after init failure");
    });
  });

  // ----------------------------------------------------------------
  // ADR-101 — hard-fail on undefined / empty entry.signers.
  // ----------------------------------------------------------------

  describe("ADR-101 — SignerHistoryMissingError: hard-fail on undefined/empty entry.signers", () => {
    it("throws SignerHistoryMissingError when entry.signers is undefined (flat v0 allowlist shape)", async () => {
      const rpc = new MockRpc();
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      // Flat v0 shape — `buildAllowlist([ALLOWED_CREDENTIAL])` produces
      // `{ authority: ALLOWED_CREDENTIAL }` with no `signers` field.
      const resolver = makeResolver(rpc, {
        allowlist: [ALLOWED_CREDENTIAL],
      });

      await assert.rejects(
        async () => {
          await resolver.resolve(
            manifest({ owner_attestation: ATTESTATION_ADDR }),
            SUBJECT_AUTHORITY,
          );
        },
        (e: unknown) => {
          assert.ok(e instanceof SignerHistoryMissingError, "must be SignerHistoryMissingError");
          assert.match(e.message, /has no signer history/);
          assert.match(e.message, /ADR-101/);
          assert.equal(e.name, "SignerHistoryMissingError");
          return true;
        },
      );
    });

    it("throws SignerHistoryMissingError when entry.signers is an empty array", async () => {
      const rpc = new MockRpc();
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      // Explicit empty signers list — still must hard-fail per ADR-101.
      const resolver = makeResolver(rpc, {
        allowlist: [
          { authority: ALLOWED_CREDENTIAL, signers: [] },
        ],
      });

      await assert.rejects(
        async () => {
          await resolver.resolve(
            manifest({ owner_attestation: ATTESTATION_ADDR }),
            SUBJECT_AUTHORITY,
          );
        },
        (e: unknown) => {
          assert.ok(e instanceof SignerHistoryMissingError, "must be SignerHistoryMissingError");
          assert.match(e.message, /has no signer history/);
          assert.match(e.message, /ADR-101/);
          return true;
        },
      );
    });

    it("resolves normally when entry.signers is a non-empty array containing the attestation signer", async () => {
      const rpc = new MockRpc();
      rpc.set(ATTESTATION_ADDR, accountResponse(makeAttestation()));

      // Explicitly scoped signer list — existing behaviour preserved.
      const resolver = makeResolver(rpc, {
        allowlist: [
          { authority: ALLOWED_CREDENTIAL, signers: [SIGNER] },
        ],
      });

      const result = await resolver.resolve(
        manifest({ owner_attestation: ATTESTATION_ADDR }),
        SUBJECT_AUTHORITY,
      );

      const value = unwrapOk(result);
      assert.ok(value.attestation, "non-empty matching signers list resolves successfully");
      assert.equal(value.attestation!.signer, SIGNER);
      assert.equal(value.absent, undefined);
    });
  });
});

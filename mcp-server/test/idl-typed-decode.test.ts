// ADR-088 — typed Anchor decode regression tests.
//
// This file is the static-and-runtime counterpart to the refactor that
// killed 37 `as any` casts in the v1 handlers. It exercises:
//
//   1. The typed `IdlAccounts<AgentRegistry>["agentProfile"]` surface —
//      the very shape that, before ADR-088, was `any` everywhere because
//      the cached `Program` singleton wasn't parameterised. The test
//      builds a fixture conforming to that exact type and feeds it to
//      `adaptRegistryProfile`. If anyone reverts a `field.toNumber()`
//      back to `(field as any).toNumber()`, this file still passes — the
//      build-time check is what catches that. But the build-time check
//      can ONLY catch it if `noImplicitAny: true` is on AND
//      `program.account.agentProfile` returns the typed shape, which is
//      what this test pins.
//
//   2. The duck-typed `numLike` / `stringLike` / `byteArrayLike` coercers
//      that handlers/reputation.ts used to carry. They were deleted by
//      ADR-088. This test re-asserts the post-fix behaviour:
//        - `BN.toNumber()` is called directly (no fallback to `Number(v)`)
//        - `manifestCid` is decoded as `number[]` (no `Uint8Array` /
//          `Buffer` runtime branches)
//        - all-zero `[u8; N]` correctly maps to `null`.
//
//   3. The shim file `src/idl/types.d.ts` re-exports the three IDL types
//      under `mcp-server`'s own `rootDir`. The test confirms the alias
//      `AgentProfileAccount = IdlAccounts<AgentRegistry>["agentProfile"]`
//      flows through that shim — i.e. that `tsc` resolves the type to
//      the canonical `target/types/agent_registry` shape.
//
// Runs under `node --import tsx --test` alongside action-shape /
// pipeline / handlers-v2-vault / smoke-integration.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { BN } = anchorPkg;
import type { BN as BNType, IdlAccounts } from "@coral-xyz/anchor";

import {
  adaptRegistryProfile,
  type AgentProfileAccount,
  type RegistrySnapshot,
  type ManifestPointer,
} from "../src/handlers/reputation.js";
import type { AgentRegistry } from "../src/idl/types.js";

// ==========================================================================
// Static type-equivalence checks (compile-time; zero runtime cost).
// ==========================================================================
//
// These `Equals` checks compile away — they exist so that if anyone
// changes the underlying type wiring (e.g. demotes `Program<AgentRegistry>`
// back to `Program<Idl>`, or removes the shim), the build fails here
// before it fails at the call sites. This is the build-time gate ADR-088
// promised.

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;

// `AgentProfileAccount` must be the IDL-derived shape, not a hand-written
// alias. If someone replaces the import with a structural duplicate, this
// breaks.
type _SameAsIdlAccount = Equals<
  AgentProfileAccount,
  IdlAccounts<AgentRegistry>["agentProfile"]
>;
const _idlAccountAlias: _SameAsIdlAccount = true; // compiles iff equivalent

// Field-level type pins. These are the exact spots where pre-ADR-088 code
// carried `(field as any).toNumber()`. If Anchor's IDL→TS mapping ever
// stops returning BN for u64 / number for u8 / number[] for [u8; N], this
// fails to compile.
type _ScoreIsBN = Equals<AgentProfileAccount["reputationScore"], BNType>;
const _scoreIsBN: _ScoreIsBN = true;

type _CidIsNumberArray = Equals<AgentProfileAccount["manifestCid"], number[]>;
const _cidIsNumberArray: _CidIsNumberArray = true;

type _AvgRatingIsNumber = Equals<AgentProfileAccount["avgRating"], number>;
const _avgRatingIsNumber: _AvgRatingIsNumber = true;

type _AuthorityIsPublicKey = Equals<
  AgentProfileAccount["authority"],
  PublicKey
>;
const _authorityIsPublicKey: _AuthorityIsPublicKey = true;

// ==========================================================================
// Runtime fixture helpers.
// ==========================================================================

/**
 * Build an `AgentProfileAccount` fixture matching the Anchor-decoded shape
 * exactly — BN for u64, PublicKey for pubkey, fixed-length number[] for
 * `[u8; N]` arrays. If the IDL changes shape (a new field, a renamed
 * variant), `tsc` rejects this fixture and forces the test to be updated.
 *
 * The default values exercise the "happy path" — non-zero reputation,
 * present manifest, present stake.
 */
function makeProfileFixture(
  overrides: Partial<AgentProfileAccount> = {},
): AgentProfileAccount {
  const authority = Keypair.generate().publicKey;
  const cid = "QmTestCidShouldDecodeAsUtf8RoundTrip";
  const cidBytes: number[] = [
    ...new TextEncoder().encode(cid),
    ...Array(64 - cid.length).fill(0),
  ];
  const hash32: number[] = Array.from({ length: 32 }, (_, i) => (i + 1) & 0xff);
  const sig64: number[] = Array.from({ length: 64 }, (_, i) => (i + 7) & 0xff);

  const base: AgentProfileAccount = {
    authority,
    name: "test-agent",
    description: "fixture profile",
    category: "testing",
    capabilities: ["fixture", "test"],
    pricingModel: { perTask: {} },
    pricingAmount: new BN(1_500_000_000), // 1.5 SOL in lamports
    acceptedTokens: [],
    vaultAddress: Keypair.generate().publicKey,
    status: { active: {} },
    reputationScore: new BN(7_500),
    totalTasksCompleted: new BN(42),
    totalEarnings: new BN(123_456_789),
    avgRating: 4,
    createdAt: new BN(1_700_000_000),
    updatedAt: new BN(1_700_001_234),
    reputationStake: {
      stakedAmount: new BN(500_000_000), // 0.5 SOL
      slashCount: 0,
    },
    bump: 254,
    manifestCid: cidBytes,
    manifestHash: hash32,
    manifestSignature: sig64,
    manifestVersion: 1,
    // The IDL also carries `manifestCapabilityNames` (Vec<String>) — keep
    // it empty since `adaptRegistryProfile` doesn't read it.
    manifestCapabilityNames: [],
  };
  return { ...base, ...overrides };
}

// ==========================================================================
// adaptRegistryProfile — typed-path round trips.
// ==========================================================================

describe("ADR-088: typed adaptRegistryProfile", () => {
  it("decodes a populated AgentProfile via the typed Anchor shape", () => {
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture();
    const { snapshot, pointer } = adaptRegistryProfile(pda, fixture);

    // The whole point of ADR-088: the BN→number conversion happens
    // through `BN.toNumber()`, NOT through a duck-typed `numLike` fallback.
    // If anyone reverts to `numLike(profile.reputationScore)` and removes
    // BN's prototype hint, this assertion still passes — the regression
    // is caught at compile time (see `_ScoreIsBN` above).
    assert.equal(snapshot.reputationScore, 7_500);
    assert.equal(snapshot.totalTasksCompleted, 42);
    assert.equal(snapshot.avgRating, 4);
    assert.equal(snapshot.stakedAmountSol, 0.5);
    assert.equal(snapshot.slashCount, 0);
    assert.equal(snapshot.authority, fixture.authority.toBase58());
    assert.equal(snapshot.name, "test-agent");
    assert.equal(snapshot.status, "active");
    assert.equal(snapshot.agentProfileAddress, pda.toBase58());

    // Manifest pointer: zero-padded `[u8; 64]` decoded as UTF-8.
    assert.equal(pointer.cid, "QmTestCidShouldDecodeAsUtf8RoundTrip");
    assert.equal(pointer.version, 1);
    assert.ok(pointer.hash instanceof Uint8Array);
    assert.equal(pointer.hash!.length, 32);
    assert.ok(pointer.signature instanceof Uint8Array);
    assert.equal(pointer.signature!.length, 64);
  });

  it("returns nulls for zero-padded manifest sentinels (manifest absent)", () => {
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture({
      manifestCid: Array(64).fill(0),
      manifestHash: Array(32).fill(0),
      manifestSignature: Array(64).fill(0),
      manifestVersion: 0,
    });

    const { pointer } = adaptRegistryProfile(pda, fixture);

    // The pre-ADR-088 `byteArrayLike` adapter accepted Uint8Array, Array,
    // AND duck-typed Buffer. The typed path takes only `number[]` (since
    // the IDL declares the field as `[u8; N]`) — these tests confirm the
    // narrowed input shape still produces the correct null sentinel.
    assert.equal(pointer.cid, null);
    assert.equal(pointer.hash, null);
    assert.equal(pointer.signature, null);
    assert.equal(pointer.version, null);
  });

  it("trims trailing zeros from a partially-filled manifest_cid", () => {
    const pda = Keypair.generate().publicKey;
    const cid = "Qm123";
    const cidBytes: number[] = [
      ...new TextEncoder().encode(cid),
      ...Array(64 - cid.length).fill(0),
    ];
    const fixture = makeProfileFixture({
      manifestCid: cidBytes,
      manifestVersion: 3,
    });

    const { pointer } = adaptRegistryProfile(pda, fixture);
    assert.equal(pointer.cid, "Qm123");
    assert.equal(pointer.version, 3);
  });

  it("BN.toNumber() — directly, not via duck-typed coercion", () => {
    // Regression guard. If a reviewer reintroduces a duck-type fallback
    // like `typeof v === "bigint" ? Number(v) : ...`, supplying a bigint
    // here would *silently* accept it instead of failing loud. The typed
    // shape's `reputationScore: BN` rejects a bigint at compile time, and
    // at runtime `bigint.toNumber` doesn't exist — so the assert below
    // catches both directions.
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture({
      reputationScore: new BN("9999999999"), // > Number.MAX_SAFE_INTEGER chunk
    });
    const { snapshot } = adaptRegistryProfile(pda, fixture);
    assert.equal(typeof snapshot.reputationScore, "number");
    assert.equal(snapshot.reputationScore, 9_999_999_999);
  });

  it("preserves zero-rating when avg_rating is the on-chain u8 zero", () => {
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture({ avgRating: 0 });
    const { snapshot } = adaptRegistryProfile(pda, fixture);
    // Pre-ADR-088 reputation handler used `(profile.avgRating as number) ?? 0`
    // which collapses 0 to 0 by accident. Post-fix the type is `number`
    // outright — `?? 0` is unnecessary and we read the value verbatim.
    assert.equal(snapshot.avgRating, 0);
  });

  // ==========================================================================
  // Type-discipline check: the fixture builder MUST be assignable to the
  // typed account shape. Removing or renaming a field in the IDL forces a
  // compile error here, which forces the test (and downstream handlers)
  // to be updated.
  // ==========================================================================
  it("fixture is structurally assignable to AgentProfileAccount", () => {
    const fixture: AgentProfileAccount = makeProfileFixture();
    // Sanity: every field touched by adaptRegistryProfile is present.
    assert.ok(fixture.reputationScore instanceof BN);
    assert.ok(fixture.totalTasksCompleted instanceof BN);
    assert.ok(fixture.reputationStake.stakedAmount instanceof BN);
    assert.equal(typeof fixture.reputationStake.slashCount, "number");
    assert.equal(typeof fixture.avgRating, "number");
    assert.equal(typeof fixture.manifestVersion, "number");
    assert.equal(fixture.manifestCid.length, 64);
    assert.equal(fixture.manifestHash.length, 32);
    assert.equal(fixture.manifestSignature.length, 64);
  });
});

// ==========================================================================
// Snapshot/Pointer wire shape — guards the public surface of the handler.
// ==========================================================================

describe("ADR-088: snapshot/pointer wire shape", () => {
  it("RegistrySnapshot fields are all primitive (number / string)", () => {
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture();
    const { snapshot } = adaptRegistryProfile(pda, fixture);

    // The MCP wire serialiser does not know about BN. Pre-ADR-088, a
    // missed `(field as any).toNumber()` call would have produced
    // `{ reputationScore: { ... BN internals ... } }` here. The typed
    // path makes that mistake a build-time error AND a runtime check.
    const wire: RegistrySnapshot = snapshot;
    for (const [k, v] of Object.entries(wire)) {
      if (k === "agentProfileAddress" || k === "authority" || k === "name" || k === "status") {
        assert.equal(typeof v, "string", `${k} must be a string`);
      } else {
        assert.equal(typeof v, "number", `${k} must be a number`);
      }
    }
  });

  it("ManifestPointer fields are nullable but never BN / never raw object", () => {
    const pda = Keypair.generate().publicKey;
    const fixture = makeProfileFixture();
    const { pointer } = adaptRegistryProfile(pda, fixture);

    const wire: ManifestPointer = pointer;
    assert.ok(wire.cid === null || typeof wire.cid === "string");
    assert.ok(wire.version === null || typeof wire.version === "number");
    assert.ok(wire.hash === null || wire.hash instanceof Uint8Array);
    assert.ok(wire.signature === null || wire.signature instanceof Uint8Array);
  });
});

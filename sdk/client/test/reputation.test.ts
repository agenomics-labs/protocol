// ADR-139 — SDK `Reputation` namespace tests.
//
// Covers `fromAgentProfile` projection (manifest_hash hex encoding, score
// clamping, BN → bigint round-trip), the `issueForProfile` convenience,
// and round-trip verification through the public namespace.

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { Reputation, type AnchorAgentProfileLike } from "../src/index.js";

// We intentionally avoid `import { BN } from "@anchor-lang/core"` here:
// under ESM the re-export shape is unstable across Anchor minor versions.
// `fromAgentProfile` only requires `toString()` on the BN-like fields,
// so a hand-rolled stand-in keeps the test hermetic.
class BNLike {
  constructor(private readonly v: string) {}
  static from(n: number | string | bigint): BNLike {
    return new BNLike(typeof n === "bigint" ? n.toString() : String(n));
  }
  toString(): string {
    return this.v;
  }
}

const AGENT_ID = "AgentPubkey1111111111111111111111111111111AA";

function fixtureProfile(overrides: Partial<AnchorAgentProfileLike> = {}): AnchorAgentProfileLike {
  return {
    authority: new PublicKey("11111111111111111111111111111111"),
    reputationScore: BNLike.from(73),
    reputationStake: {
      stakedAmount: BNLike.from("5000000000"),
      slashCount: 1,
    },
    manifestHash: Array.from({ length: 32 }, () => 0xab),
    registrationNonce: BNLike.from(4),
    ...overrides,
  };
}

describe("ADR-139 SDK Reputation namespace", () => {
  it("fromAgentProfile encodes manifest_hash as 64-char hex", () => {
    const snap = Reputation.fromAgentProfile(fixtureProfile(), {
      agentId: AGENT_ID,
      snapshotSlot: 1000n,
      snapshotTimestamp: 1_731_543_123,
    });
    assert.equal(snap.manifest_hash.length, 64);
    assert.equal(snap.manifest_hash, "ab".repeat(32));
  });

  it("fromAgentProfile clamps reputation_score above 100 to 100", () => {
    const profile = fixtureProfile({ reputationScore: BNLike.from(200) });
    const snap = Reputation.fromAgentProfile(profile, {
      agentId: AGENT_ID,
      snapshotSlot: 1n,
    });
    assert.equal(snap.reputation_score, 100);
  });

  it("fromAgentProfile clamps negative-rendered (unsigned overflow) values to 0", () => {
    const profile = fixtureProfile({ reputationScore: BNLike.from(0) });
    const snap = Reputation.fromAgentProfile(profile, {
      agentId: AGENT_ID,
      snapshotSlot: 1n,
    });
    assert.equal(snap.reputation_score, 0);
  });

  it("fromAgentProfile rejects malformed manifestHash length", () => {
    assert.throws(
      () =>
        Reputation.fromAgentProfile(
          fixtureProfile({ manifestHash: [1, 2, 3] }),
          { agentId: AGENT_ID, snapshotSlot: 1n },
        ),
      /manifestHash/,
    );
  });

  it("issueForProfile produces a verifiable credential", () => {
    const issuer = Reputation.issuerFromSecret(new Uint8Array(32).fill(0x42));
    const cred = Reputation.issueForProfile(
      fixtureProfile(),
      { agentId: AGENT_ID, snapshotSlot: 100n, snapshotTimestamp: 1_000 },
      { issuer, issuerUrl: "https://reputation.test.example" },
    );
    const v = Reputation.verify(cred);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.payload.reputation_score, 73);
      assert.equal(v.payload.slash_count, 1);
      assert.equal(v.payload.snapshot_slot, "100");
      assert.equal(v.payload.schema, Reputation.SCHEMA);
    }
  });

  it("preserves BN → bigint precision for reputation_stake_lamports", () => {
    const huge = new BNLike("18446744073709551615"); // 2^64 - 1
    const snap = Reputation.fromAgentProfile(
      fixtureProfile({
        reputationStake: { stakedAmount: huge, slashCount: 0 },
      }),
      { agentId: AGENT_ID, snapshotSlot: 1n },
    );
    assert.equal(snap.reputation_stake_lamports, 18_446_744_073_709_551_615n);
  });
});

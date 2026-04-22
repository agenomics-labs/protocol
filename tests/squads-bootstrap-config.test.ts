/**
 * Config-shape validation for scripts/.squads-devnet.json.
 *
 * This is NOT a live on-chain test — we only verify the JSON produced by
 * `scripts/bootstrap-squads-devnet.ts` has the expected shape, so future
 * runs can't silently corrupt the recorded multisig address.
 *
 * If the file doesn't exist yet (bootstrap not yet run), all cases are
 * skipped with a `pending` note.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Tests always run from the repo root (see Anchor.toml), so resolve the
// config path against cwd. Avoids `__dirname`, which can be undefined when
// Node 25+ reparses the transpiled file as ESM.
const CONFIG_PATH = path.resolve(
  process.cwd(),
  "scripts",
  ".squads-devnet.json",
);

function isValidBase58Pubkey(s: unknown): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    // Throws if not a valid 32-byte base58 pubkey.
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function isIsoTimestamp(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

describe("scripts/.squads-devnet.json", function () {
  const exists = fs.existsSync(CONFIG_PATH);

  // eslint-disable-next-line mocha/no-setup-in-describe
  if (!exists) {
    it.skip(
      "TODO: run `tsx scripts/bootstrap-squads-devnet.ts` to generate the config, then re-run this test",
      () => {
        /* pending */
      },
    );
    return;
  }

  let record: Record<string, unknown>;

  before(() => {
    record = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  });

  it("has cluster set to devnet (mainnet is out of scope for v1)", () => {
    expect(record.cluster).to.equal("devnet");
  });

  it("references the Squads v4 program ID", () => {
    expect(isValidBase58Pubkey(record.multisigProgramId)).to.equal(
      true,
      "multisigProgramId is not a valid pubkey",
    );
    // Canonical Squads v4 program.
    expect(record.multisigProgramId).to.equal(
      "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
    );
  });

  it("stores a valid multisigPda", () => {
    expect(isValidBase58Pubkey(record.multisigPda)).to.equal(
      true,
      "multisigPda is not a valid pubkey",
    );
  });

  it("stores a valid createKey", () => {
    expect(isValidBase58Pubkey(record.createKey)).to.equal(
      true,
      "createKey is not a valid pubkey",
    );
  });

  it("has a positive integer threshold not exceeding member count", () => {
    const t = record.threshold;
    expect(t).to.be.a("number");
    expect(Number.isInteger(t)).to.equal(true);
    expect(t as number).to.be.greaterThan(0);
    const members = record.members as unknown[];
    expect(Array.isArray(members)).to.equal(true);
    expect(t as number).to.be.at.most(members.length);
  });

  it("has exactly 3 valid member pubkeys (devnet v1 uses 2-of-3)", () => {
    const members = record.members as unknown[];
    expect(members).to.have.lengthOf(3);
    for (const m of members) {
      expect(isValidBase58Pubkey(m)).to.equal(
        true,
        `member is not a valid pubkey: ${String(m)}`,
      );
    }
    const unique = new Set(members as string[]);
    expect(unique.size).to.equal(3, "members must be distinct pubkeys");
  });

  it("includes the protocol wallet as signer 1", () => {
    const members = record.members as string[];
    expect(members[0]).to.equal(
      "BUdXA1FiWnV7ksXYodH3uEhDUhfBJ8g4UmmWdshWjTXL",
    );
  });

  it("records a valid ISO-8601 createdAt", () => {
    expect(isIsoTimestamp(record.createdAt)).to.equal(
      true,
      "createdAt is not an ISO-8601 timestamp",
    );
  });

  it("records a non-empty createSignature", () => {
    expect(record.createSignature).to.be.a("string");
    expect((record.createSignature as string).length).to.be.greaterThan(0);
  });
});

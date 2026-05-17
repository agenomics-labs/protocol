import { test } from "node:test";
import assert from "node:assert/strict";
import { getProgramIds, PROGRAM_IDS } from "../src/index.js";

test("getProgramIds returns devnet program IDs", () => {
  const ids = getProgramIds("devnet");
  assert.ok(ids.agentRegistry.length > 0, "agentRegistry should be non-empty");
  assert.ok(ids.agentVault.length > 0, "agentVault should be non-empty");
  assert.ok(ids.settlement.length > 0, "settlement should be non-empty");
});

test("getProgramIds returns localnet program IDs", () => {
  const ids = getProgramIds("localnet");
  assert.ok(ids.agentRegistry.length > 0);
  assert.ok(ids.agentVault.length > 0);
  assert.ok(ids.settlement.length > 0);
});

// AUD-207 / SDK-F1: mainnet-beta program IDs are NOT provisioned. The helper
// must fail closed (throw) rather than hand back placeholder devnet addresses
// that point at programs whose upgrade authority is a test key.
test("getProgramIds throws for unprovisioned mainnet-beta (fail-closed)", () => {
  assert.throws(() => getProgramIds("mainnet-beta"), /not yet/);
});

test("getProgramIds mainnet-beta error message is actionable", () => {
  let err: unknown;
  try {
    getProgramIds("mainnet-beta");
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "should throw an Error instance");
  const msg = (err as Error).message;
  assert.match(msg, /mainnet-beta/, "names the offending cluster");
  assert.match(msg, /AUD-207/, "cites the tracking finding");
  assert.match(msg, /ADR-083/, "cites the tracking ADR");
  assert.match(
    msg,
    /devnet.*localnet|localnet.*devnet/,
    "points the caller at a safe alternative",
  );
  assert.match(msg, /placeholder/, "explains why it refuses (placeholder IDs)");
});

test("getProgramIds returns consistent IDs across calls", () => {
  assert.deepEqual(getProgramIds("devnet"), getProgramIds("devnet"));
  assert.deepEqual(getProgramIds("localnet"), getProgramIds("localnet"));
});

test("PROGRAM_IDS contains all three clusters; mainnet-beta is null (unprovisioned)", () => {
  assert.ok("devnet" in PROGRAM_IDS);
  assert.ok("mainnet-beta" in PROGRAM_IDS);
  assert.ok("localnet" in PROGRAM_IDS);
  assert.equal(
    PROGRAM_IDS["mainnet-beta"],
    null,
    "mainnet-beta must be null until the ADR-083 keypair ceremony lands",
  );
});

test("getProgramIds result matches PROGRAM_IDS manifest for provisioned clusters", () => {
  assert.deepEqual(getProgramIds("devnet"), PROGRAM_IDS["devnet"]);
  assert.deepEqual(getProgramIds("localnet"), PROGRAM_IDS["localnet"]);
});

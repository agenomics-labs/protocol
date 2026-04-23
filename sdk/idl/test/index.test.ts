import { test } from "node:test";
import assert from "node:assert/strict";
import { getProgramIds, PROGRAM_IDS } from "../src/index.js";

test("getProgramIds returns devnet program IDs", () => {
  const ids = getProgramIds("devnet");
  assert.ok(ids.agentRegistry.length > 0, "agentRegistry should be non-empty");
  assert.ok(ids.agentVault.length > 0, "agentVault should be non-empty");
  assert.ok(ids.settlement.length > 0, "settlement should be non-empty");
});

test("getProgramIds returns mainnet-beta program IDs", () => {
  const ids = getProgramIds("mainnet-beta");
  assert.ok(ids.agentRegistry.length > 0);
  assert.ok(ids.agentVault.length > 0);
  assert.ok(ids.settlement.length > 0);
});

test("getProgramIds returns localnet program IDs", () => {
  const ids = getProgramIds("localnet");
  assert.ok(ids.agentRegistry.length > 0);
  assert.ok(ids.agentVault.length > 0);
  assert.ok(ids.settlement.length > 0);
});

test("getProgramIds returns consistent IDs across calls", () => {
  assert.deepEqual(getProgramIds("devnet"), getProgramIds("devnet"));
  assert.deepEqual(getProgramIds("mainnet-beta"), getProgramIds("mainnet-beta"));
});

test("PROGRAM_IDS contains all three clusters", () => {
  assert.ok("devnet" in PROGRAM_IDS);
  assert.ok("mainnet-beta" in PROGRAM_IDS);
  assert.ok("localnet" in PROGRAM_IDS);
});

test("getProgramIds result matches PROGRAM_IDS manifest directly", () => {
  assert.deepEqual(getProgramIds("devnet"), PROGRAM_IDS["devnet"]);
  assert.deepEqual(getProgramIds("mainnet-beta"), PROGRAM_IDS["mainnet-beta"]);
});

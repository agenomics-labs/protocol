import { test } from "node:test";
import assert from "node:assert/strict";
import { AepClient } from "../src/index.js";
import { getProgramIds, PROGRAM_IDS } from "../src/index.js";

// --- AepClient construction ---

test("AepClient constructs without throwing for devnet", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  assert.ok(client instanceof AepClient);
});

test("AepClient constructs without throwing for mainnet-beta", () => {
  const client = new AepClient({
    cluster: "mainnet-beta",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  });
  assert.ok(client instanceof AepClient);
});

test("AepClient constructs without throwing for localnet", () => {
  const client = new AepClient({
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
  });
  assert.ok(client instanceof AepClient);
});

// --- rpcUrl ---

test("AepClient exposes rpcUrl", () => {
  const url = "https://api.devnet.solana.com";
  const client = new AepClient({ cluster: "devnet", rpcUrl: url });
  assert.equal(client.rpcUrl, url);
});

// --- getProgramIds() ---

test("AepClient.getProgramIds() returns correct program IDs for devnet", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  const ids = client.getProgramIds();
  assert.ok(ids.agentRegistry.length > 0);
  assert.ok(ids.agentVault.length > 0);
  assert.ok(ids.settlement.length > 0);
});

test("AepClient.getProgramIds() is consistent with @agenomics/idl getProgramIds", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  assert.deepEqual(client.getProgramIds(), getProgramIds("devnet"));
});

// --- re-exports from @agenomics/idl ---

test("getProgramIds re-export works correctly", () => {
  const ids = getProgramIds("devnet");
  assert.ok(ids.agentRegistry.length > 0);
});

test("PROGRAM_IDS re-export contains expected clusters", () => {
  assert.ok("devnet" in PROGRAM_IDS);
  assert.ok("mainnet-beta" in PROGRAM_IDS);
  assert.ok("localnet" in PROGRAM_IDS);
});

// --- deriveAgentProfilePda placeholder ---

test("AepClient.deriveAgentProfilePda throws NotImplemented error", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  assert.throws(() => client.deriveAgentProfilePda("somePubkey"), {
    message: /deriveAgentProfilePda/,
  });
});

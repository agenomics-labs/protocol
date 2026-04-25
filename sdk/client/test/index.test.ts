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

// --- deriveAgentProfilePda ---

test("AepClient.deriveAgentProfilePda returns a base58 string for a valid pubkey", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  // SystemProgram ID as a known valid base58 pubkey
  const systemProgram = "11111111111111111111111111111111";
  const pda = client.deriveAgentProfilePda(systemProgram, 0n);
  assert.equal(typeof pda, "string");
  assert.ok(pda.length >= 32 && pda.length <= 44, "PDA should be a valid base58 key");
});

test("AepClient.deriveAgentProfilePda defaults nonce to 0n", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  const systemProgram = "11111111111111111111111111111111";
  const pda0 = client.deriveAgentProfilePda(systemProgram);
  const pdaExplicit = client.deriveAgentProfilePda(systemProgram, 0n);
  assert.equal(pda0, pdaExplicit);
});

test("AepClient.deriveAgentProfilePda produces different PDAs for different nonces", () => {
  const client = new AepClient({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
  });
  const systemProgram = "11111111111111111111111111111111";
  const pda0 = client.deriveAgentProfilePda(systemProgram, 0n);
  const pda1 = client.deriveAgentProfilePda(systemProgram, 1n);
  assert.notEqual(pda0, pda1);
});

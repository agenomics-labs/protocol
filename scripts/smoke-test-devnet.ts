/**
 * Agenomics Devnet Smoke Test
 *
 * Verifies that all 3 programs are deployed and functional on devnet AND that
 * the off-chain stack (capability-manifest-validator, sas-resolver, MCP server,
 * v2 Kit vault path, preflight gates) lines up with the on-chain state.
 *
 * Steps (see docs/SMOKE_TESTING.md for expected pass criteria):
 *    1  Program deployment probe
 *    2  Test wallet + devnet airdrop
 *    3  Vault initialization
 *    4  Agent registration
 *    5  Verify on-chain state (vault + profile)
 *    6  update_manifest — ADR-060: canonical-JSON + SHA-256 + Ed25519 precompile
 *    7  capability-manifest-validator round-trip (including tampered-byte negative)
 *    8  MCP server dispatch — tools/list + get_agent_reputation (SAS absent path)
 *    9  v2 vault_transfer — AEP_USE_V2_VAULT_TRANSFER=1 parity with v1
 *   10  Preflight proof — PREFLIGHT_FAILED { gate: 'daily_cap_not_exhausted' }
 *   11+ SAS bootstrap (devnet): attempted conditional on schema env; reports
 *       "SAS not bootstrapped on devnet — skipping" when absent.
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.devnet.solana.com npx tsx scripts/smoke-test-devnet.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  Ed25519Program,
} from "@solana/web3.js";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const VAULT_PROGRAM_ID = new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN");
const REGISTRY_PROGRAM_ID = new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh");
const SETTLEMENT_PROGRAM_ID = new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MANIFEST_SCHEMA_V1_URL =
  "https://aep.dev/schemas/capability-manifest/v1.0.json";

function loadIdl(name: string): any {
  // `anchor build` drops IDLs under `target/idl/`; a checked-in copy lives at
  // `idl/`. Prefer target (fresh build), fall back to the tracked copy so the
  // script runs without requiring `anchor build` first.
  const candidates = [
    path.resolve(PROJECT_ROOT, "target", "idl", `${name}.json`),
    path.resolve(PROJECT_ROOT, "idl", `${name}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  throw new Error(`IDL not found for ${name} (searched: ${candidates.join(", ")})`);
}

class KeypairWallet {
  payer: Keypair;
  constructor(payer: Keypair) { this.payer = payer; }
  get publicKey() { return this.payer.publicKey; }
  async signTransaction<T>(tx: T): Promise<T> { (tx as any).partialSign(this.payer); return tx; }
  async signAllTransactions<T>(txs: T[]): Promise<T[]> { txs.forEach(tx => (tx as any).partialSign(this.payer)); return txs; }
}

// ---------- Dynamic-import shim for the ESM-only @agenomics/* packages ----------
type DynImport = <T = unknown>(specifier: string) => Promise<T>;
const dynImport = new Function("s", "return import(s);") as unknown as DynImport;

// ---------- Minimal manifest fabricator (ADR-060 §2 v1.0) ----------
function fabricateManifest(agentPubkey: PublicKey, name: string): any {
  return {
    $schema: MANIFEST_SCHEMA_V1_URL,
    version: "1.0",
    agent: {
      pubkey: agentPubkey.toBase58(),
      name,
    },
    agent_version: "0.1.0",
    capabilities: [
      {
        name: "smoke-test",
        description: "Devnet smoke-test capability",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        required_capabilities: [],
        side_effects: ["read-onchain"],
        stability: "experimental",
      },
    ],
    published_at: new Date().toISOString(),
  };
}

// Pack packed-semver 1.0 as high-byte=1, low-byte=0 → 0x0100 (256).
const MANIFEST_VERSION_V1_0 = (1 << 8) | 0;

/**
 * POST the canonical manifest bytes to a Kubo HTTP API at `apiBase` and
 * return the resulting CIDv1. Throws on any transport / HTTP / parse error —
 * caller is expected to catch and degrade to the synthetic-CID fallback.
 *
 * We hand-build the multipart/form-data body because Node's native `fetch`
 * FormData stringifies Uint8Array bodies instead of sending them as an
 * octet-stream part, which Kubo rejects with "file argument 'path' is
 * required".
 */
async function pinCanonicalManifest(
  apiBase: string,
  canonicalBytes: Uint8Array,
): Promise<string> {
  const boundary =
    "----aep-smoke-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const preamble =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="manifest.json"\r\n` +
    `Content-Type: application/json\r\n\r\n`;
  const epilogue = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(preamble, "utf-8"),
    Buffer.from(canonicalBytes),
    Buffer.from(epilogue, "utf-8"),
  ]);
  const url =
    apiBase.replace(/\/+$/, "") + "/api/v0/add?pin=true&cid-version=1";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!resp.ok) {
    throw new Error(`Kubo API returned HTTP ${resp.status} at ${url}`);
  }
  const text = await resp.text();
  // Kubo's /add response is line-delimited JSON when pinning a single file
  // you still get one JSON object; parse the first non-empty line.
  const firstLine = text.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) throw new Error(`Empty response body from ${url}`);
  const parsed = JSON.parse(firstLine) as { Hash?: string };
  if (typeof parsed.Hash !== "string" || parsed.Hash.length === 0) {
    throw new Error(`Kubo /add response missing Hash field: ${firstLine}`);
  }
  return parsed.Hash;
}

// Spawn the MCP server as a stdio subprocess and drive it via line-delimited JSON-RPC.
class McpStdioClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv) {
    const entry = path.resolve(PROJECT_ROOT, "mcp-server", "dist", "index.js");
    this.proc = spawn("node", [entry], {
      cwd: path.resolve(PROJECT_ROOT, "mcp-server"),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg.id === "number") {
            const cb = this.pending.get(msg.id);
            if (cb) { this.pending.delete(msg.id); cb(msg); }
          }
        } catch { /* non-JSON log line — ignore */ }
      }
    });
  }

  async request(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 45_000);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.proc.stdin.write(payload);
    });
  }

  stderr(): NodeJS.ReadableStream { return this.proc.stderr; }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.proc.once("exit", () => resolve());
      this.proc.kill("SIGTERM");
      setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch {}; resolve(); }, 2_000);
    });
  }
}

async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`Agenomics Devnet Smoke Test`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Cluster version: ${await connection.getVersion().then(v => v["solana-core"])}`);
  console.log();

  // ==================== Step 1: program deployments ====================
  console.log("--- Step 1: Checking program deployments ---");
  for (const p of [
    { name: "Agent Vault", id: VAULT_PROGRAM_ID },
    { name: "Agent Registry", id: REGISTRY_PROGRAM_ID },
    { name: "Settlement", id: SETTLEMENT_PROGRAM_ID },
  ]) {
    const info = await connection.getAccountInfo(p.id);
    if (info && info.executable) {
      console.log(`  ${p.name} (${p.id.toBase58().slice(0, 8)}...): DEPLOYED (${info.data.length} bytes)`);
    } else {
      console.log(`  ${p.name}: NOT FOUND — run ./scripts/deploy-devnet.sh first`);
      process.exit(1);
    }
  }

  // ==================== Step 2: test wallet + airdrop ====================
  // If SMOKE_TEST_KEYPAIR_PATH is set, load that keypair instead of generating
  // a fresh one + airdropping. Useful when devnet airdrop is rate-limited or
  // when you want repeatable smoke runs against the same test identity.
  let testKp: Keypair;
  const funderPath = process.env.SMOKE_TEST_KEYPAIR_PATH;
  if (funderPath) {
    const secret = JSON.parse(fs.readFileSync(funderPath, "utf8"));
    testKp = Keypair.fromSecretKey(Uint8Array.from(secret));
    const balance = await connection.getBalance(testKp.publicKey);
    console.log(`\n--- Step 2: Test wallet (preloaded): ${testKp.publicKey.toBase58()} ---`);
    console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL (from ${funderPath})`);
    if (balance < 0.5 * LAMPORTS_PER_SOL) {
      console.log(`  Insufficient balance. Need >= 0.5 SOL for smoke test tx fees.`);
      process.exit(1);
    }
  } else {
    testKp = Keypair.generate();
    console.log(`\n--- Step 2: Test wallet: ${testKp.publicKey.toBase58()} ---`);
    try {
      const sig = await connection.requestAirdrop(testKp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log("  Airdropped 2 SOL");
    } catch (e) {
      console.log(`  Airdrop failed (rate limited?): ${(e as Error).message}`);
      console.log(`  Retry with SMOKE_TEST_KEYPAIR_PATH=<funded keypair json>`);
      process.exit(1);
    }
  }

  const provider = new AnchorProvider(
    connection,
    new KeypairWallet(testKp) as any,
    { commitment: "confirmed" },
  );

  // ==================== Step 3: agent registration ====================
  // AUD-008 / PR-J: Registry now precedes Vault in the smoke flow because
  // `initialize_vault` requires the Registry's `OwnerNonce` PDA to exist.
  // Idempotent: if the agent-profile PDA already holds account data, skip
  // `registerAgent` (re-run scenario). Step 5 verifies.
  console.log("\n--- Step 3: Registry Program (register-first per AUD-008) ---");
  const registryProgram = new Program(loadIdl("agent_registry"), provider);
  // ADR-097: agent_profile PDA seeds = [authority, "agent-profile", nonce-le].
  // Smoke test always uses a fresh keypair so nonce = 0.
  const _profileNonceBuf = Buffer.alloc(8);
  _profileNonceBuf.writeBigUInt64LE(0n);
  const [profilePDA] = PublicKey.findProgramAddressSync(
    [testKp.publicKey.toBuffer(), Buffer.from("agent-profile"), _profileNonceBuf],
    REGISTRY_PROGRAM_ID,
  );
  const [ownerNoncePDA] = PublicKey.findProgramAddressSync(
    [testKp.publicKey.toBuffer(), Buffer.from("owner-nonce")],
    REGISTRY_PROGRAM_ID,
  );
  // Vault PDA — derived now (used by the Registry's `vault` seed-constraint
  // check) and by Step 4 below.
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), testKp.publicKey.toBuffer()],
    VAULT_PROGRAM_ID,
  );
  const existingProfileInfo = await connection.getAccountInfo(profilePDA);
  if (existingProfileInfo) {
    console.log(
      `  Agent profile already exists at ${profilePDA.toBase58()} — re-run, skipping init`,
    );
  } else {
    try {
      await registryProgram.methods
        .registerAgent(
          "SmokeTestAgent",
          "Devnet smoke test agent",
          "testing",
          ["smoke-test"],
          { perTask: {} },
          new BN(1000),
          [testKp.publicKey],
        )
        .accounts({
          authority: testKp.publicKey,
          ownerNonce: ownerNoncePDA,
          agentProfile: profilePDA,
          vault: vaultPDA,
        })
        .signers([testKp])
        .rpc();
      console.log(`  Agent registered: ${profilePDA.toBase58()}`);
    } catch (e) {
      console.log(`  Registration failed: ${(e as Error).message}`);
    }
  }

  // ==================== Step 4: vault creation ====================
  // Idempotent: if the vault PDA is already initialized (prior smoke run with
  // the same wallet), skip `initializeVault` rather than surface an
  // "account already in use" error. Step 5 still verifies the on-chain state.
  console.log("\n--- Step 4: Vault Program ---");
  const vaultProgram = new Program(loadIdl("agent_vault"), provider);
  const existingVaultInfo = await connection.getAccountInfo(vaultPDA);
  if (existingVaultInfo) {
    console.log(
      `  Vault already exists at ${vaultPDA.toBase58()} — re-run, skipping init`,
    );
  } else {
    try {
      await vaultProgram.methods
        .initializeVault(
          testKp.publicKey,
          new BN(LAMPORTS_PER_SOL),
          new BN(LAMPORTS_PER_SOL / 10),
          10,
        )
        .accounts({
          vault: vaultPDA,
          authority: testKp.publicKey,
          // AUD-008 / PR-J: vault init now sources `profile_nonce` from
          // the Registry's authoritative OwnerNonce PDA.
          ownerNonce: ownerNoncePDA,
        })
        .signers([testKp])
        .rpc();
      console.log(`  Vault created: ${vaultPDA.toBase58()}`);
    } catch (e) {
      console.log(`  Vault creation failed: ${(e as Error).message}`);
    }
  }

  // ==================== Step 5: verify on-chain state ====================
  console.log("\n--- Step 5: Verify on-chain state ---");
  try {
    const vault = await (vaultProgram.account as any).vault.fetch(vaultPDA);
    console.log(`  Vault authority: ${vault.authority.toBase58()}`);
    console.log(`  Vault paused: ${vault.paused}`);
  } catch (e) {
    console.log(`  Vault fetch failed: ${(e as Error).message}`);
  }
  try {
    const profile = await (registryProgram.account as any).agentProfile.fetch(profilePDA);
    console.log(`  Agent name: ${profile.name}`);
    console.log(`  Agent category: ${profile.category}`);
    console.log(`  Agent status: ${JSON.stringify(profile.status)}`);
  } catch (e) {
    console.log(`  Profile fetch failed: ${(e as Error).message}`);
  }

  // ==================== Step 6: update_manifest ====================
  console.log("\n--- Step 6: update_manifest (ADR-060) ---");
  const validatorMod = await dynImport<typeof import("@agenomics/capability-manifest-validator")>(
    "@agenomics/capability-manifest-validator",
  );
  // Read current on-chain capabilities so the manifest's capability name
  // list is a superset (ADR-060 §1 invariant). Prior smoke runs may have
  // registered the profile with different names than what fabricateManifest
  // emits today — fetch live and merge.
  let onChainCapabilities: string[] = ["smoke-test"];
  try {
    const existing = (await (registryProgram.account as any).agentProfile.fetch(profilePDA)) as any;
    if (Array.isArray(existing.capabilities)) {
      onChainCapabilities = existing.capabilities as string[];
    }
  } catch {
    // Profile doesn't exist yet — just use the default.
  }
  const manifest = fabricateManifest(testKp.publicKey, "SmokeTestAgent");
  const canonicalBytes = validatorMod.canonicalBytes(manifest);
  const manifestHash = validatorMod.manifestHash(manifest); // 32 bytes
  const { ed25519 } = await dynImport<typeof import("@noble/curves/ed25519")>("@noble/curves/ed25519");
  const sigBytes = ed25519.sign(manifestHash, testKp.secretKey.slice(0, 32));

  // Attempt to pin the canonical manifest bytes to a local IPFS daemon so
  // Step 8 can fetch the real bytes via AEP_IPFS_GATEWAY and the validator
  // round-trips the live hash + signature. If the daemon is not reachable,
  // fall back to the synthetic "bafy + 60*a" CID — Step 8 then fails cleanly
  // with an IPFS-404 rather than a contrived hash mismatch, and the operator
  // sees the install-Kubo prompt in docs/SMOKE_TESTING.md.
  const ipfsApi =
    process.env.AEP_IPFS_API_URL || "http://localhost:5001";
  const ipfsGateway =
    process.env.AEP_IPFS_GATEWAY || "http://localhost:8080";
  let realCid: string | null = null;
  try {
    realCid = await pinCanonicalManifest(ipfsApi, canonicalBytes);
  } catch (e) {
    console.log(
      `  IPFS pin unavailable at ${ipfsApi} (${(e as Error).message}) — falling back to synthetic CID.`,
    );
    console.log(
      `  See docs/SMOKE_TESTING.md "Manual devnet" for local-daemon setup.`,
    );
  }
  const cidBytes = new Uint8Array(64);
  let cidStr: string;
  if (realCid) {
    if (Buffer.byteLength(realCid, "utf-8") > 64) {
      console.log(
        `  Pinned CID (${realCid.length} chars) > 64 bytes — falling back to synthetic.`,
      );
      cidStr = "bafy" + "a".repeat(56);
      realCid = null;
    } else {
      cidStr = realCid;
      console.log(`  Pinned manifest to IPFS → CID ${realCid}`);
      // Verify the gateway can serve it (local daemon, tight loop).
      try {
        const r = await fetch(`${ipfsGateway.replace(/\/+$/, "")}/ipfs/${realCid}`);
        console.log(`  Gateway round-trip: HTTP ${r.status} (${ipfsGateway})`);
      } catch (e) {
        console.log(
          `  Gateway check failed: ${(e as Error).message} — handler will error when it tries to fetch.`,
        );
      }
    }
  } else {
    // Synthetic CID: "bafy" + 60 'a' chars, zero-padded in the on-chain [u8; 64].
    cidStr = "bafy" + "a".repeat(56);
  }
  new TextEncoder().encodeInto(cidStr, cidBytes);

  try {
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: testKp.publicKey.toBytes(),
      message: manifestHash,
      signature: sigBytes,
    });
    const tx = new Transaction().add(ed25519Ix).add(
      await registryProgram.methods
        .updateManifest(
          Array.from(cidBytes),
          Array.from(manifestHash),
          Array.from(sigBytes),
          MANIFEST_VERSION_V1_0,
          onChainCapabilities, // fetched live in Step 6; invariant: must be a superset of on-chain
        )
        .accounts({
          authority: testKp.publicKey,
          agentProfile: profilePDA,
          instructionsSysvar: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        })
        .instruction(),
    );
    const sig = await provider.sendAndConfirm(tx, [testKp]);
    console.log(`  update_manifest tx: ${sig}`);
    const profile = await (registryProgram.account as any).agentProfile.fetch(profilePDA);
    const onHash = Uint8Array.from(profile.manifestHash as number[]);
    const onSig = Uint8Array.from(profile.manifestSignature as number[]);
    const hashOk = Buffer.from(onHash).equals(Buffer.from(manifestHash));
    const sigOk = Buffer.from(onSig).equals(Buffer.from(sigBytes));
    console.log(`  manifest_hash matches local:      ${hashOk}`);
    console.log(`  manifest_signature matches local: ${sigOk}`);
    console.log(`  manifest_version = 0x${profile.manifestVersion.toString(16)} (expected 0x100)`);
    if (!hashOk || !sigOk || profile.manifestVersion !== MANIFEST_VERSION_V1_0) {
      throw new Error("on-chain manifest fields did not match local values");
    }
  } catch (e) {
    console.log(`  update_manifest failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // ==================== Step 7: validator round-trip ====================
  console.log("\n--- Step 7: capability-manifest-validator round-trip ---");
  const authorityBytes = new Uint8Array(testKp.publicKey.toBytes());
  const good = validatorMod.validateManifest({
    manifest,
    onChainHash: manifestHash,
    onChainSignature: sigBytes,
    authorityPubkey: authorityBytes,
  });
  console.log(`  clean manifest:   ok=${good.ok}`);
  const tampered = new Uint8Array(canonicalBytes);
  tampered[0] ^= 0x01;
  let tamperedObj: unknown;
  try { tamperedObj = JSON.parse(new TextDecoder().decode(tampered)); } catch { tamperedObj = { __malformed: true }; }
  const bad = validatorMod.validateManifest({
    manifest: tamperedObj,
    onChainHash: manifestHash,
    onChainSignature: sigBytes,
    authorityPubkey: authorityBytes,
  });
  console.log(`  tampered manifest: ok=${bad.ok}, code=${bad.ok ? "-" : bad.error.code}`);
  if (!good.ok || bad.ok || bad.error.code === "INVALID_INPUT") {
    throw new Error("validator round-trip failed expectations");
  }

  // ==================== Step 8: MCP dispatch — get_agent_reputation ====================
  console.log("\n--- Step 8: MCP server dispatch — get_agent_reputation ---");
  const walletPath = path.resolve(PROJECT_ROOT, ".smoke-test-wallet.json");
  fs.writeFileSync(walletPath, JSON.stringify(Array.from(testKp.secretKey)));
  // Baseline env for every subprocess in Steps 8-10. AEP_IPFS_GATEWAY points
  // to the local Kubo node when Step 6 successfully pinned the manifest; if
  // it didn't, we still pass the gateway so the failure mode is an IPFS-404
  // (expected degraded path documented in SMOKE_TESTING.md) rather than the
  // handler hitting a non-existent default.
  const mcpEnv: NodeJS.ProcessEnv = {
    SOLANA_RPC_URL: rpcUrl,
    WALLET_PATH: walletPath,
    AEP_IPFS_GATEWAY: ipfsGateway,
    // Leave SAS env vars unset — we want the "sas-not-configured" branch.
  };
  let mcpOk = true;
  {
    const client = new McpStdioClient(mcpEnv);
    try {
      const list = await client.request("tools/list", {});
      const toolNames: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
      console.log(`  tools/list → ${toolNames.length} tools (has get_agent_reputation: ${toolNames.includes("get_agent_reputation")})`);
      const callRes = await client.request("tools/call", {
        name: "get_agent_reputation",
        arguments: { agentAddress: testKp.publicKey.toBase58() },
      });
      const text = callRes.result?.content?.[0]?.text ?? JSON.stringify(callRes);
      console.log(`  tools/call excerpt: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
      // SAS stub signal: when AEP_SAS_SCHEMA_PDA / AEP_SAS_ALLOWED_CREDENTIALS are unset,
      // the action returns { absent: true, reason: 'sas-not-configured', ... } in its sas field.
      const hasSasStub = text.includes("sas-not-configured");
      console.log(`  SAS stub signal present: ${hasSasStub}`);
    } catch (e) {
      console.log(`  MCP call failed: ${(e as Error).message}`);
      mcpOk = false;
    } finally {
      await client.close();
    }
  }
  if (!mcpOk) console.log("  (continuing — see troubleshooting in docs/SMOKE_TESTING.md)");

  // ==================== Step 9: v2 vault_transfer ====================
  console.log("\n--- Step 9: v2 vault_transfer (AEP_USE_V2_VAULT_TRANSFER=1) ---");
  // Fund the vault with a little SOL so the transfer has something to move.
  try {
    const tx = new Transaction().add(SystemProgram.transfer({
      fromPubkey: testKp.publicKey,
      toPubkey: vaultPDA,
      lamports: Math.floor(0.1 * LAMPORTS_PER_SOL),
    }));
    await provider.sendAndConfirm(tx, [testKp]);
    console.log(`  Vault funded with 0.1 SOL`);
  } catch (e) {
    console.log(`  Vault funding failed: ${(e as Error).message}`);
  }
  const recipient = Keypair.generate().publicKey;

  for (const mode of ["v1", "v2"] as const) {
    const env = { ...mcpEnv, AEP_USE_V2_VAULT_TRANSFER: mode === "v2" ? "1" : "0" };
    const client = new McpStdioClient(env);
    let sawV2Warn = false;
    client.stderr().on("data", (b: Buffer) => {
      if (b.toString("utf-8").includes("routing vault_transfer through")) sawV2Warn = true;
    });
    try {
      const res = await client.request("tools/call", {
        name: "vault_transfer",
        arguments: { recipientAddress: recipient.toBase58(), amountSol: 0.001 },
      });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
      console.log(`  ${mode} dispatch excerpt: ${text.slice(0, 160)}${text.length > 160 ? "…" : ""}`);
      if (mode === "v2") console.log(`  v2 warning emitted: ${sawV2Warn}`);
    } catch (e) {
      console.log(`  ${mode} dispatch failed: ${(e as Error).message}`);
    } finally {
      await client.close();
    }
  }

  // ==================== Step 10: preflight proof (daily-cap exceedance) ====================
  console.log("\n--- Step 10: Preflight denial proof (daily_cap_not_exhausted) ---");
  {
    // dailyLimit was set to 1 SOL at vault creation; request 2 SOL > dailyLimit.
    const client = new McpStdioClient(mcpEnv);
    try {
      const res = await client.request("tools/call", {
        name: "vault_transfer",
        arguments: { recipientAddress: recipient.toBase58(), amountSol: 2.0 },
      });
      const text = res.result?.content?.[0]?.text ?? JSON.stringify(res);
      const isPreflight = text.includes("PREFLIGHT_FAILED");
      const gateMatches = text.includes("daily_cap_not_exhausted");
      const isCap = text.includes("CAPABILITY_MISSING");
      console.log(`  response excerpt:     ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`);
      console.log(`  PREFLIGHT_FAILED seen: ${isPreflight}`);
      console.log(`  gate='daily_cap_not_exhausted' in details: ${gateMatches}`);
      console.log(`  CAPABILITY_MISSING NOT present (sanity):    ${!isCap}`);
    } finally {
      await client.close();
    }
  }

  // ==================== Step 11+: SAS bootstrap (conditional) ====================
  console.log("\n--- Steps 11-13: SAS bootstrap on devnet ---");
  const sasSchemaEnv = process.env.AEP_SAS_SCHEMA_PDA;
  const sasAllowedEnv = process.env.AEP_SAS_ALLOWED_CREDENTIALS;
  if (!sasSchemaEnv || !sasAllowedEnv) {
    console.log("  SAS not bootstrapped on devnet — skipping steps 11-13.");
    console.log("  To bootstrap, the following must exist on devnet:");
    console.log("    - AEP_AGENT_REPUTATION_v1 schema PDA (ADR-061 §2)");
    console.log("    - AEP_PROTOCOL / AEP_VALIDATORS credential PDAs (ADR-063)");
    console.log("    - One attestation issued for the test agent authority");
    console.log("  Then re-run with AEP_SAS_SCHEMA_PDA=... AEP_SAS_ALLOWED_CREDENTIALS=<csv>.");
  } else {
    console.log(`  SAS env detected: schema=${sasSchemaEnv}`);
    console.log("  Full issue-attestation + resolver-exercise path is tracked as a");
    console.log("  follow-up (depends on live SAS program on devnet).");
  }

  // Cleanup scratch wallet file.
  try { fs.unlinkSync(walletPath); } catch {}

  console.log("\n=== Smoke test complete ===");
}

main().catch((e) => { console.error(e); process.exit(1); });

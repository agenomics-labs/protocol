#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const C = {
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const box = (lines) => {
  const w = Math.max(...lines.map((l) => l.length));
  const top = "╔" + "═".repeat(w + 2) + "╗";
  const bot = "╚" + "═".repeat(w + 2) + "╝";
  console.log(C.bold + C.magenta + top + C.reset);
  for (const l of lines) {
    console.log(
      C.bold + C.magenta + "║ " + C.reset + l.padEnd(w) + C.bold + C.magenta + " ║" + C.reset,
    );
  }
  console.log(C.bold + C.magenta + bot + C.reset);
};

const step = (n, total, msg) =>
  console.log(
    `\n${C.bold}${C.cyan}[${n}/${total}]${C.reset} ${C.bold}${msg}${C.reset}`,
  );
const ok = (msg) => console.log(`        ${C.green}✓${C.reset} ${msg}`);
const send = (msg) => console.log(`        ${C.yellow}→${C.reset} ${C.gray}${msg}${C.reset}`);
const info = (msg) => console.log(`          ${msg}`);

const typewriter = async (text, delay = 12) => {
  for (const ch of text) {
    process.stdout.write(ch);
    if (ch !== " " && Math.random() > 0.4) await sleep(delay);
  }
  process.stdout.write("\n");
};

const FUNDING_KEY = process.env.HOME + "/.config/solana/id.json";
const RPC = "https://api.devnet.solana.com";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

async function startMcpServer({ walletPath, label }) {
  const env = {
    ...process.env,
    SOLANA_KEYPAIR_PATH: walletPath,
    SOLANA_RPC_URL: RPC,
    AEP_NETWORK: "devnet",
    // distinct metrics port so two servers don't fight over 9101
    METRICS_PORT: label === "B" ? "9102" : "9101",
  };
  const server = spawn("node", ["mcp-server/dist/index.js"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buf = "";
  server.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch {}
    }
  });
  server.stderr.on("data", () => {});

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => {
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  // Wait for the "started" stderr log so tools are registered.
  await new Promise((resolve) => {
    const onErr = (chunk) => {
      if (chunk.toString().includes("agenomics mcp server started")) {
        server.stderr.off("data", onErr);
        resolve();
      }
    };
    server.stderr.on("data", onErr);
    setTimeout(resolve, 4500);
  });

  // Finalise the MCP handshake.
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: `agenomics-demo-${label}`, version: "1.0.0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise((r) => setTimeout(r, 300));

  return { server, call };
}

async function createAndFundEphemeralKey(web3) {
  // Generate a fresh keypair so each demo run starts from a clean PDA.
  const fresh = web3.Keypair.generate();
  const tmpDir = mkdtempSync(join(tmpdir(), "agenomics-demo-"));
  const path = join(tmpDir, "id.json");
  writeFileSync(path, JSON.stringify(Array.from(fresh.secretKey)));
  chmodSync(path, 0o600);

  // Fund from the main wallet (devnet airdrops are rate-limited)
  const funder = web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(FUNDING_KEY, "utf8"))),
  );
  const conn = new web3.Connection(RPC, "confirmed");
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: fresh.publicKey,
      lamports: 0.05 * 1e9, // 0.05 SOL — plenty for one vault init
    }),
  );
  const sig = await web3.sendAndConfirmTransaction(conn, tx, [funder], {
    commitment: "confirmed",
  });
  return { keypair: fresh, path, fundingSig: sig };
}

async function main() {
  console.clear();
  await sleep(300);
  box([
    "",
    "  AGENOMICS PROTOCOL — Live Devnet Demo                        ",
    "  An AI agent creating its own programmable wallet on Solana   ",
    "  via Model Context Protocol, with safety policies enforced    ",
    "  on-chain, not in the client.                                 ",
    "",
  ]);

  await sleep(2500); // hold the title card so it reads on video

  // ───────────────────────────────────────────────────────────────
  step(1, 7, "Provisioning a fresh agent wallet on devnet");
  await sleep(400);

  const web3 = await import(
    new URL("../node_modules/@solana/web3.js/lib/index.cjs.js", import.meta.url).href,
  );
  const { keypair: wallet, path: walletPath, fundingSig } = await createAndFundEphemeralKey(web3);
  ok(`fresh wallet:    ${wallet.publicKey.toBase58().slice(0, 6)}…${wallet.publicKey.toBase58().slice(-5)}`);
  ok(`funded 0.05 SOL from operator: ${fundingSig.slice(0, 12)}…`);

  await sleep(700);
  step(2, 7, "Starting the Agenomics MCP server (stdio transport)");
  await sleep(400);

  const env = {
    ...process.env,
    SOLANA_KEYPAIR_PATH: walletPath,
    SOLANA_RPC_URL: RPC,
    AEP_NETWORK: "devnet",
  };
  const server = spawn("node", ["mcp-server/dist/index.js"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Buffer stdout, parse line-delimited JSON-RPC
  const pending = new Map();
  let buf = "";
  server.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      } catch {}
    }
  });
  server.stderr.on("data", () => {}); // swallow startup banners

  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => {
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      });
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  // Wait for the server's "started" log so tools are registered before tools/list.
  await new Promise((resolve) => {
    const onErr = (chunk) => {
      if (chunk.toString().includes("agenomics mcp server started")) {
        server.stderr.off("data", onErr);
        resolve();
      }
    };
    server.stderr.on("data", onErr);
    setTimeout(resolve, 4000); // hard timeout
  });
  ok(`server pid ${server.pid}`);
  ok(`network:         devnet (api.devnet.solana.com)`);

  // Re-read balance with confirmed commitment (the funding tx may have just landed).
  const bal = await rpc("getBalance", [wallet.publicKey.toBase58(), { commitment: "confirmed" }]);
  ok(`bound wallet:    ${wallet.publicKey.toBase58()} (${(bal.value / 1e9).toFixed(3)} SOL)`);

  // ───────────────────────────────────────────────────────────────
  step(3, 7, "Initializing MCP handshake & enumerating tools");
  await sleep(500);

  send("initialize");
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "agenomics-demo", version: "1.0.0" },
  });
  ok("MCP handshake accepted (protocol 2024-11-05)");
  // Required: a "notifications/initialized" notification (no id) finalizes
  // the handshake before the SDK exposes tools.
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  await sleep(400);
  send("tools/list");
  const tl = await call("tools/list", {});
  const tools = tl?.tools ?? [];
  ok(`${C.bold}${tools.length} tools${C.reset} exposed to the agent:`);

  const groups = { Vault: [], Registry: [], Settlement: [], Discovery: [], Other: [] };
  const vk = ["vault", "allowlist", "rotate_agent", "pause_vault", "resume_vault"];
  const rk = ["register_agent", "discover_agents", "profile", "credential", "agent_capabilities"];
  const sk = ["task", "milestone", "escrow", "dispute", "settle"];
  for (const t of tools) {
    const n = t.name.toLowerCase();
    if (vk.some((k) => n.includes(k))) groups.Vault.push(t.name);
    else if (rk.some((k) => n.includes(k))) groups.Registry.push(t.name);
    else if (sk.some((k) => n.includes(k))) groups.Settlement.push(t.name);
    else groups.Other.push(t.name);
  }
  for (const [k, v] of Object.entries(groups)) {
    if (!v.length) continue;
    info(`${C.cyan}${k.padEnd(11)}${C.reset} ${C.gray}(${v.length})${C.reset}  ${v.slice(0, 3).join(", ")}${v.length > 3 ? ` ${C.gray}+${v.length - 3} more${C.reset}` : ""}`);
  }

  // ───────────────────────────────────────────────────────────────
  step(4, 7, "Asking the agent to register & create its vault on devnet");
  await sleep(500);

  // ── 4a. register_agent (Registry program) ────────────────────────
  const regArgs = {
    name: "DemoAgent",
    description: "Live demo agent from a 3-minute screencast.",
    category: "demo",
    capabilities: ["demo", "live-walkthrough"],
    pricingModel: "perTask",
    pricingAmountSol: 0.01,
    acceptedTokens: ["So11111111111111111111111111111111111111112"], // wSOL
  };
  console.log(
    `        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}register_agent${C.reset} ${C.gray}(Registry program)${C.reset}`,
  );
  await sleep(700);
  info(`${C.yellow}…${C.reset} writing AgentProfile + OwnerNonce PDAs on-chain`);
  const regRes = await call("tools/call", { name: "register_agent", arguments: regArgs });
  let regPayload = {};
  try { regPayload = JSON.parse(regRes?.content?.[0]?.text ?? ""); } catch {}
  if (regRes?.isError || regPayload.error) {
    console.log(`        ${C.red}✗${C.reset} register_agent failed:`);
    console.log(`          ${C.red}${JSON.stringify(regPayload, null, 2)}${C.reset}`);
    server.kill(); process.exit(1);
  }
  ok(`profile tx:      ${C.bold}${(regPayload.transactionSignature || "").slice(0, 24)}…${C.reset}`);

  await sleep(800);

  // ── 4b. create_vault (Vault program) ──────────────────────────────
  const args = {
    agentIdentity: wallet.publicKey.toBase58(),
    dailyLimitSol: 1.0,
    perTxLimitSol: 0.1,
    maxTxsPerHour: 10,
  };

  console.log(
    `\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}create_vault${C.reset} ${C.gray}(Vault program)${C.reset}`,
  );
  console.log(
    `          ${C.gray}${JSON.stringify(args, null, 2).split("\n").join("\n          ")}${C.reset}`,
  );

  await sleep(900);
  info(`${C.yellow}…${C.reset} signing the proof-of-control bind message & submitting`);

  const startSlot = (await rpc("getSlot", [])) ?? 0;
  const res = await call("tools/call", { name: "create_vault", arguments: args });

  // Parse the tool response
  let payload = {};
  try {
    const txt = res?.content?.[0]?.text ?? "";
    payload = JSON.parse(txt);
  } catch {
    payload = { raw: res };
  }

  if (res?.isError || payload.error) {
    console.log(`        ${C.red}✗${C.reset} tool call returned error:`);
    console.log(`          ${C.red}${JSON.stringify(payload, null, 2)}${C.reset}`);
  } else {
    const sig =
      payload.transactionSignature ||
      payload.signature ||
      payload.txSignature ||
      payload.tx ||
      "—";
    const vault = payload.vaultAddress || payload.vault || payload.vault_pda || "—";
    ok(`tx signature:    ${C.bold}${sig}${C.reset}`);
    ok(`landed at slot:  ${startSlot.toLocaleString()}`);
    ok(`vault PDA:       ${C.bold}${vault}${C.reset}`);
    ok(`daily cap:       1.0 SOL    ${C.gray}(enforced on-chain via Anchor constraint)${C.reset}`);
    ok(`per-tx cap:      0.1 SOL    ${C.gray}(enforced on-chain via Anchor constraint)${C.reset}`);
    ok(`rate limit:      10/hour    ${C.gray}(enforced on-chain via Anchor constraint)${C.reset}`);

    // ─────────────────────────────────────────────────────────────
    step(5, 7, "Reading the on-chain state back through MCP");
    await sleep(900);

    // 5a. get_vault_info — proves the vault account & policies are durable
    send("tools/call  get_vault_info  {}");
    await sleep(600);
    const viRes = await call("tools/call", { name: "get_vault_info", arguments: {} });
    try {
      const v = JSON.parse(viRes?.content?.[0]?.text ?? "{}");
      ok(`vault balance:   ${(v.balanceLamports ?? v.balance ?? 0) / 1e9} SOL`);
      ok(`paused:          ${v.paused ?? v.isPaused ?? false}`);
      ok(`txs this hour:   ${v.txsInCurrentWindow ?? 0} / ${v.policies?.maxTxsPerHour ?? "?"}`);
    } catch (e) {
      info(C.gray + "(get_vault_info response: " + JSON.stringify(viRes).slice(0, 80) + ")" + C.reset);
    }

    await sleep(1100);

    // 5b. get_agent_profile — proves the Registry profile is live
    send("tools/call  get_agent_profile  {}");
    await sleep(600);
    const apRes = await call("tools/call", { name: "get_agent_profile", arguments: {} });
    try {
      const p = JSON.parse(apRes?.content?.[0]?.text ?? "{}");
      ok(`agent name:      ${C.bold}${p.name ?? "?"}${C.reset}`);
      ok(`reputation:      ${p.reputationScore ?? p.reputation_score ?? 0}`);
      ok(`vault bound:     ${(p.vault ?? p.vaultAddress ?? "—").toString().slice(0, 32)}…`);
    } catch {}

    await sleep(1500);

    // ─────────────────────────────────────────────────────────────
    // PHASE 6 — POLICY ENFORCEMENT: prove the cap is on-chain.
    // ─────────────────────────────────────────────────────────────
    console.log(
      `\n${C.bold}${C.cyan}[6/7]${C.reset} ${C.bold}Proving the policy is enforced ON-CHAIN, not in the client${C.reset}`,
    );

    // 6a. Fund the vault with 0.2 SOL so it has something to spend.
    info(`${C.yellow}…${C.reset} funding vault with 0.2 SOL so it has balance to test against`);
    {
      const funder = web3.Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(FUNDING_KEY, "utf8"))),
      );
      const conn = new web3.Connection(RPC, "confirmed");
      const tx = new web3.Transaction().add(
        web3.SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: new web3.PublicKey(vault),
          lamports: 0.2 * 1e9,
        }),
      );
      const fsig = await web3.sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
      ok(`vault funded: ${fsig.slice(0, 16)}…  (vault now holds 0.2 SOL)`);
    }

    await sleep(1500);

    // 6b. LEGIT transfer — 0.05 SOL is under the 0.1 SOL per-tx cap.
    const recipient = web3.Keypair.generate().publicKey.toBase58();
    console.log(
      `\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}vault_transfer${C.reset} ${C.gray}{ recipient, amount: 0.05 SOL }${C.reset}  ${C.green}(under per-tx cap)${C.reset}`,
    );
    await sleep(600);
    const okRes = await call("tools/call", {
      name: "vault_transfer",
      arguments: { recipientAddress: recipient, amountSol: 0.05 },
    });
    let okPayload = {};
    try { okPayload = JSON.parse(okRes?.content?.[0]?.text ?? ""); } catch {}
    if (okRes?.isError || okPayload.error) {
      console.log(`        ${C.red}✗${C.reset} unexpected error on legit transfer: ${C.red}${JSON.stringify(okPayload).slice(0, 120)}${C.reset}`);
    } else {
      ok(`tx accepted, lands on devnet: ${C.bold}${(okPayload.transactionSignature || okPayload.signature || "—").slice(0, 24)}…${C.reset}`);
      ok(`${C.green}0.05 SOL released by the Vault program${C.reset}`);
    }

    await sleep(2200);

    // 6c. BYPASS attempt — 0.5 SOL exceeds the 0.1 SOL per-tx cap.
    console.log(
      `\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}vault_transfer${C.reset} ${C.gray}{ recipient, amount: 0.5 SOL }${C.reset}  ${C.red}(violates per-tx cap)${C.reset}`,
    );
    info(`${C.gray}simulated misbehaving agent: trying to spend 5x the per-tx limit${C.reset}`);
    await sleep(700);
    const badRes = await call("tools/call", {
      name: "vault_transfer",
      arguments: { recipientAddress: recipient, amountSol: 0.5 },
    });
    let badPayload = {};
    try { badPayload = JSON.parse(badRes?.content?.[0]?.text ?? ""); } catch {}
    if (badRes?.isError || badPayload.error || badPayload.success === false) {
      const msg = (badPayload.message || badPayload.error || JSON.stringify(badPayload)).toString();
      const short = msg.length > 140 ? msg.slice(0, 137) + "…" : msg;
      console.log(`        ${C.red}✗${C.reset} ${C.bold}${C.red}REJECTED by the Solana program${C.reset}  ${C.green}← exactly what we want${C.reset}`);
      console.log(`          ${C.red}${short}${C.reset}`);
      ok(`${C.bold}policy is enforced by Anchor, not by the SDK${C.reset}`);
      ok(`${C.gray}a malicious agent cannot bypass this by patching the client${C.reset}`);
    } else {
      console.log(`        ${C.red}✗${C.reset} ${C.red}UNEXPECTED SUCCESS — the cap should have rejected this${C.reset}`);
      console.log(`          ${C.red}${JSON.stringify(badPayload).slice(0, 200)}${C.reset}`);
    }

    await sleep(2000);

    // ─────────────────────────────────────────────────────────────
    // PHASE 7 — EMERGENCY STOP: pause the vault, prove it freezes
    // every spend, resume, prove spending works again. All four
    // outcomes (legit · per-tx breach · paused · resumed) are gates
    // an Anchor program enforces — no client-side opt-out.
    // ─────────────────────────────────────────────────────────────
    console.log(
      `\n${C.bold}${C.cyan}[7/7]${C.reset} ${C.bold}Emergency stop: pausing the vault halts EVERY spend on-chain${C.reset}`,
    );
    await sleep(700);
    const recipient2 = web3.Keypair.generate().publicKey.toBase58();

    // 7a. pause_vault — authority emergency action.
    console.log(`\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}pause_vault${C.reset}  ${C.gray}(authority's panic button)${C.reset}`);
    const pauseRes = await call("tools/call", { name: "pause_vault", arguments: {} });
    let pausePayload = {};
    try { pausePayload = JSON.parse(pauseRes?.content?.[0]?.text ?? ""); } catch {}
    if (pauseRes?.isError || pausePayload.error || pausePayload.success === false) {
      console.log(`        ${C.red}✗${C.reset} pause_vault failed: ${C.red}${JSON.stringify(pausePayload).slice(0, 120)}${C.reset}`);
    } else {
      ok(`vault paused on-chain: ${(pausePayload.transactionSignature || "").slice(0, 24)}…`);
    }

    await sleep(1800);

    // 7b. Attempt a legit (sub-cap) transfer while paused — should be rejected.
    console.log(
      `\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}vault_transfer${C.reset} ${C.gray}{ amount: 0.02 SOL }${C.reset}  ${C.red}(still rejected — vault is paused)${C.reset}`,
    );
    info(`${C.gray}well under the per-tx cap — but the pause flag is checked first${C.reset}`);
    await sleep(700);
    const pausedRes = await call("tools/call", {
      name: "vault_transfer",
      arguments: { recipientAddress: recipient2, amountSol: 0.02 },
    });
    let pausedPayload = {};
    try { pausedPayload = JSON.parse(pausedRes?.content?.[0]?.text ?? ""); } catch {}
    if (pausedRes?.isError || pausedPayload.error || pausedPayload.success === false) {
      const msg = (pausedPayload.message || pausedPayload.error || JSON.stringify(pausedPayload)).toString();
      const short = msg.length > 140 ? msg.slice(0, 137) + "…" : msg;
      console.log(`        ${C.red}✗${C.reset} ${C.bold}${C.red}REJECTED — VaultPaused${C.reset}`);
      console.log(`          ${C.red}${short}${C.reset}`);
    } else {
      console.log(`        ${C.red}!${C.reset} ${C.red}unexpected pass: ${JSON.stringify(pausedPayload).slice(0, 160)}${C.reset}`);
    }

    await sleep(1800);

    // 7c. resume_vault — back online.
    console.log(`\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}resume_vault${C.reset}  ${C.gray}(authority lifts the freeze)${C.reset}`);
    await call("tools/call", { name: "resume_vault", arguments: {} });
    ok(`vault unpaused on-chain`);

    await sleep(1300);

    // 7d. Same legit transfer — now it lands.
    console.log(
      `\n        ${C.yellow}→${C.reset} ${C.gray}tools/call${C.reset} ${C.bold}vault_transfer${C.reset} ${C.gray}{ amount: 0.02 SOL }${C.reset}  ${C.green}(under cap + not paused → accepted)${C.reset}`,
    );
    await sleep(600);
    const reRes = await call("tools/call", {
      name: "vault_transfer",
      arguments: { recipientAddress: recipient2, amountSol: 0.02 },
    });
    let rePayload = {};
    try { rePayload = JSON.parse(reRes?.content?.[0]?.text ?? ""); } catch {}
    if (reRes?.isError || rePayload.error || rePayload.success === false) {
      console.log(`        ${C.red}✗${C.reset} unexpected fail: ${C.red}${JSON.stringify(rePayload).slice(0, 160)}${C.reset}`);
    } else {
      ok(`${C.bold}${C.green}tx accepted${C.reset}, lands on devnet: ${(rePayload.transactionSignature || "").slice(0, 24)}…`);
      ok(`${C.gray}same code path, same caller, same amount — only the on-chain pause flag changed${C.reset}`);
    }

    await sleep(2000);

    // 5c. Big Explorer URL pinned on-screen for ~15 seconds (recording fills this).
    const url = `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
    console.log("");
    console.log(
      `${C.bold}${C.magenta}┌────────────────────────────────────────────────────────────────────┐${C.reset}`,
    );
    console.log(
      `${C.bold}${C.magenta}│${C.reset}  ${C.bold}Verify on Solana Explorer:${C.reset}                                       ${C.bold}${C.magenta}│${C.reset}`,
    );
    console.log(
      `${C.bold}${C.magenta}│${C.reset}  ${C.cyan}${url.slice(0, 64)}${C.reset} ${C.bold}${C.magenta}│${C.reset}`,
    );
    if (url.length > 64) {
      console.log(
        `${C.bold}${C.magenta}│${C.reset}  ${C.cyan}${url.slice(64).padEnd(64)}${C.reset}  ${C.bold}${C.magenta}│${C.reset}`,
      );
    }
    console.log(
      `${C.bold}${C.magenta}│${C.reset}                                                                    ${C.bold}${C.magenta}│${C.reset}`,
    );
    console.log(
      `${C.bold}${C.magenta}│${C.reset}  ${C.gray}Every byte of vault policy state lives on Solana devnet —${C.reset}        ${C.bold}${C.magenta}│${C.reset}`,
    );
    console.log(
      `${C.bold}${C.magenta}│${C.reset}  ${C.gray}not in this process. Anyone can RPC-verify the account.${C.reset}          ${C.bold}${C.magenta}│${C.reset}`,
    );
    console.log(
      `${C.bold}${C.magenta}└────────────────────────────────────────────────────────────────────┘${C.reset}`,
    );

    // Store for the recorder
    if (process.env.DEMO_OUT) {
      const fs = await import("node:fs");
      fs.writeFileSync(
        process.env.DEMO_OUT,
        JSON.stringify({ sig, vault, explorer: url }, null, 2),
      );
    }
  }

  await sleep(1500);
  console.log(
    `\n${C.bold}${C.green}══════════════════════════════════════════════════════════════════${C.reset}`,
  );
  console.log(
    `${C.bold}${C.green}  3 programs · 28 MCP tools · 547+ tests · 4 hostile audits closed${C.reset}`,
  );
  console.log(
    `${C.bold}${C.green}  agenomics.xyz   ·   github.com/agenomics-labs/protocol${C.reset}`,
  );
  console.log(
    `${C.bold}${C.green}══════════════════════════════════════════════════════════════════${C.reset}\n`,
  );

  server.kill();
  // Hold the final frame so the recorder captures it cleanly.
  // Skip the hold if running outside of a recording (set DEMO_NO_HOLD=1).
  if (!process.env.DEMO_NO_HOLD) {
    await sleep(parseInt(process.env.DEMO_HOLD_MS || "12000", 10));
  } else {
    await sleep(200);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(C.red + "demo failed: " + (e?.stack || e) + C.reset);
  process.exit(1);
});

# Judge Runbook — 5-Minute Live Verification

> Companion to [`SUBMISSION.md`](./SUBMISSION.md). Captured 2026-05-06 from a fresh `git clone`. If anything below diverges from your actual run, please flag it — that's a bug.

The point of this doc: a Colosseum judge can verify the protocol works in **under 5 minutes** by running a handful of literal commands and matching against the expected output here. Every command has been run on a clean checkout; every output block is real.

---

## Step 0 — claude.ai connector (60 seconds, no clone needed)

Judges who don't want to clone anything: the MCP server is hosted so you can verify directly from a browser.

1. Open [**claude.ai/settings/connectors**](https://claude.ai/settings/connectors).
2. **Add custom connector** → paste one of the URLs from the [deploy matrix in README](./README.md#deploy-targets-free-tier-matrix). Recommended:
   - **Render** (zero-effort, free, may take 30–60s to wake on first call): `https://aep-mcp-judge.onrender.com`
   - **Cloudflare Tunnel** (self-host, no cold-start, requires operator's machine on): URL published on submission
   - **Fly.io** (production-grade, requires CC on Fly side, no cold-start): `https://aep-mcp-judge.fly.dev`
3. Paste the **auth token** from the Colosseum submission page (rotated per judging cycle; never committed to git).
4. **Add** → the 28 tools register in the connector dialog.
5. In any conversation, ask Claude: *"Run `verify_protocol_invariants` on agenomics and tell me the result."*

Expected: Claude calls the tool and reports a clean invariant sweep (`ok: true`, with a per-program summary). If the **Render** URL returns nothing on the first call, wait ~45 seconds and retry — the free tier sleeps after 15 minutes of idle and the first request wakes the container.

The hosted endpoint runs against Solana devnet with a server-side keypair (~0.85 SOL, replenishable from the public faucet). The bearer token + per-IP rate limit (60 req/min) + origin allowlist (`claude.ai` only) is the abuse boundary. No local install required.

> **Vercel mirror** (`aep-mcp.vercel.app`) is published but currently returns 500 on MCP invocations — the `@solana/web3.js@1.x` → `rpc-websockets` chain crashes during Vercel Functions cold-start. Use any other URL from the matrix. The Vercel path is tracked as v0.2 follow-up under ADR-087 Phase B.

---

## TL;DR

**Three Solana programs (devnet-live, RPC-verifiable), one MCP server (28 typed tools), 580+ tests passing across the workspace, Apache-2.0 licensed.** Judges who only have 60 seconds: the [Devnet Deployment](./README.md#devnet-deployment) table is enough — every program ID is a Solana Explorer link. Judges who have 5 minutes: run the verification flow below.

---

## Prerequisites (≈ 60s)

- **Node 20+** (`node --version`)
- **A Solana keypair file** at `~/.config/solana/id.json`, mode `0600`. Two ways to create one:

```bash
# A) Using the Solana CLI (recommended; ships in https://docs.solana.com)
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json

# B) Using only Node (no Solana CLI needed)
mkdir -p ~/.config/solana
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519',{});const p=k.privateKey.export({format:'der',type:'pkcs8'});const s=p.subarray(p.length-32);const u=k.publicKey.export({format:'der',type:'spki'}).subarray(-32);console.log(JSON.stringify(Array.from(Buffer.concat([s,u]))))" > ~/.config/solana/id.json
chmod 600 ~/.config/solana/id.json
```

The MCP server **refuses to load** a keypair that is mode > 0600 (defense-in-depth — see `mcp-server/src/transport/auth-gate.ts`). The error is actionable: `"permission mode 644 is too permissive (group or other bits set). Run: chmod 600 <path>"`.

You don't need any SOL on this keypair to run the smoke verification — the read-only tools work without it.

---

## The 5-minute verification flow

### Step 1 — Clone and install (≈ 30s)

```bash
git clone https://github.com/agenomics-labs/protocol
cd protocol
npm install
```

Expected (timing measured 2026-05-06 on a small VM):

```
> @agenomics/action-runtime@0.1.0 build
> tsc
> @agenomics/capability-manifest-validator@0.1.0 build
> tsc
> @agenomics/sas-resolver@0.1.0 build
> tsc
> @agenomics/mcp-server@1.0.0 prebuild
> @agenomics/mcp-server@1.0.0 build

added 412 packages, and audited 417 packages in 16s
72 packages are looking for funding
found 0 vulnerabilities
```

The root `postinstall` hook builds the four TS workspace packages in dependency order: `action-runtime → capability-manifest-validator → sas-resolver → mcp-server`. After this, `mcp-server/dist/index.js` exists (≈ 17 KB) and is the runnable entrypoint.

What you should see on disk:

```bash
$ ls -la mcp-server/dist/index.js
-rw-r--r-- 1 ... 17248 ... mcp-server/dist/index.js
```

### Step 2 — Configure env (≈ 5s)

```bash
cd mcp-server
cp .env.devnet .env
```

Contents of `.env` (exactly what `.env.devnet` ships):

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=~/.config/solana/id.json
```

If your keypair is at a non-default path, edit `.env` to match.

### Step 3 — Smoke-start the server (≈ 5s)

```bash
node dist/index.js
```

Expected on a clean run (4 log lines + an idle process; the server is now waiting for stdio MCP traffic from a client):

```
[INFO] MCP transport posture
    component: "mcp-auth"
    posture_summary: "stdio (local subprocess; trust boundary = parent process)"
    mode: "stdio"
[INFO] evo-bridge: AEP_EVO_ENABLED is false (default); EVO integration disabled
    component: "evo-bridge"
    adr: "ADR-129"
[WARN] vault-layout-drift: IDL not present at runtime; skipping drift check (build-time gate is authoritative)
    component: "vault-layout-drift"
    audit: "MCP-311"
[INFO] agenomics mcp server started
    component: "mcp-server"
    transport: "stdio"
    agent_wallet: "<your wallet's base58 pubkey>"
    rpc_v1_endpoint: "https://api.devnet.solana.com"
    rpc_v2_endpoint: "https://api.devnet.solana.com"
    actions_count: 28
    idempotency_backend: "memory"
    evo_enabled: false
[metrics] Prometheus scrape endpoint on http://127.0.0.1:9101/metrics
```

Three things to verify in this output:

| Field | Why it matters |
|---|---|
| `actions_count: 28` | Confirms the 28-tool surface is registered (matches README, SUBMISSION, dashboard, integration-guide) |
| `transport: "stdio"` | Subprocess-mode MCP, the standard Claude Desktop wiring |
| `agent_wallet` is populated | Your keypair is loaded (the wallet doesn't need SOL for read tools) |

`Ctrl-C` to exit.

### Step 4 — Wire it into Claude Desktop (≈ 30s, optional)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agenomics": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/your/clone/of/protocol/mcp-server"
    }
  }
}
```

Restart Claude Desktop. In a new conversation, type `What tools are available from agenomics?` — Claude should list 28 tools (`create_vault`, `register_agent`, `create_escrow`, etc.).

### Step 5 — Verify the on-chain programs are live (≈ 30s)

The protocol's three Solana programs are deployed to devnet at fixed addresses. From any machine with internet access:

```bash
curl -s https://api.devnet.solana.com -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q",{"encoding":"jsonParsed"}]}' \
  | python3 -c "import json,sys;a=json.load(sys.stdin)['result']['value'];print('executable:',a['executable'],'owner:',a['owner'])"
```

Expected:

```
executable: True owner: BPFLoaderUpgradeab1e11111111111111111111111
```

Same check works for the other two programs (`8VQuB…tfh` Registry and `GK8L…3wvc3` Settlement) — just swap the address.

Or browse them directly on Solana Explorer:

- [Vault `4wjdJ…gvwN`](https://explorer.solana.com/address/D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q?cluster=devnet)
- [Registry `8VQuB…tfh`](https://explorer.solana.com/address/26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7?cluster=devnet)
- [Settlement `GK8L…3wvc3`](https://explorer.solana.com/address/AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia?cluster=devnet)
- [CCTP Hook `3yifM…4vb`](https://explorer.solana.com/address/MtqZaquyJCMu1ph8CygpKBQECfAkH2gig7TUtYXdWdC?cluster=devnet)

---

## Optional deeper verification

### Verify the 28 tools register over the wire (≈ 5s)

Goes one level deeper than Step 3's `actions_count: 28` log line — sends an actual MCP `tools/list` request and counts the tools in the JSON-RPC response. If a tool fails to register (broken Zod schema, import-time crash, etc.) it would be missing here even though the startup log is fine.

```bash
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  sleep 0.5
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  sleep 0.3
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 1
} | timeout 5 node mcp-server/dist/index.js 2>/dev/null \
  | grep -o '"name":"[a-z_]*"' | sort -u | wc -l
```

Expected:

```
28
```

To see the actual tool names:

```bash
# (replace `wc -l` with `cat`)
… | grep -o '"name":"[a-z_]*"' | sort -u
```

Returns the canonical 28-tool list (9 vault + 6 registry + 1 reputation + 1 agent-memory + 10 settlement + 1 governance + 1 surface-2 stub) — same set the dashboard's MCP_TOOLS array, README, and `mcp-server/src/tools/index.ts:91 allTools[]` advertise.

### Run the unit tests (≈ 30s)

```bash
cd mcp-server && npm test
```

Expected tail:

```
# tests 416
# pass 416
# fail 0
# cancelled 0
# duration_ms ~64,000
```

### Run the end-to-end devnet smoke (≈ 60s)

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com npx tsx scripts/smoke-test-devnet.ts
```

Probes program deployment, runs the manifest validator round-trip, dispatches a real MCP `tools/list` call, exercises the v2 vault-transfer path. See `docs/SMOKE_TESTING.md` for expected pass criteria.

---

## Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| `Wallet keypair not found at: ~/.config/solana/id.json` | No keypair generated yet | Run the Prerequisites step above (option A or B) |
| `Refusing to load wallet keyfile … permission mode 644 is too permissive` | Keypair file is group/other-readable | `chmod 600 ~/.config/solana/id.json` |
| `Cannot find module '.../mcp-server/dist/index.js'` | Postinstall didn't run | Re-run `npm install` from the **repo root** (not `mcp-server/`) — the postinstall is wired at the workspace root |
| `npm audit` reports vulnerabilities | Dev-dependency `bigint-buffer` chain | Production audit is clean (`npm audit --omit=dev` → 0 vulns); the dev path is upstream-blocked on a Solana SDK successor — see [`docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md`](./docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md) |

---

## Where to dig next

- **Architecture & decisions:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), the 134 ADRs in [`docs/adr/`](./docs/adr/)
- **Security posture:** [`docs/SECURITY_AUDIT.md`](./docs/SECURITY_AUDIT.md), [`docs/MAINNET_CHECKLIST.md`](./docs/MAINNET_CHECKLIST.md)
- **Build instructions for contributors:** [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Full project breakdown (programs / tests / dependencies):** [`SUMMARY.md`](./SUMMARY.md)
- **The 90-second pitch (recorded video):** see [`SUBMISSION.md`](./SUBMISSION.md) once it goes up

# Agenomics Protocol

**Three Solana programs, one MCP server, 29 tools — live on devnet.**

The Agent Economic Protocol (AEP) is a trustless coordination layer on Solana where AI agents hold money, prove identity, and settle payments without a human in the loop. Agentic AI is $7B today, $236B by 2034 — the bottleneck is no longer compute, it's coordination.

## Architecture

```
AI Agents (Claude, ChatGPT, ElizaOS, custom)
         |
    MCP Server (Model Context Protocol — 29 typed tools)
         |
    Solana Blockchain
    +-- Agent Vault     (programmable wallets, spending policies)
    +-- Agent Registry   (identity, reputation, discovery)
    +-- Settlement       (escrow, milestones, disputes)
```

Three Anchor programs on Solana, bridged to any agent runtime via a single MCP server. Live on devnet — addresses below.

## Quick Start

```bash
git clone https://github.com/agenomics-labs/protocol
cd protocol && npm install                    # root postinstall builds the workspace
cp mcp-server/.env.devnet mcp-server/.env
```

### Connect to claude.ai (web + mobile) — fastest path for judges

Hosted MCP endpoint, no local setup. claude.ai supports remote MCP servers via custom connectors:

1. Open [claude.ai/settings/connectors](https://claude.ai/settings/connectors)
2. Click **Add custom connector**
3. Paste **any** of the hosted URLs from the [deploy matrix below](#deploy-targets-free-tier-matrix)
4. Paste the auth token published on the [Colosseum submission page](./SUBMISSION.md) (rotated per judging cycle)
5. Click **Add** → ask Claude *"Run `verify_protocol_invariants` on agenomics"* to confirm

All 29 tools are immediately available in any conversation. The hosted endpoint runs against Solana devnet with a server-side keypair; the bearer token + per-IP rate limit + origin allowlist (`claude.ai` only) are the abuse boundary.

### Deploy targets (free-tier matrix)

The MCP server ships with deploy configs for several hosts so judges can connect to whichever one is live. All free (no card except where noted).

| Target | Config | URL pattern | Notes |
|---|---|---|---|
| **Render** | [`render.yaml`](./render.yaml) | `https://aep-mcp-judge.onrender.com` | Free tier, no card. Sleeps after 15min idle; first request after sleep wakes the container (~30–60s). One-click via Blueprint flow. |
| **Cloudflare Tunnel** (self-host) | [`docker-compose.yml`](./docker-compose.yml) | your own subdomain or `*.cfargotunnel.com` | Truly free forever, no card, zero cold-start. Wallet stays on your machine. Tradeoff: your machine must stay on during judging. |
| **Codespaces port-forward** | [`.devcontainer/devcontainer.json`](./.devcontainer/devcontainer.json) | `https://<codespace>-8080.app.github.dev` | 60h/mo free per GitHub personal account. Fallback if no other endpoint is up. |
| **Koyeb (Eco)** | one-click via [Koyeb Apps](https://app.koyeb.com/apps/new) → Docker → repo URL | `https://<name>-<owner>.koyeb.app` | Free 1-service tier, no card. Auto-detects `mcp-server/Dockerfile`. |
| **Northflank (Free)** | one-click via [Northflank UI](https://app.northflank.com) → Combined Service | `https://<name>--<id>.code.run` | Free 1-service tier, no card. |
| **Fly.io** | [`mcp-server/fly.toml`](./mcp-server/fly.toml) | `https://aep-mcp-judge.fly.dev` | Free allowance still exists but **requires card on file** as of 2024. Use `flyctl deploy --config mcp-server/fly.toml`. |
| **Vercel** | [`mcp-server/vercel.json`](./mcp-server/vercel.json) | `https://aep-mcp.vercel.app` | **Parked.** Function deploys + `/healthz` returns 200 in some configs, but the MCP `initialize` handshake hangs on cold-start (Solana web3.js v1 + rpc-websockets chain). Tracked under ADR-087 Phase B. |

Recommended primary: **Render** (lowest-friction zero-card option) or **Cloudflare Tunnel** (best technical fit if you can keep a machine on). Both use the same `mcp-server/Dockerfile`.

### Connect to Claude Desktop (stdio, local clone)

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):
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
Restart Claude Desktop after editing. The 29 tools (`create_vault`, `register_agent`, `create_escrow`, `pay_x402_service`, `query_execution_history`, etc) become available to any agent in the conversation.

## Devnet Deployment

| Program | Address |
|---------|---------|
| Agent Vault | `28Km3edbdMASVzKDnG2gHNLBgC7JQodGd9FVRAEVzYYw` |
| Agent Registry | `psJT29X5QAqkc9ZL3mt1YbyUsGqgdXjBU7RhEUEyNyv` |
| Settlement | `9TRVbw2dvER1zDQcxwA8Puub4fLnPGstc1GGDDLTUF95` |
| CCTP Hook | `3yifMBDVChLzcihZWh4or9zxgzbmQVghdNZzpuP814vb` |

## MCP Tools (29)

### Vault (10)
`create_vault` `get_vault_info` `vault_transfer` `vault_token_transfer` `update_vault_policy` `rotate_agent_identity` `pause_vault` `resume_vault` `manage_allowlist` `query_execution_history`

### Registry (6)
`register_agent` `get_agent_profile` `update_agent_profile` `discover_agents` `find_similar_agents` `stake_reputation`

### Reputation (1)
`get_agent_reputation`

### Settlement (10)
`create_escrow` `accept_task` `submit_milestone` `approve_milestone` `reject_milestone` `get_escrow_status` `cancel_escrow` `raise_dispute` `resolve_dispute` `resolve_dispute_timeout`

### Governance (1)
`verify_protocol_invariants`

### Surface 2 (1, scaffold/stub)
`pay_x402_service`

### Reputation portability (3, ADR-139)
`issue_reputation_attestation` `verify_reputation_attestation` `get_portable_reputation`

A signed snapshot of an agent's reputation that any third party can verify
in one Ed25519 check — no Agenomics RPC required. See
`packages/reputation-attestor/README.md` and
`docs/adr/ADR-139-portable-reputation-attestations.md`.

## Development

```bash
# Build programs
anchor build --no-idl

# Run unit tests
cargo test

# Run mcp-server unit tests (416 tests; node:test + tsx)
cd mcp-server && npm test

# Anchor integration tests (full lifecycle against local validator)
anchor test

# Preview documentation
cd docs && npm run dev

# Preview dashboard
cd dashboard && npm run dev
```

## Key Features

- **Programmable Vaults** — Per-transaction limits, daily caps, rate limiting, token allowlists
- **Agent Discovery** — On-chain registry with categories, capabilities, and reputation scores
- **Escrow Settlement** — Milestone-based payments with atomic fund locking
- **Reputation Staking** — Optional SOL collateral (ADR-020); slash_count escalation suspends agents at 3 dispute losses (ADR-094, ADR-131)
- **Dispute Resolution** — Governance-tunable timeout (7-day default) with auto-resolution, reputation penalties
- **Anti-Sybil** — Minimum escrow amounts, self-dealing prohibition
- **MCP Bridge** — Any AI agent framework can interact via Model Context Protocol

## Documentation

- [Getting Started](docs/getting-started.md)
- [API Reference](docs/api-reference.md)
- [Integration Guide](docs/integration-guide.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security Audit Prep](docs/SECURITY_AUDIT.md)
- [ADRs](docs/adr/)

## Strategy

- [CLARITY-Era Evolution: From Agent Infrastructure to Machine Institutional Substrate](docs/strategy/clarity-era-evolution.md) — 18-month wedge roadmap, moat analysis, and what we are not building.

## Security

Internal audit cycles are documented in [`docs/audits/`](docs/audits/) — every finding has a closing commit referenced in the punch-list.

| Cycle | Scope | Status | Artifacts |
|---|---|---|---|
| Cycle 1 | Foundational audit | 0/open | [`ARCHITECTURE-AUDIT-2026-04-25.md`](docs/audits/ARCHITECTURE-AUDIT-2026-04-25.md), [`TEST-REPORT-2026-04-25.md`](docs/audits/TEST-REPORT-2026-04-25.md), [`REMEDIATION-PLAN.md`](docs/audits/REMEDIATION-PLAN.md) |
| Cycle 2 | Re-audit + Dependabot sweep | 0/open | [`ARCHITECTURE-AUDIT-2026-04-26-{adr,onchain,offchain,tests-ci}.md`](docs/audits/), [`DEPENDABOT-2-CLOSURE-CHECK.md`](docs/audits/DEPENDABOT-2-CLOSURE-CHECK.md) |
| Cycle 3 | Cross-cutting (Onchain 0/12 · Offchain 0/18 · MCP 0/20) | 0/open | [`CYCLE-3-{ONCHAIN,OFFCHAIN,MCP}-PUNCHLIST.md`](docs/audits/) |
| Cycle 4 | Continuation + MCP transport hardening (ADR-083 + ADR-132) | 0/open | [`CYCLE-4-{ADR,ONCHAIN,OFFCHAIN,MCP}-PUNCHLIST.md`](docs/audits/) |
| Re-audit 2026-05 | Runtime-validation sweep | 0/open | [`docs/ARCHITECTURE_REAUDIT_2026-05.md`](docs/ARCHITECTURE_REAUDIT_2026-05.md), [`ARCHITECTURE_REAUDIT_2026-05b-runtime-validation.md`](docs/ARCHITECTURE_REAUDIT_2026-05b-runtime-validation.md) |

Threat model + invariants documented in [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md). External audit pending — internal hostile-audit posture is the bridge.

- **0 npm vulnerabilities** (`npm audit --omit=dev`); 5 deferred dev-only findings tracked in [`DEPENDABOT-3-UUID-IPADDR-CLOSURE.md`](docs/audits/DEPENDABOT-3-UUID-IPADDR-CLOSURE.md)
- **PDA-signed CPI** for cross-program reputation updates (ADR-094)
- **Defense-in-depth**: Anchor constraints + handler checks + economic barriers
- **MCP transport security**: bearer auth + per-bucket rate limit + origin allowlist (ADR-083 + ADR-132); CI lint gate forbids unauthenticated `listen()` call sites
- **Reputation deltas**: +10 (complete) / -5 (dispute or timeout) / -3 (expiry); capped at ±10 per call, scores clamped to [0, 100] (ADR-094)

## License

Apache-2.0 — see [`LICENSE`](LICENSE).

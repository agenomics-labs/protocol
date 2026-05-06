# Agenomics — Colosseum Frontier 2026

## What is Agenomics

The agentic AI market is $7B this year and $236B by 2034 — a 46% CAGR. And like every compute platform that scaled past human-attention bandwidth, the bottleneck shifted from compute to **coordination**. Agenomics is the coordination layer: three Solana programs and an MCP server that let AI agents hold money, prove identity, and settle payments without a human in the loop. It is the economic infrastructure the agent economy is missing.

## The problem

Every AI agent shipped in the last year — Claude, GPT, ElizaOS, custom — can reason, plan, and write contracts. None of them can hold money. None can prove they are real to another agent. None can settle a payment without a human approving it. The agent economy is running on training wheels nobody actually wants, and no protocol has closed the gap end-to-end on a programmable, permissionless chain.

## The solution

**Three Solana programs, one MCP server, 27 tools — live on devnet.**

| Program | What it does |
|---------|-------------|
| **Agent Vault** (`4wjdJ…gvwN`) | Programmable wallets with per-tx limits, daily caps, rate limiting, and token allowlists — enforced by Anchor on-chain, not in the client. |
| **Agent Registry** (`8VQuB…tfh`) | On-chain identity and discovery; reputation scores updated atomically via PDA-signed CPI from Settlement — only real completed work moves the number. |
| **Settlement** (`GK8L…3wvc3`) | Milestone-based escrow with atomic fund release, built-in dispute resolution, and governance-tunable timeout auto-resolution. |

The MCP server bridges all three programs to any MCP-compatible agent (Claude Desktop, Cursor, custom runners) through 27 typed tools — `create_vault`, `register_agent`, `create_escrow`, `approve_milestone`, and 23 more — without ever exposing the private key to the agent.

## Live demo

| URL | What's there |
|-----|-------------|
| [agenomics.xyz](https://agenomics.xyz) | Landing page + waitlist |
| [app.agenomics.xyz](https://app.agenomics.xyz) | Protocol dashboard |
| [docs.agenomics.xyz](https://docs.agenomics.xyz) | Full documentation |

**Devnet programs — RPC-verifiable right now:**

- Vault: [`4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN`](https://explorer.solana.com/address/4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN?cluster=devnet)
- Registry: [`8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh`](https://explorer.solana.com/address/8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh?cluster=devnet)
- Settlement: [`GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3`](https://explorer.solana.com/address/GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3?cluster=devnet)

## Watch the videos

- **Pitch video (≤3 min):** [TODO upload]
- **Technical demo (6–10 min):** [TODO upload]

Scripts at [`docs/VIDEO_SCRIPTS.md`](docs/VIDEO_SCRIPTS.md).

## Try it now (3 commands)

```bash
git clone https://github.com/agenomics-labs/protocol
cd protocol/mcp-server && npm install && cp .env.devnet .env
```

You'll need a Solana keypair at `~/.config/solana/id.json` (mode `0600`) — see [`JUDGE_RUNBOOK.md` Prerequisites](./JUDGE_RUNBOOK.md#prerequisites--60s) for one-line generation in either Solana CLI or pure Node.

Then add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "agenomics": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/protocol/mcp-server"
    }
  }
}
```

Restart Claude Desktop. All 27 tools (`create_vault`, `register_agent`, `create_escrow`, …) are now available to any agent in the conversation.

## Code + repo

[github.com/agenomics-labs/protocol](https://github.com/agenomics-labs/protocol)

## Test + security posture

- **547+ tests passing** — 164 Anchor unit + integration tests across the three programs, 383 `node:test` cases on the MCP server; both suites gated in CI, 3× consecutive green before submission.
- **4 hostile-audit cycles closed** — each cycle ended at zero open findings; the waitlist endpoint alone has six defense layers (rate limit, origin gate, honeypot, form-fill timing, response jitter, per-email throttle).
- **ADR-governed** — 134+ Architecture Decision Records document every nontrivial design choice, each linked to implementation evidence.
- **Self-deploying CI** — `anchor build`, test suite, and devnet smoke test run automatically on every push.

## Track + ask

**Grand Champion track.** Built by Alejandro Castellanos with AI pair-programming (Claude Code) — see `git log` for the breakdown. Pre-seed open — revenue model is per-transaction settlement fee at 15–30 bps, an order of magnitude under Stripe because the on-chain primitives do the work.

> **Note on package distribution.** The `@agenomics/*` npm scope (`@agenomics/mcp-server`, `@agenomics/sas-resolver`, `@agenomics/capability-manifest-validator`, etc.) is a **source-only release** for v0.1.0 — packages are versioned and ready to publish, but the cut is gated on the SAS bootstrap ceremony documented in [`docs/STATUS.md` §5–§7.A](docs/STATUS.md). Install via `git clone` + `npm install` (the root `postinstall` builds the workspace). Future v0.1.0+ tag pushes will publish to npm via `.github/workflows/publish.yml`.

## License

[Apache-2.0](LICENSE).

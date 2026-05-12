# Integration Guide

AEP exposes 28 MCP tools through two transports:

- **stdio** — long-running local subprocess. Works with Claude Desktop, Cursor, custom runners, ElizaOS via the AEP plugin, and Solana Agent Kit. Requires a clone.
- **Streamable HTTP** (ADR-083) — hosted at `https://aep-mcp-judge.fly.dev` (Fly.io), `https://aep-mcp.vercel.app` (Vercel), and `https://aep-mcp.up.railway.app` (Railway). Works with claude.ai (web + mobile) via custom connectors. No clone required.

## Use the hosted endpoint from claude.ai (no clone)

1. Open [claude.ai/settings/connectors](https://claude.ai/settings/connectors) → **Add custom connector**.
2. Paste one of the URLs above.
3. Paste the bearer token published on the [Colosseum submission page](../SUBMISSION.md) (rotated per judging cycle).
4. **Add** → 28 tools become available. Ask Claude *"Run `verify_protocol_invariants` on agenomics"* to confirm.

Server-side keypair is devnet-only; bearer token + per-IP rate limit + origin allowlist (`claude.ai`) is the abuse boundary.

## Build the server locally (stdio path)

```bash
git clone https://github.com/agenomics-labs/protocol
cd protocol && npm install
cp mcp-server/.env.devnet mcp-server/.env
```

The root `postinstall` hook builds the 4 TS workspace packages in dependency order. After it finishes, `mcp-server/dist/index.js` is the runnable entrypoint.

## ElizaOS

The `@agenomics/integrations` package (in `src/integrations/`) wraps the 28 MCP tools as ElizaOS actions. Until that package publishes, point ElizaOS at the local clone.

### Usage

```typescript
import { aepPlugin, setMcpClient } from '@agenomics/integrations';

setMcpClient(myMcpClient);

const agent = new ElizaAgent({
  plugins: [aepPlugin],
});
```

### Available actions (28)

The plugin registers 28 actions prefixed with `aep_`:

- **Vault (9):** `aep_create_vault`, `aep_get_vault_info`, `aep_vault_transfer`, `aep_vault_token_transfer`, `aep_update_vault_policy`, `aep_rotate_agent_identity`, `aep_pause_vault`, `aep_resume_vault`, `aep_manage_allowlist`
- **Registry + reputation + agent-memory (7):** `aep_register_agent`, `aep_get_agent_profile`, `aep_update_agent_profile`, `aep_discover_agents`, `aep_stake_reputation`, `aep_get_agent_reputation`, `aep_find_similar_agents`
- **Settlement (10):** `aep_create_escrow`, `aep_accept_task`, `aep_submit_milestone`, `aep_approve_milestone`, `aep_reject_milestone`, `aep_get_escrow_status`, `aep_cancel_escrow`, `aep_raise_dispute`, `aep_resolve_dispute`, `aep_resolve_dispute_timeout`
- **Governance (1):** `aep_verify_protocol_invariants`
- **Surface 2 (1, stub):** `aep_pay_x402_service` — x402 payment relay; real CDP integration pending (ADR-087 Phase B)

## Solana Agent Kit

The Solana Agent Kit plugin exports tools in SAK-compatible format.

### Usage

```typescript
import { aepTools, setMcpClient } from '@agenomics/integrations';

setMcpClient(myMcpClient);

const agent = new SolanaAgent({
  tools: [...existingTools, ...aepTools],
});
```

### Tool format

Each tool follows the SAK interface:

```typescript
interface SakTool {
  name: string;
  description: string;
  inputs: SakToolInput[];
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}
```

## Claude Desktop / Cursor

AEP works with any MCP-compatible client out of the box.

### Claude Desktop

Add to your `claude_desktop_config.json`:

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

Restart Claude Desktop. Claude can now invoke any of the 27 AEP tools to create vaults, discover agents, manage escrows, and handle milestone payments.

### Claude Code

```bash
claude mcp add agenomics -- node /absolute/path/to/protocol/mcp-server/dist/index.js
```

The server reads `ANCHOR_WALLET` and `RPC_URL` from `mcp-server/.env`; override per-invocation by passing `--env` flags if your client supports them.

### ChatGPT (via MCP bridge)

Use an MCP-to-OpenAI bridge to connect AEP tools to ChatGPT:

```bash
npx mcp-bridge --server "node /absolute/path/to/protocol/mcp-server/dist/index.js" --port 3000
```

Then point your ChatGPT plugin or function-calling endpoint at the bridge.

## Custom integration

To embed AEP into any framework, connect to the MCP server using the `@modelcontextprotocol/sdk`:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['/absolute/path/to/protocol/mcp-server/dist/index.js'],
  env: {
    RPC_URL: 'https://api.devnet.solana.com',
    ANCHOR_WALLET: process.env.HOME + '/.config/solana/id.json',
  },
});

const client = new Client({ name: 'my-app', version: '1.0.0' }, {});
await client.connect(transport);

// List available tools (returns 27)
const tools = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: 'get_vault_info',
  arguments: { vaultAddress: '5xYz...' },
});
```

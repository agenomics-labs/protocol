import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools } from "./tools/index.js";
import { getConnection, getWalletPublicKey } from "./solana.js";
import { createRpc } from "./solana-v2.js";

import { createActionRouter } from "./adapters/mcp.js";
import { allActions } from "./actions/index.js";
import type { ActionContext } from "./types/action.js";
import type { Capability } from "./types/capability.js";

/**
 * Agenomics MCP Server — all 23 actions dispatched through the ADR-058
 * capability-gated ActionRouter. Legacy switch-case dispatch retired in PR1.5.
 */

const server = new Server(
  { name: "aeap-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

export const actionRouter = createActionRouter(allActions);

const ALL_CAPABILITIES: Capability[] = [
  "read:settlement",
  "read:registry",
  "read:vault",
  "sign:settlement",
  "sign:registry",
  "sign:vault",
  "sign:cross_program:settlement+registry",
  "admin:settlement",
  "admin:registry",
  "admin:vault",
];

/**
 * PR1.5 runs the server in local-dev mode: single wallet, all capabilities
 * granted, signed mode. Hosted/multi-tenant mode lands in PR3 (per-request
 * JWT → Capability set resolver).
 */
function buildLocalDevContext(): ActionContext {
  return {
    mode: "signed",
    wallet: {
      publicKey: getWalletPublicKey(),
      capabilities: new Set<Capability>(ALL_CAPABILITIES),
    },
    signer: null, // PR3 will wire @solana/keychain-core here
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  const ctx = buildLocalDevContext();
  const result = await actionRouter.dispatch(toolName, args, ctx);

  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.error, null, 2),
        } as TextContent,
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result.data, null, 2),
      } as TextContent,
    ],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ADR-012 PR2: initialise the @solana/kit (v2) RPC alongside the v1
  // surface. Nothing in the dispatch path reads it yet — handlers still go
  // through Anchor + v1. PR3 will migrate read paths + introduce the
  // tx-pipeline.
  createRpc();

  console.error("Agenomics MCP Server started on stdio transport");
  console.error(`Agent wallet: ${getWalletPublicKey().toBase58()}`);
  console.error(`RPC (v1/Anchor): ${getConnection().rpcEndpoint}`);
  console.error(
    `RPC (v2/kit):    ${process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com"}`,
  );
  console.error(`Actions: ${allActions.length} (all gated via ADR-058 router)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, ToolName } from "./tools/index.js";
import { getConnection, getWalletPublicKey } from "./solana.js";
import { createRpc } from "./solana-v2.js";

// ==================== ADR-058 ACTION PIPELINE (PR1 pilot) ====================

import { createActionRouter } from "./adapters/mcp.js";
import { pilotActions, pilotActionNames } from "./actions/index.js";
import type { ActionContext } from "./types/action.js";
import type { Capability } from "./types/capability.js";

// ==================== HANDLER IMPORTS (legacy dispatch) ====================

import {
  handleCreateVault,
  handleGetVaultInfo,
  handleVaultTokenTransfer,
  handleUpdateVaultPolicy,
  handlePauseVault,
  handleResumeVault,
  handleManageAllowlist,
} from "./handlers/vault.js";

import {
  handleRegisterAgent,
  handleGetAgentProfile,
  handleUpdateAgentProfile,
  handleDiscoverAgents,
  handleStakeReputation,
} from "./handlers/registry.js";

import {
  handleAcceptTask,
  handleSubmitMilestone,
  handleRejectMilestone,
  handleGetEscrowStatus,
  handleRaiseDispute,
  handleResolveDisputeTimeout,
} from "./handlers/settlement.js";

/**
 * Agenomics MCP Server - Main Entry Point
 *
 * Exposes the Agenomics Protocol on Solana to any AI agent through the MCP.
 *
 * PR1 (ADR-058) migrates 5 high-risk pilot actions to the new Action<I, O>
 * shape with capability gating. The remaining 18 actions stay on the legacy
 * switch-case dispatch until PR1.5.
 */

const server = new Server(
  { name: "aeap-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ==================== ADR-058 ROUTER ====================

export const actionRouter = createActionRouter(pilotActions);

/**
 * PR1 runs the server in local-dev mode: single wallet, all capabilities
 * granted, signed mode. Hosted/multi-tenant mode lands in PR3 (per-request
 * JWT → Capability set resolver).
 */
function buildLocalDevContext(): ActionContext {
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
  return {
    mode: "signed",
    wallet: {
      publicKey: getWalletPublicKey(),
      capabilities: new Set<Capability>(ALL_CAPABILITIES),
    },
    signer: null, // PR3 will wire @solana/keychain-core here
  };
}

// ==================== TOOL LISTING ====================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

// ==================== TOOL DISPATCH ====================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name as ToolName;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;

    // ADR-058 pilot path: gated through capability router
    if (pilotActionNames.has(toolName)) {
      const ctx = buildLocalDevContext();
      const gated = await actionRouter.dispatch(toolName, args, ctx);
      if (!gated.ok) {
        return {
          content: [
            { type: "text", text: JSON.stringify(gated.error, null, 2) } as TextContent,
          ],
          isError: true,
        };
      }
      result = gated.data;
    } else {
      // Legacy switch-case dispatch (18 actions not in the PR1 pilot)
      switch (toolName) {
        // Vault
        case "create_vault":
          result = await handleCreateVault(args);
          break;
        case "get_vault_info":
          result = await handleGetVaultInfo(args);
          break;
        case "vault_token_transfer":
          result = await handleVaultTokenTransfer(args);
          break;
        case "update_vault_policy":
          result = await handleUpdateVaultPolicy(args);
          break;
        case "pause_vault":
          result = await handlePauseVault();
          break;
        case "resume_vault":
          result = await handleResumeVault();
          break;
        case "manage_allowlist":
          result = await handleManageAllowlist(args);
          break;
        // Registry
        case "register_agent":
          result = await handleRegisterAgent(args);
          break;
        case "get_agent_profile":
          result = await handleGetAgentProfile(args);
          break;
        case "update_agent_profile":
          result = await handleUpdateAgentProfile(args);
          break;
        case "discover_agents":
          result = await handleDiscoverAgents(args);
          break;
        case "stake_reputation":
          result = await handleStakeReputation(args);
          break;
        // Settlement
        case "accept_task":
          result = await handleAcceptTask(args);
          break;
        case "submit_milestone":
          result = await handleSubmitMilestone(args);
          break;
        case "reject_milestone":
          result = await handleRejectMilestone(args);
          break;
        case "get_escrow_status":
          result = await handleGetEscrowStatus(args);
          break;
        case "raise_dispute":
          result = await handleRaiseDispute(args);
          break;
        case "resolve_dispute_timeout":
          result = await handleResolveDisputeTimeout(args);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        } as TextContent,
      ],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: errorMessage, tool: toolName }, null, 2),
        } as TextContent,
      ],
      isError: true,
    };
  }
});

// ==================== SERVER STARTUP ====================

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
  console.error(
    `ADR-058 pilot actions: ${[...pilotActionNames].join(", ")}`,
  );
}

// Only run the server when this file is the process entry point.
// Tests import modules directly without starting stdio transport.
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

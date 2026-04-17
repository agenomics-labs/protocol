import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, ToolName } from "./tools/index.js";
import {
  getConnection,
  getWalletPublicKey,
} from "./solana.js";

// ==================== HANDLER IMPORTS ====================

import {
  handleCreateVault,
  handleGetVaultInfo,
  handleVaultTransfer,
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
  handleCreateEscrow,
  handleAcceptTask,
  handleSubmitMilestone,
  handleApproveMilestone,
  handleRejectMilestone,
  handleGetEscrowStatus,
  handleCancelEscrow,
  handleRaiseDispute,
  handleResolveDispute,
  handleResolveDisputeTimeout,
} from "./handlers/settlement.js";

/**
 * Agenomics MCP Server - Main Entry Point
 *
 * Exposes the Agenomics Protocol on Solana
 * to any AI agent through the Model Context Protocol.
 *
 * Three on-chain programs are accessible:
 * 1. Agent Vault - Programmable wallets with spending policies
 * 2. Agent Registry - Discovery and reputation system
 * 3. Settlement Protocol - Escrow and milestone-based payments
 */

const server = new Server(
  { name: "aeap-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ==================== TOOL LISTING ====================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

// ==================== TOOL DISPATCH ====================

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name as ToolName;
  const args = request.params.arguments as Record<string, unknown>;

  try {
    let result: unknown;

    switch (toolName) {
      // Vault
      case "create_vault":
        result = await handleCreateVault(args);
        break;
      case "get_vault_info":
        result = await handleGetVaultInfo(args);
        break;
      case "vault_transfer":
        result = await handleVaultTransfer(args);
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
      case "create_escrow":
        result = await handleCreateEscrow(args);
        break;
      case "accept_task":
        result = await handleAcceptTask(args);
        break;
      case "submit_milestone":
        result = await handleSubmitMilestone(args);
        break;
      case "approve_milestone":
        result = await handleApproveMilestone(args);
        break;
      case "reject_milestone":
        result = await handleRejectMilestone(args);
        break;
      case "get_escrow_status":
        result = await handleGetEscrowStatus(args);
        break;
      case "cancel_escrow":
        result = await handleCancelEscrow(args);
        break;
      case "raise_dispute":
        result = await handleRaiseDispute(args);
        break;
      case "resolve_dispute":
        result = await handleResolveDispute(args);
        break;
      case "resolve_dispute_timeout":
        result = await handleResolveDisputeTimeout(args);
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
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
  console.error("Agenomics MCP Server started on stdio transport");
  console.error(`Agent wallet: ${getWalletPublicKey().toBase58()}`);
  console.error(`RPC: ${getConnection().rpcEndpoint}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

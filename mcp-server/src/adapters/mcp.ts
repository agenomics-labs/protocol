// Maps Action<I, O>[] onto the existing MCP Server's setRequestHandler
// pipeline. Preserves the current Server-class architecture (vs. McpServer)
// to keep PR1 scope tight. See ADR-058 §8.

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Action, ActionContext, Result } from "../types/action.js";
// ADR-135: single-source Zod → MCP inputSchema renderer. The router's
// `listToolsDescriptors()` and `tools/*.ts` now share THIS function, so
// the advertised schema cannot diverge from the enforced one.
import { renderInputSchema } from "../tools/render-schema.js";
import {
  capabilityGated,
  type CapabilityGatedOptions,
} from "./capability-gated-tool.js";

export interface ActionRouter {
  listToolsDescriptors(): Tool[];
  handles(toolName: string): boolean;
  names(): string[];
  dispatch(toolName: string, args: unknown, ctx: ActionContext): Promise<Result<unknown>>;
}

export function createActionRouter(
  rawActions: Action<any, any>[],
  options: CapabilityGatedOptions = {},
): ActionRouter {
  const actions = new Map<string, Action<any, any>>();
  for (const a of rawActions) {
    if (actions.has(a.name)) {
      throw new Error(`duplicate action name: ${a.name}`);
    }
    actions.set(a.name, capabilityGated(a, options));
  }

  return {
    listToolsDescriptors(): Tool[] {
      return [...actions.values()].map((a) => ({
        name: a.name,
        description: a.description,
        // ADR-135: derive from the action's Zod schema via the shared
        // renderer — same projection `tools/*.ts` uses.
        inputSchema: renderInputSchema(a.inputSchema),
      }));
    },
    handles(toolName: string): boolean {
      return actions.has(toolName);
    },
    names(): string[] {
      return [...actions.keys()];
    },
    async dispatch(toolName, args, ctx): Promise<Result<unknown>> {
      const action = actions.get(toolName);
      if (!action) {
        return {
          ok: false,
          error: { code: "UNKNOWN", message: `unhandled tool: ${toolName}` },
        };
      }

      const parser = z.object(action.inputSchema as z.ZodRawShape);
      const parsed = parser.safeParse(args);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "input validation failed",
            details: { issues: parsed.error.issues },
          },
        };
      }

      return action.handler(ctx, parsed.data);
    },
  };
}

// ADR-135: the local `toJsonSchema` renderer was replaced by the shared
// `renderInputSchema` (src/tools/render-schema.ts) so the router-
// advertised schema and the `tools/*.ts` descriptors are guaranteed to
// be the SAME projection of the one Zod source. The TS2589 workaround
// and target/$ref options now live in that single shared module.

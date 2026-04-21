// Maps Action<I, O>[] onto the existing MCP Server's setRequestHandler
// pipeline. Preserves the current Server-class architecture (vs. McpServer)
// to keep PR1 scope tight. See ADR-058 §8.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Action, ActionContext, Result } from "../types/action.js";
import { capabilityGated } from "./capability-gated-tool.js";

export interface ActionRouter {
  listToolsDescriptors(): Tool[];
  handles(toolName: string): boolean;
  names(): string[];
  dispatch(toolName: string, args: unknown, ctx: ActionContext): Promise<Result<unknown>>;
}

export function createActionRouter(rawActions: Action<any, any>[]): ActionRouter {
  const actions = new Map<string, Action<any, any>>();
  for (const a of rawActions) {
    if (actions.has(a.name)) {
      throw new Error(`duplicate action name: ${a.name}`);
    }
    actions.set(a.name, capabilityGated(a));
  }

  return {
    listToolsDescriptors(): Tool[] {
      return [...actions.values()].map((a) => ({
        name: a.name,
        description: a.description,
        inputSchema: toJsonSchema(a.inputSchema),
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

function toJsonSchema(shape: z.ZodRawShape): Tool["inputSchema"] {
  // Cast the input object to any to avoid `Type instantiation is excessively deep`
  // which ZodObject<ZodRawShape> can trigger under strict TS.
  const obj = z.object(shape) as unknown as z.ZodType<unknown>;
  const schema = zodToJsonSchema(obj as any, {
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  return schema as unknown as Tool["inputSchema"];
}

import { Globe, CheckCircle } from "lucide-react";
import { MCP_TOOLS } from "../data/programs.js";

const PROGRAM_COLORS = {
  vault: "border-violet-500/30 bg-violet-500/5 text-violet-300",
  registry: "border-blue-500/30 bg-blue-500/5 text-blue-300",
  settlement: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
};

export default function McpToolList() {
  const byProgram = MCP_TOOLS.reduce((acc, tool) => {
    (acc[tool.program] = acc[tool.program] || []).push(tool);
    return acc;
  }, {});

  return (
    <div className="bg-white/5 rounded-xl border border-white/10 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Globe className="w-5 h-5 text-cyan-400" />
        <h2 className="text-lg font-semibold">MCP Server Tools</h2>
        <span className="text-xs text-gray-500">({MCP_TOOLS.length})</span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {Object.entries(byProgram).map(([program, tools]) => (
          <div key={program}>
            <h3 className="text-sm font-semibold text-gray-300 mb-2 capitalize">
              {program} ({tools.length})
            </h3>
            <div className="space-y-1">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className={`flex items-center gap-2 px-3 py-2 rounded border text-xs font-mono ${PROGRAM_COLORS[program]}`}
                >
                  <CheckCircle className="w-3 h-3 flex-shrink-0" />
                  {tool.name}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 p-4 bg-cyan-900/20 border border-cyan-700/30 rounded-lg">
        <div className="flex items-start gap-2">
          <Globe className="w-4 h-4 text-cyan-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-cyan-300">Full MCP Integration</p>
            <p className="text-xs text-cyan-200/70 mt-1">
              The MCP server wraps all 3 programs with input validation, error handling, and typed
              responses. Any AI agent (Claude, GPT, etc.) can discover agents, create vaults,
              manage escrows, and handle payments — all through the standard Model Context
              Protocol.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

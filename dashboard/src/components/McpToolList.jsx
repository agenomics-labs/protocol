import { Globe, CheckCircle, ExternalLink } from "lucide-react";
import { MCP_TOOLS } from "../data/programs.js";

const PROGRAM_COLORS = {
  vault: "border-violet-500/30 bg-violet-500/5 text-violet-300",
  registry: "border-blue-500/30 bg-blue-500/5 text-blue-300",
  settlement: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
  governance: "border-amber-500/30 bg-amber-500/5 text-amber-300",
  x402: "border-rose-500/30 bg-rose-500/5 text-rose-300",
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
          <div className="flex-1">
            <p className="text-sm font-medium text-cyan-300">Try these tools right now from claude.ai</p>
            <p className="text-xs text-cyan-200/70 mt-1">
              The MCP server is hosted as a remote connector. No clone, no local setup —
              add the custom connector in claude.ai and all {MCP_TOOLS.length} tools become
              available to any conversation.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href="https://claude.ai/settings/connectors"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 rounded-md text-cyan-200 transition"
              >
                Open claude.ai connectors
                <ExternalLink className="w-3 h-3" />
              </a>
              <code className="text-[11px] font-mono text-cyan-200/60 bg-black/30 px-2 py-1 rounded">
                https://aep-mcp-judge.fly.dev
              </code>
            </div>
            <p className="text-[11px] text-cyan-200/50 mt-2">
              Bearer token published on the{" "}
              <a
                href="https://github.com/agenomics-labs/protocol/blob/main/SUBMISSION.md"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-cyan-200"
              >
                Colosseum submission
              </a>
              {" · "}
              Full walkthrough in{" "}
              <a
                href="https://github.com/agenomics-labs/protocol/blob/main/JUDGE_RUNBOOK.md#step-0--claudeai-connector-60-seconds-no-clone-needed"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-cyan-200"
              >
                JUDGE_RUNBOOK
              </a>
              {" · "}
              Railway mirror:{" "}
              <code className="text-cyan-200/60">aep-mcp.up.railway.app</code>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

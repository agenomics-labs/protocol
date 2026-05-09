import { Users, Star, CheckCircle } from "lucide-react";

export default function AgentList({ agents, indexerConnected }) {
  if (!indexerConnected) {
    return (
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-center text-gray-400 text-sm py-8">
          <Users className="w-8 h-8 mx-auto mb-3 text-gray-600" />
          Live agent feed temporarily unavailable.
          <p className="text-xs text-gray-600 mt-2">
            Refreshing automatically every 30s. The on-chain registry is still queryable directly via RPC.
          </p>
        </div>
      </div>
    );
  }

  if (!agents || agents.length === 0) {
    return (
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-center text-gray-400 text-sm py-8">
          <Users className="w-8 h-8 mx-auto mb-3 text-gray-600" />
          No agents registered yet.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/5 rounded-xl border border-white/10 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Users className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold">Registered Agents</h2>
        <span className="text-xs text-gray-500">({agents.length})</span>
      </div>

      <div className="space-y-2">
        {agents.map((agent) => (
          <div
            key={agent.authority || agent.id}
            className="bg-white/5 rounded-lg border border-white/5 p-4"
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-semibold text-sm">{agent.name || "Unnamed Agent"}</div>
                {agent.category && (
                  <span className="inline-block mt-1 px-2 py-0.5 text-xs bg-blue-500/20 text-blue-300 rounded">
                    {agent.category}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="flex items-center gap-1 text-xs text-yellow-400">
                  <Star className="w-3 h-3 fill-current" />
                  {agent.reputation_score ?? 0}
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-400 mt-1">
                  <CheckCircle className="w-3 h-3" />
                  {agent.tasks_completed ?? 0} tasks
                </div>
              </div>
            </div>
            {agent.authority && (
              <code className="text-xs font-mono text-gray-500 break-all">{agent.authority}</code>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

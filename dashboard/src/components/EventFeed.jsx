import { Radio, AlertTriangle } from "lucide-react";

const PROGRAM_COLORS = {
  vault: "text-violet-400 bg-violet-500/10",
  registry: "text-blue-400 bg-blue-500/10",
  settlement: "text-emerald-400 bg-emerald-500/10",
};

export default function EventFeed({ events, indexerConnected }) {
  if (!indexerConnected) {
    return (
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-center text-gray-400 text-sm py-8">
          <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-gray-600" />
          Live event feed temporarily unavailable.
          <p className="text-xs text-gray-600 mt-2">
            Refreshing automatically every 30s.
          </p>
        </div>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="bg-white/5 rounded-xl border border-white/10 p-6">
        <div className="text-center text-gray-400 text-sm py-8">
          <Radio className="w-8 h-8 mx-auto mb-3 text-gray-600" />
          No events yet — waiting for on-chain activity.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white/5 rounded-xl border border-white/10 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Radio className="w-5 h-5 text-green-400" />
        <h2 className="text-lg font-semibold">Recent Events</h2>
        <span className="text-xs text-gray-500">({events.length})</span>
      </div>

      <div className="space-y-1 max-h-96 overflow-y-auto">
        {events.map((event) => (
          <div
            key={event.id}
            className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2 text-sm"
          >
            <span
              className={`px-2 py-0.5 text-xs rounded font-medium ${
                PROGRAM_COLORS[event.program] || "text-gray-400 bg-gray-500/10"
              }`}
            >
              {event.program}
            </span>
            <span className="font-mono text-xs text-cyan-300 flex-1 truncate">
              {event.event_name}
            </span>
            <span className="text-xs text-gray-500">slot {event.slot}</span>
            <code className="text-xs font-mono text-gray-500 truncate w-32">
              {event.signature?.substring(0, 16)}...
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

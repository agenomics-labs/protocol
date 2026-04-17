import { Lock, ArrowRight } from "lucide-react";
import { ESCROW_STATES } from "../data/programs.js";

export default function EscrowExplorer({ settlementAccounts }) {
  return (
    <div className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-6">
      {/* Escrow lifecycle diagram */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lock className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold">Escrow Lifecycle</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {ESCROW_STATES.map((state, i) => (
            <div key={state.name} className="flex items-center gap-2">
              <span className={`px-3 py-1.5 rounded font-medium ${state.color}`}>
                {state.name}
              </span>
              {i < ESCROW_STATES.length - 1 && (
                <ArrowRight className="w-3 h-3 text-gray-500" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Milestone lifecycle */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Milestone Lifecycle</h3>
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="px-2 py-1 rounded bg-gray-700 text-gray-200">Pending</span>
          <ArrowRight className="w-3 h-3 text-gray-500" />
          <span className="px-2 py-1 rounded bg-blue-800 text-blue-200">Submitted</span>
          <ArrowRight className="w-3 h-3 text-gray-500" />
          <span className="px-2 py-1 rounded bg-green-800 text-green-200">Approved</span>
        </div>
        <div className="flex items-center gap-2 text-xs mt-2">
          <span className="px-2 py-1 rounded bg-blue-800 text-blue-200">Submitted</span>
          <ArrowRight className="w-3 h-3 text-gray-500" />
          <span className="px-2 py-1 rounded bg-gray-700 text-gray-200">Rejected → Pending</span>
          <ArrowRight className="w-3 h-3 text-gray-500" />
          <span className="text-gray-400 italic">rework cycle</span>
        </div>
      </div>

      {/* Live escrow accounts */}
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">
          Live Escrow Accounts ({settlementAccounts.length})
        </h3>
        {settlementAccounts.length === 0 ? (
          <p className="text-xs text-gray-500 italic py-2">No active escrows on-chain yet.</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {settlementAccounts.map((escrow) => (
              <div
                key={escrow.pubkey}
                className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2"
              >
                <code className="text-xs font-mono text-cyan-300 truncate flex-1">
                  {escrow.pubkey}
                </code>
                <span className="text-xs text-gray-400">{escrow.dataSize}B</span>
                <span className="text-xs text-gray-400">
                  {(escrow.lamports / 1e9).toFixed(4)} SOL
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

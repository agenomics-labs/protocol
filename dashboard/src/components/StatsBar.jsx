import { Shield, Users, Coins, Globe, Radio, Lock } from "lucide-react";
import { NETWORK_LABEL } from "../config.js";

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <div className="bg-white/5 rounded-xl border border-white/10 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

export default function StatsBar({ agents, settlementAccounts, stats, vaultBalance, loading }) {
  const totalEvents = stats?.totalEvents ?? 0;
  return (
    <>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Programs" value="3" icon={Shield} color="text-violet-400" />
        <StatCard
          label="Registered Agents"
          value={loading ? "..." : agents.length}
          icon={Users}
          color="text-blue-400"
        />
        <StatCard
          label="Active Escrows"
          value={loading ? "..." : settlementAccounts.length}
          icon={Coins}
          color="text-emerald-400"
        />
        <StatCard
          label="Vault Balance"
          value={
            loading ? "..." : vaultBalance !== null ? `${vaultBalance.toFixed(2)} SOL` : "—"
          }
          icon={Lock}
          color="text-purple-400"
        />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Total Events"
          value={loading ? "..." : totalEvents}
          icon={Radio}
          color="text-green-400"
        />
        <StatCard label="MCP Tools" value="23" icon={Globe} color="text-cyan-400" />
        <StatCard label="CPI Flows" value="2" icon={Shield} color="text-yellow-400" />
        <StatCard label="Network" value={NETWORK_LABEL} icon={Radio} color="text-green-400" />
      </div>
    </>
  );
}

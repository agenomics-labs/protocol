import { useState } from "react";
import { Shield, Lock, Globe, Users, Radio } from "lucide-react";
import { NETWORK_LABEL } from "./config.js";
import { useProtocolData } from "./hooks/useProtocolData.js";
import StatsBar from "./components/StatsBar.jsx";
import ProgramExplorer from "./components/ProgramExplorer.jsx";
import AgentList from "./components/AgentList.jsx";
import EventFeed from "./components/EventFeed.jsx";
import EscrowExplorer from "./components/EscrowExplorer.jsx";
import McpToolList from "./components/McpToolList.jsx";

function NetworkBadge() {
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400">
      {NETWORK_LABEL}
    </span>
  );
}

function IndexerStatus({ connected, rpcReachable }) {
  // Three states:
  // - connected: indexer up — full live data (green)
  // - !connected && rpcReachable: indexer down, RPC fallback working (amber)
  // - !connected && !rpcReachable: both down (gray)
  const state = connected ? "live" : rpcReachable ? "rpc" : "offline";
  const styles = {
    live:    { wrap: "bg-green-500/10 border-green-500/20 text-green-400",  dot: "bg-green-400",  label: "Live data" },
    rpc:     { wrap: "bg-amber-500/10 border-amber-500/20 text-amber-300", dot: "bg-amber-400",  label: "RPC fallback" },
    offline: { wrap: "bg-gray-500/10 border-gray-500/20 text-gray-400",    dot: "bg-gray-500",   label: "Backend offline" },
  }[state];
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${styles.wrap}`}
      title={
        state === "live"
          ? "Indexer connected — agents and events refresh in near-real-time."
          : state === "rpc"
          ? "Indexer is unreachable; on-chain reads are coming straight from Solana RPC. Aggregate stats may lag."
          : "Both indexer and RPC are unreachable. Retrying automatically."
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full ${styles.dot}`} />
      {styles.label}
    </span>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState("programs");
  const {
    agents,
    events,
    stats,
    registryAccounts,
    settlementAccounts,
    vaultBalance,
    loading,
    error,
    indexerConnected,
    rpcReachable,
    lastUpdated,
    refresh,
  } = useProtocolData();

  const tabs = [
    { id: "programs", label: "Programs", icon: Shield },
    { id: "agents", label: "Agents", icon: Users },
    { id: "escrows", label: "Escrows", icon: Lock },
    { id: "events", label: "Events", icon: Radio },
    { id: "mcp", label: "MCP Tools", icon: Globe },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 text-white p-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-violet-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
              Agenomics Protocol
            </h1>
            <NetworkBadge />
            <IndexerStatus connected={indexerConnected} rpcReachable={rpcReachable} />
          </div>
          <p className="text-gray-400 mt-1 text-sm">
            Trustless economic layer for autonomous AI agents on Solana
          </p>
          {lastUpdated && (
            <p className="text-gray-600 text-xs mt-1">
              Last updated: {lastUpdated.toLocaleTimeString()}
              <button
                onClick={refresh}
                className="ml-2 text-cyan-500 hover:text-cyan-400 underline"
              >
                refresh
              </button>
            </p>
          )}
          {error && <p className="text-red-400 text-xs mt-1">Error: {error}</p>}
        </div>

        <StatsBar
          agents={indexerConnected ? agents : registryAccounts}
          settlementAccounts={settlementAccounts}
          stats={stats}
          vaultBalance={vaultBalance}
          loading={loading}
        />

        <div className="flex gap-1 bg-white/5 rounded-xl p-1 mb-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all ${
                  activeTab === tab.id
                    ? "bg-white/10 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "programs" && <ProgramExplorer />}
        {activeTab === "agents" && (
          <AgentList agents={agents} indexerConnected={indexerConnected} />
        )}
        {activeTab === "escrows" && <EscrowExplorer settlementAccounts={settlementAccounts} />}
        {activeTab === "events" && (
          <EventFeed events={events} indexerConnected={indexerConnected} />
        )}
        {activeTab === "mcp" && <McpToolList />}

        <div className="mt-8 text-center text-xs text-gray-600">
          Built with Anchor 0.31 · Solana 2.x · TypeScript · Model Context Protocol
        </div>
      </div>
    </div>
  );
}

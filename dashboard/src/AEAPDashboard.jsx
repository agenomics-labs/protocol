import { useState, useEffect, useCallback } from "react";
import { Shield, Users, Coins, ArrowRight, CheckCircle, XCircle, Clock, AlertTriangle, Zap, TrendingUp, Lock, Globe, Radio } from "lucide-react";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// ============================================================================
// Devnet Configuration
// ============================================================================

const DEVNET_RPC = "https://api.devnet.solana.com";
const connection = new Connection(DEVNET_RPC, "confirmed");

const PROGRAM_IDS = {
  vault: new PublicKey("4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN"),
  registry: new PublicKey("8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh"),
  settlement: new PublicKey("GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3"),
};

// Configure a wallet address to monitor (set via env or hardcode for demo)
const MONITORED_VAULT = null; // Set to a PublicKey string to monitor a specific vault

// ============================================================================
// AEAP Dashboard — Autonomous Economic Agents Protocol
// Interactive overview of the 3-program Solana architecture
// ============================================================================

const PROGRAMS = {
  vault: {
    name: "Agent Vault",
    id: "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN",
    icon: Shield,
    color: "from-violet-500 to-purple-600",
    tagColor: "bg-violet-100 text-violet-800",
    description: "Programmable wallets with spending policies for autonomous agents",
    features: [
      "Per-transaction & daily spending limits",
      "Rate limiting (max txs per hour)",
      "Token & program allowlists",
      "Pause/resume controls",
      "Real CPI via invoke_signed",
      "PDA-signed cross-program calls",
    ],
    instructions: [
      { name: "initialize_vault", desc: "Create vault with policy" },
      { name: "execute_transfer", desc: "Send SOL within limits" },
      { name: "execute_program_call", desc: "CPI to any allowed program" },
      { name: "update_policy", desc: "Modify spending rules" },
      { name: "add_token_allowlist", desc: "Whitelist a token" },
      { name: "add_program_allowlist", desc: "Whitelist a program" },
      { name: "pause_vault / resume_vault", desc: "Emergency controls" },
    ],
    accounts: [
      { name: "Vault", size: "~1KB", desc: "Policy + state + bump" },
    ],
    tests: 26,
  },
  registry: {
    name: "Agent Registry",
    id: "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh",
    icon: Users,
    color: "from-blue-500 to-cyan-600",
    tagColor: "bg-blue-100 text-blue-800",
    description: "Discovery and on-chain reputation system for AI agents",
    features: [
      "Agent profiles with capabilities & pricing",
      "On-chain reputation scoring",
      "Category-based discovery",
      "Status lifecycle (Active → Paused → Retired)",
      "CPI-only reputation updates",
      "Earnings & task completion tracking",
    ],
    instructions: [
      { name: "register_agent", desc: "Create agent profile" },
      { name: "update_profile", desc: "Modify name, pricing, etc." },
      { name: "update_status", desc: "Pause / reactivate agent" },
      { name: "update_reputation", desc: "CPI from Settlement only" },
      { name: "deregister_agent", desc: "Close account, reclaim rent" },
    ],
    accounts: [
      { name: "AgentProfile", size: "~2KB", desc: "Full agent metadata" },
    ],
    tests: 39,
  },
  settlement: {
    name: "Settlement Protocol",
    id: "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3",
    icon: Coins,
    color: "from-emerald-500 to-teal-600",
    tagColor: "bg-emerald-100 text-emerald-800",
    description: "Milestone-based escrow with dispute resolution for agent payments",
    features: [
      "SPL token escrow with PDA ownership",
      "Up to 5 milestones per task",
      "Submit → Approve/Reject → Rework cycle",
      "Dispute resolution with third-party resolver",
      "Auto-complete with CPI reputation update",
      "Checks-Effects-Interactions pattern",
    ],
    instructions: [
      { name: "create_escrow", desc: "Lock tokens in milestone escrow" },
      { name: "accept_task", desc: "Provider accepts the job" },
      { name: "submit_milestone", desc: "Provider submits work" },
      { name: "approve_milestone", desc: "Client approves + pays" },
      { name: "reject_milestone", desc: "Client requests rework" },
      { name: "raise_dispute", desc: "Either party disputes" },
      { name: "resolve_dispute", desc: "Resolver splits funds" },
      { name: "cancel_escrow", desc: "Client cancels (pre-accept)" },
    ],
    accounts: [
      { name: "TaskEscrow", size: "~1.5KB", desc: "Escrow state + milestones" },
    ],
    tests: 28,
  },
};

const MCP_TOOLS = [
  { name: "create_vault", program: "vault" },
  { name: "get_vault_info", program: "vault" },
  { name: "vault_transfer", program: "vault" },
  { name: "update_vault_policy", program: "vault" },
  { name: "manage_allowlist", program: "vault" },
  { name: "pause_vault", program: "vault" },
  { name: "resume_vault", program: "vault" },
  { name: "register_agent", program: "registry" },
  { name: "get_agent_profile", program: "registry" },
  { name: "update_agent_profile", program: "registry" },
  { name: "discover_agents", program: "registry" },
  { name: "create_escrow", program: "settlement" },
  { name: "get_escrow_status", program: "settlement" },
  { name: "accept_task", program: "settlement" },
  { name: "submit_milestone", program: "settlement" },
  { name: "approve_milestone", program: "settlement" },
  { name: "reject_milestone", program: "settlement" },
  { name: "raise_dispute", program: "settlement" },
  { name: "resolve_dispute", program: "settlement" },
  { name: "cancel_escrow", program: "settlement" },
];

const ESCROW_STATES = [
  { name: "Created", color: "bg-gray-200 text-gray-800" },
  { name: "Active", color: "bg-blue-200 text-blue-800" },
  { name: "Disputed", color: "bg-amber-200 text-amber-800" },
  { name: "Completed", color: "bg-green-200 text-green-800" },
  { name: "Cancelled", color: "bg-red-200 text-red-800" },
];

const CPI_FLOWS = [
  {
    from: "Settlement",
    to: "Registry",
    method: "update_reputation",
    trigger: "All milestones approved",
    desc: "Real CPI via invoke() — updates reputation score (+50), tasks_completed (+1), and total_earnings",
  },
  {
    from: "Vault",
    to: "Any Program",
    method: "execute_program_call",
    trigger: "Agent executes allowed program",
    desc: "Real CPI via invoke_signed() — vault PDA signs the transaction using stored bump seed",
  },
];

function ProgramCard({ programKey, isActive, onClick }) {
  const p = PROGRAMS[programKey];
  const Icon = p.icon;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl p-4 transition-all duration-200 border-2 ${
        isActive
          ? "border-white/40 bg-white/10 shadow-lg scale-[1.02]"
          : "border-transparent bg-white/5 hover:bg-white/8 hover:border-white/20"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${p.color} flex items-center justify-center`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <h3 className="font-semibold text-white text-sm">{p.name}</h3>
          <p className="text-xs text-gray-400">{p.tests} tests</p>
        </div>
      </div>
    </button>
  );
}

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <div className="bg-white/5 rounded-xl p-4 border border-white/10">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-gray-400">{label}</span>
      </div>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

function ProgramDetail({ programKey }) {
  const p = PROGRAMS[programKey];
  const Icon = p.icon;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${p.color} flex items-center justify-center`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white">{p.name}</h2>
          <p className="text-sm text-gray-400">{p.description}</p>
        </div>
      </div>

      <div className="bg-black/30 rounded-lg p-3 font-mono text-xs text-gray-300 break-all">
        {p.id}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Features</h3>
        <div className="grid grid-cols-1 gap-1.5">
          {p.features.map((f, i) => (
            <div key={i} className="flex items-start gap-2">
              <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 shrink-0" />
              <span className="text-sm text-gray-300">{f}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Instructions ({p.instructions.length})</h3>
        <div className="space-y-1.5">
          {p.instructions.map((ix, i) => (
            <div key={i} className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2">
              <code className="text-xs font-mono text-cyan-300 min-w-[180px]">{ix.name}</code>
              <span className="text-xs text-gray-400">{ix.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Accounts</h3>
        {p.accounts.map((a, i) => (
          <div key={i} className="bg-white/5 rounded-lg px-3 py-2 flex items-center gap-3">
            <span className="font-mono text-sm text-purple-300">{a.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${p.tagColor}`}>{a.size}</span>
            <span className="text-xs text-gray-400">{a.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CPIFlowSection() {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-300">Cross-Program Invocations (Real CPI)</h3>
      {CPI_FLOWS.map((flow, i) => (
        <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="px-2 py-0.5 bg-emerald-900/50 text-emerald-300 text-xs rounded font-mono">{flow.from}</span>
            <ArrowRight className="w-4 h-4 text-yellow-400" />
            <span className="px-2 py-0.5 bg-blue-900/50 text-blue-300 text-xs rounded font-mono">{flow.to}</span>
            <code className="text-xs text-cyan-300 ml-2">{flow.method}()</code>
          </div>
          <p className="text-xs text-gray-400 mb-1">Trigger: {flow.trigger}</p>
          <p className="text-xs text-gray-300">{flow.desc}</p>
        </div>
      ))}
    </div>
  );
}

function EscrowLifecycle() {
  const [activeState, setActiveState] = useState(0);
  const transitions = [
    { from: 0, to: 1, label: "accept_task" },
    { from: 1, to: 3, label: "approve (all)" },
    { from: 1, to: 2, label: "raise_dispute" },
    { from: 2, to: 3, label: "resolve_dispute" },
    { from: 0, to: 4, label: "cancel_escrow" },
  ];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-300">Escrow State Machine</h3>
      <div className="flex flex-wrap gap-2">
        {ESCROW_STATES.map((s, i) => (
          <button
            key={i}
            onClick={() => setActiveState(i)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${s.color} ${
              activeState === i ? "ring-2 ring-white/50 scale-105" : "opacity-70 hover:opacity-100"
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        {transitions
          .filter((t) => t.from === activeState)
          .map((t, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded ${ESCROW_STATES[t.from].color}`}>{ESCROW_STATES[t.from].name}</span>
              <ArrowRight className="w-3 h-3 text-gray-500" />
              <code className="text-cyan-300 font-mono">{t.label}</code>
              <ArrowRight className="w-3 h-3 text-gray-500" />
              <span className={`px-2 py-0.5 rounded ${ESCROW_STATES[t.to].color}`}>{ESCROW_STATES[t.to].name}</span>
            </div>
          ))}
        {transitions.filter((t) => t.from === activeState).length === 0 && (
          <p className="text-xs text-gray-500 italic">Terminal state — no further transitions</p>
        )}
      </div>
    </div>
  );
}

function MCPSection() {
  const grouped = { vault: [], registry: [], settlement: [] };
  MCP_TOOLS.forEach((t) => grouped[t.program].push(t));

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-300">MCP Server Tools ({MCP_TOOLS.length})</h3>
      <p className="text-xs text-gray-400">
        Every on-chain instruction is exposed as an MCP tool, enabling any AI agent to interact with AEAP through the Model Context Protocol.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(grouped).map(([key, tools]) => (
          <div key={key} className="space-y-1">
            <div className={`text-xs font-semibold mb-1.5 ${
              key === "vault" ? "text-purple-400" : key === "registry" ? "text-blue-400" : "text-emerald-400"
            }`}>
              {PROGRAMS[key].name} ({tools.length})
            </div>
            {tools.map((t, i) => (
              <div key={i} className="font-mono text-xs text-gray-300 bg-white/5 rounded px-2 py-1">
                {t.name}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DevnetBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-900/40 border border-green-500/30 text-green-400 text-xs font-medium">
      <Radio className="w-3 h-3 animate-pulse" />
      Devnet
    </span>
  );
}

function useDevnetData() {
  const [vaultBalance, setVaultBalance] = useState(null);
  const [agentProfiles, setAgentProfiles] = useState([]);
  const [escrowAccounts, setEscrowAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch vault balance if a monitored vault is configured
      if (MONITORED_VAULT) {
        try {
          const balance = await connection.getBalance(new PublicKey(MONITORED_VAULT));
          setVaultBalance(balance / LAMPORTS_PER_SOL);
        } catch (err) {
          console.warn("Failed to fetch vault balance:", err.message);
          setVaultBalance(null);
        }
      }

      // Fetch agent profiles from registry program
      try {
        const registryAccounts = await connection.getProgramAccounts(PROGRAM_IDS.registry, {
          commitment: "confirmed",
        });
        setAgentProfiles(registryAccounts.map((account) => ({
          pubkey: account.pubkey.toBase58(),
          dataSize: account.account.data.length,
          lamports: account.account.lamports,
        })));
      } catch (err) {
        console.warn("Failed to fetch registry accounts:", err.message);
        setAgentProfiles([]);
      }

      // Fetch escrow accounts from settlement program
      try {
        const settlementAccounts = await connection.getProgramAccounts(PROGRAM_IDS.settlement, {
          commitment: "confirmed",
        });
        setEscrowAccounts(settlementAccounts.map((account) => ({
          pubkey: account.pubkey.toBase58(),
          dataSize: account.account.data.length,
          lamports: account.account.lamports,
        })));
      } catch (err) {
        console.warn("Failed to fetch settlement accounts:", err.message);
        setEscrowAccounts([]);
      }

      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { vaultBalance, agentProfiles, escrowAccounts, loading, error, lastUpdated, refresh: fetchData };
}

export default function AEAPDashboard() {
  const [activeProgram, setActiveProgram] = useState("vault");
  const [activeTab, setActiveTab] = useState("programs");
  const { vaultBalance, agentProfiles, escrowAccounts, loading, error, lastUpdated, refresh } = useDevnetData();

  const tabs = [
    { id: "programs", label: "Programs", icon: Shield },
    { id: "cpi", label: "CPI Flows", icon: Zap },
    { id: "escrow", label: "Escrow", icon: Lock },
    { id: "mcp", label: "MCP Server", icon: Globe },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-gray-900 to-gray-950 text-white p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-2">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-violet-400 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
              AEAP Dashboard
            </h1>
            <DevnetBadge />
          </div>
          <p className="text-gray-400 mt-1 text-sm">Autonomous Economic Agents Protocol — Solana/Anchor</p>
          <p className="text-gray-500 text-xs mt-1">Colosseum Frontier Hackathon 2026</p>
          {lastUpdated && (
            <p className="text-gray-600 text-xs mt-1">
              Last updated: {lastUpdated.toLocaleTimeString()}
              <button onClick={refresh} className="ml-2 text-cyan-500 hover:text-cyan-400 underline">
                refresh
              </button>
            </p>
          )}
          {error && (
            <p className="text-red-400 text-xs mt-1">RPC error: {error}</p>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Programs" value="3" icon={Shield} color="text-violet-400" />
          <StatCard label="Registered Agents" value={loading ? "..." : agentProfiles.length} icon={Users} color="text-blue-400" />
          <StatCard label="Active Escrows" value={loading ? "..." : escrowAccounts.length} icon={Coins} color="text-emerald-400" />
          <StatCard label="Vault Balance" value={vaultBalance !== null ? `${vaultBalance.toFixed(2)} SOL` : "N/A"} icon={Lock} color="text-purple-400" />
        </div>
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatCard label="Tests Passing" value="114" icon={CheckCircle} color="text-green-400" />
          <StatCard label="MCP Tools" value="20" icon={Globe} color="text-cyan-400" />
          <StatCard label="CPI Flows" value="2" icon={Zap} color="text-yellow-400" />
          <StatCard label="Network" value="Devnet" icon={Radio} color="text-green-400" />
        </div>

        {/* Tabs */}
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

        {/* Content */}
        {activeTab === "programs" && (
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-4 space-y-2">
              {Object.keys(PROGRAMS).map((key) => (
                <ProgramCard
                  key={key}
                  programKey={key}
                  isActive={activeProgram === key}
                  onClick={() => setActiveProgram(key)}
                />
              ))}
            </div>
            <div className="col-span-8 bg-white/5 rounded-xl border border-white/10 p-6">
              <ProgramDetail programKey={activeProgram} />
            </div>
          </div>
        )}

        {activeTab === "cpi" && (
          <div className="bg-white/5 rounded-xl border border-white/10 p-6">
            <CPIFlowSection />
            <div className="mt-6 p-4 bg-yellow-900/20 border border-yellow-700/30 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-yellow-300">Real CPI — Not Stubs</p>
                  <p className="text-xs text-yellow-200/70 mt-1">
                    Both cross-program invocations use Solana's native invoke() and invoke_signed() — verified on-chain
                    with the test validator. Settlement passes its own executable account to Registry for caller verification.
                    Vault uses stored PDA bump for invoke_signed with remaining_accounts.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "escrow" && (
          <div className="bg-white/5 rounded-xl border border-white/10 p-6">
            <EscrowLifecycle />
            <div className="mt-6">
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
          </div>
        )}

        {activeTab === "mcp" && (
          <div className="bg-white/5 rounded-xl border border-white/10 p-6">
            <MCPSection />
            <div className="mt-6 p-4 bg-cyan-900/20 border border-cyan-700/30 rounded-lg">
              <div className="flex items-start gap-2">
                <Globe className="w-4 h-4 text-cyan-400 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-cyan-300">Full MCP Integration</p>
                  <p className="text-xs text-cyan-200/70 mt-1">
                    The MCP server wraps all 3 programs with input validation, error handling, and typed responses.
                    Any AI agent (Claude, GPT, etc.) can discover agents, create vaults, manage escrows, and handle
                    payments — all through the standard Model Context Protocol.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Live Devnet Data */}
        {(agentProfiles.length > 0 || escrowAccounts.length > 0) && (
          <div className="mt-6 bg-white/5 rounded-xl border border-white/10 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Radio className="w-4 h-4 text-green-400" />
              <h3 className="text-sm font-semibold text-gray-300">Live Devnet Accounts</h3>
              <DevnetBadge />
            </div>

            {agentProfiles.length > 0 && (
              <div className="mb-4">
                <h4 className="text-xs font-semibold text-blue-400 mb-2">Registry Accounts ({agentProfiles.length})</h4>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {agentProfiles.map((profile) => (
                    <div key={profile.pubkey} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2">
                      <code className="text-xs font-mono text-cyan-300 truncate flex-1">{profile.pubkey}</code>
                      <span className="text-xs text-gray-400">{profile.dataSize}B</span>
                      <span className="text-xs text-gray-400">{(profile.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {escrowAccounts.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-emerald-400 mb-2">Settlement Accounts ({escrowAccounts.length})</h4>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {escrowAccounts.map((escrow) => (
                    <div key={escrow.pubkey} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2">
                      <code className="text-xs font-mono text-cyan-300 truncate flex-1">{escrow.pubkey}</code>
                      <span className="text-xs text-gray-400">{escrow.dataSize}B</span>
                      <span className="text-xs text-gray-400">{(escrow.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="mt-8 text-center text-xs text-gray-600">
          Built with Anchor 0.30.1 · Solana 2.1.x · TypeScript · Model Context Protocol
        </div>
      </div>
    </div>
  );
}

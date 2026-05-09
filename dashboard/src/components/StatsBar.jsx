import { Shield, Users, Coins, Globe, Radio, Lock, AlertTriangle, Scale } from "lucide-react";
import { NETWORK_LABEL } from "../config.js";
import { MCP_TOOLS } from "../data/programs.js";
import { useTriggerMetrics } from "../hooks/useTriggerMetrics.js";

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

// ADR-131 §"Re-calibration trigger" #1 — green/yellow/red on cumulative
// 7-day fresh-authority dispute incidents. The Y1 trigger is >= 5 / quarter,
// but the dashboard surfaces the same count over the rolling 7-day window
// the indexer view aggregates; ops compare to the quarterly budget of 5.
function sybilColor(count) {
  if (count == null) return "text-gray-400";
  if (count >= 5) return "text-red-400";
  if (count >= 1) return "text-yellow-400";
  return "text-green-400";
}

// ADR-131 §"Re-calibration trigger" #2 — green/yellow/red on the SOL-denominated
// 30-day median escrow. Threshold from the ADR: > 1 SOL for a sustained 30-day
// rolling average is the trigger. We split SOL vs USDC at the API (the indexer
// view groups by token_mint); the card highlights whichever token has the
// largest sample size. Color logic is anchored to the ADR's SOL threshold;
// USDC sample counts get a neutral palette since the ADR does not set a USDC-
// specific re-calibration threshold today.
function medianColor(amountSol) {
  if (amountSol == null) return "text-gray-400";
  if (amountSol > 1.0) return "text-red-400";
  if (amountSol >= 0.5) return "text-yellow-400";
  return "text-green-400";
}

// Convert raw base units (lamports for SOL, micro-USDC for USDC) to a
// human-readable decimal using the mint's `decimals`. Returns Number;
// caller is responsible for choosing precision when rendering.
function baseUnitsToDecimal(baseUnits, decimals) {
  if (baseUnits == null) return null;
  const asNumber = Number(baseUnits);
  if (!Number.isFinite(asNumber)) return null;
  return asNumber / Math.pow(10, decimals ?? 0);
}

// SOL has the well-known native sentinel and is decimals=9; USDC mainnet mint
// is `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` and is decimals=6. The
// indexer view emits `'native'` for SOL per the schema contract documented
// in metrics-server.ts. Keep the SOL detection at the symbol layer (mint
// address + 'native' alias) so a future change to the sentinel surfaces here.
function isSolMint(mint) {
  return mint === "native" || mint === "So11111111111111111111111111111111111111112";
}

// Pick the token to feature on the card: the one with the largest sample
// count. Ties break toward SOL since the ADR-131 threshold is SOL-denominated.
function pickFeatured(medianByToken) {
  if (!medianByToken) return null;
  const entries = Object.entries(medianByToken);
  if (entries.length === 0) return null;
  let best = entries[0];
  for (const entry of entries.slice(1)) {
    const [mintA, valA] = best;
    const [mintB, valB] = entry;
    if (valB.sampleCount > valA.sampleCount) {
      best = entry;
    } else if (valB.sampleCount === valA.sampleCount && isSolMint(mintB) && !isSolMint(mintA)) {
      best = entry;
    }
  }
  return { mint: best[0], ...best[1] };
}

export default function StatsBar({ agents, settlementAccounts, stats, vaultBalance, loading }) {
  const totalEvents = stats?.totalEvents ?? 0;
  const triggerMetrics = useTriggerMetrics();

  // Sybil card value + color.
  const sybilCount = triggerMetrics.available ? triggerMetrics.sybilPatterns?.count ?? null : null;
  const sybilDisplay = triggerMetrics.loading
    ? "..."
    : sybilCount == null
    ? "—"
    : String(sybilCount);

  // Median escrow card value + color (SOL-anchored — see medianColor docstring).
  const featured = triggerMetrics.available
    ? pickFeatured(triggerMetrics.escrowMedian?.medianByToken)
    : null;
  const featuredIsSol = featured ? isSolMint(featured.mint) : false;
  const featuredAmount = featured
    ? baseUnitsToDecimal(featured.medianAmountBaseUnits, featured.decimals)
    : null;
  const medianDisplay = triggerMetrics.loading
    ? "..."
    : featured == null || featuredAmount == null
    ? "—"
    : featuredIsSol
    ? `${featuredAmount.toFixed(3)} SOL`
    : `${featuredAmount.toFixed(2)} (${featured.mint.slice(0, 4)}…)`;
  // Color logic only applies the ADR threshold when the featured token is SOL;
  // a USDC-dominant window gets the neutral-gray palette.
  const medianColorClass = featuredIsSol ? medianColor(featuredAmount) : "text-gray-400";

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
        <StatCard label="MCP Tools" value={MCP_TOOLS.length} icon={Globe} color="text-cyan-400" />
        <StatCard label="CPI Flows" value="2" icon={Shield} color="text-yellow-400" />
        <StatCard label="Network" value={NETWORK_LABEL} icon={Radio} color="text-green-400" />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Sybil Patterns (7d)"
          value={sybilDisplay}
          icon={AlertTriangle}
          color={sybilColor(sybilCount)}
        />
        <StatCard
          label="Median Escrow (30d)"
          value={medianDisplay}
          icon={Scale}
          color={medianColorClass}
        />
      </div>
    </>
  );
}

import { useState, useEffect, useCallback } from "react";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { INDEXER_URL, MONITORED_VAULT, PROGRAM_IDS, connection } from "../config.js";

/**
 * W-04/W-03 — bounded fetch. The indexer/metrics services are
 * separately-deployed origins (validated in config.js). A slow/hung
 * endpoint or a MITM holding the socket open would otherwise stall the
 * 30 s poll loop and stack overlapping in-flight requests. Abort after
 * `FETCH_TIMEOUT_MS`.
 */
const FETCH_TIMEOUT_MS = 8000;

async function fetchJsonBounded(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Non-OK status ${res.status} from ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * W-02 — shape validation. The indexer is an untrusted boundary; a
 * compromised/spoofed indexer can return attacker-shaped JSON that is
 * otherwise rendered verbatim. Reject anything that is not the expected
 * shape and fall back to empty (the "Backend offline" UI path), the way
 * the sas-resolver Zod-validates every boundary.
 */
function asArrayField(json, field) {
  if (json && typeof json === "object" && Array.isArray(json[field])) {
    return json[field];
  }
  return [];
}

function asStatsObject(json) {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    return json;
  }
  return null;
}

/**
 * Indexer-first data fetching hook with RPC fallback.
 * Polls every 30 seconds.
 */
export function useProtocolData() {
  const [data, setData] = useState({
    agents: [],
    events: [],
    stats: null,
    registryAccounts: [],
    settlementAccounts: [],
    vaultBalance: null,
    loading: true,
    error: null,
    indexerConnected: false,
    rpcReachable: false,
    lastUpdated: null,
  });

  const fetchFromIndexer = useCallback(async () => {
    try {
      const [agentsJson, eventsJson, statsJson] = await Promise.all([
        fetchJsonBounded(`${INDEXER_URL}/agents?limit=50`),
        fetchJsonBounded(`${INDEXER_URL}/events?limit=20`),
        fetchJsonBounded(`${INDEXER_URL}/stats`),
      ]);
      return {
        agents: asArrayField(agentsJson, "agents"),
        events: asArrayField(eventsJson, "events"),
        stats: asStatsObject(statsJson),
        indexerConnected: true,
      };
    } catch {
      return { indexerConnected: false };
    }
  }, []);

  const fetchFromRpc = useCallback(async () => {
    const result = {
      registryAccounts: [],
      settlementAccounts: [],
      vaultBalance: null,
      // Set to true the moment any RPC call succeeds. Used to drive the
      // "Live data | RPC fallback | Backend offline" badge in the header.
      rpcReachable: false,
    };

    try {
      const registryAccounts = await connection.getProgramAccounts(PROGRAM_IDS.registry, {
        commitment: "confirmed",
      });
      result.registryAccounts = registryAccounts.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        dataSize: account.account.data.length,
        lamports: account.account.lamports,
      }));
      result.rpcReachable = true;
    } catch (err) {
      console.warn("Failed to fetch registry accounts:", err.message);
    }

    try {
      const settlementAccounts = await connection.getProgramAccounts(PROGRAM_IDS.settlement, {
        commitment: "confirmed",
      });
      result.settlementAccounts = settlementAccounts.map((account) => ({
        pubkey: account.pubkey.toBase58(),
        dataSize: account.account.data.length,
        lamports: account.account.lamports,
      }));
      result.rpcReachable = true;
    } catch (err) {
      console.warn("Failed to fetch settlement accounts:", err.message);
    }

    if (MONITORED_VAULT) {
      try {
        const balance = await connection.getBalance(new PublicKey(MONITORED_VAULT));
        result.vaultBalance = balance / LAMPORTS_PER_SOL;
        result.rpcReachable = true;
      } catch (err) {
        console.warn("Failed to fetch vault balance:", err.message);
      }
    }

    return result;
  }, []);

  const fetchData = useCallback(async () => {
    setData((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [indexerData, rpcData] = await Promise.all([fetchFromIndexer(), fetchFromRpc()]);
      setData({
        agents: indexerData.agents || [],
        events: indexerData.events || [],
        stats: indexerData.stats || null,
        registryAccounts: rpcData.registryAccounts,
        settlementAccounts: rpcData.settlementAccounts,
        vaultBalance: rpcData.vaultBalance,
        indexerConnected: !!indexerData.indexerConnected,
        rpcReachable: !!rpcData.rpcReachable,
        loading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } catch (err) {
      setData((prev) => ({ ...prev, loading: false, error: err.message }));
    }
  }, [fetchFromIndexer, fetchFromRpc]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { ...data, refresh: fetchData };
}

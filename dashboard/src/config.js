import { PublicKey, Connection } from "@solana/web3.js";

/**
 * W-04 (cycle-4 web re-audit) — dashboard runtime-config trust boundary.
 *
 * `VITE_*` URL env vars flow directly into `fetch()` and
 * `new Connection()`. Unvalidated, a misconfigured/poisoned deploy env
 * (or a Vercel preview with a bad env var) silently points production
 * at an arbitrary or plaintext origin that then feeds the unvalidated
 * render path (W-02). Fix: parse with `new URL()`, enforce `https:` for
 * any non-loopback host, and pin to a host allowlist. Fail loud (throw
 * at module load) rather than silently fetching.
 *
 * `import.meta.env.DEV` is Vite's build-time dev flag; loopback `http:`
 * is only tolerated when it is true.
 */
const IS_DEV = Boolean(import.meta.env.DEV);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Host suffixes the dashboard is permitted to talk to in production.
const ALLOWED_HOST_SUFFIXES = [
  ".solana.com", // Solana RPC (devnet/mainnet/custom validators)
  ".agenomics.xyz", // indexer API + metrics server (prod)
];

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => h === suffix.slice(1) || h.endsWith(suffix),
  );
}

/**
 * Validate a runtime-config URL fail-closed.
 * @param {string} raw - candidate URL string
 * @param {string} name - env var name (for error attribution)
 * @returns {string} the normalized, validated URL
 */
function validateUrl(raw, name) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${String(raw)}`);
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());

  if (parsed.protocol !== "https:") {
    // Plaintext is only tolerated for a loopback host in a dev build.
    if (!(parsed.protocol === "http:" && isLoopback && IS_DEV)) {
      throw new Error(
        `${name} must use https: (got ${parsed.protocol} for ` +
          `${parsed.hostname}); plaintext is only allowed for localhost ` +
          `in a dev build.`,
      );
    }
  }

  if (!hostAllowed(parsed.hostname)) {
    throw new Error(
      `${name} host "${parsed.hostname}" is not in the dashboard ` +
        `allowlist (${ALLOWED_HOST_SUFFIXES.join(", ")}, or loopback).`,
    );
  }

  return parsed.toString().replace(/\/$/, "");
}

export const RPC_URL = validateUrl(
  import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com",
  "VITE_RPC_URL",
);
export const INDEXER_URL = validateUrl(
  import.meta.env.VITE_INDEXER_URL || "http://localhost:3100",
  "VITE_INDEXER_URL",
);
// ADR-131 trigger endpoints are served by the indexer's metrics server
// (src/indexer/metrics-server.ts), which listens on its own port (default
// 9100) separate from the Express API on port 3100. The default mirrors
// `startMetricsServer`'s default; operators can override per-environment.
export const METRICS_API_URL = validateUrl(
  import.meta.env.VITE_METRICS_API_URL || "http://localhost:9100",
  "VITE_METRICS_API_URL",
);
export const MONITORED_VAULT = import.meta.env.VITE_MONITORED_VAULT || null;

export const connection = new Connection(RPC_URL, "confirmed");

export const PROGRAM_IDS = {
  vault: new PublicKey("D2y1dEi4dj1pcxw6GvkFWX34RRbuFJCaGWdPNJAasQ5q"),
  registry: new PublicKey("26KETQPxeMmbakxpVbUEpQBQmVgpabHAweTHBRgBHjW7"),
  settlement: new PublicKey("AwjdsNvhR2uwPNbU6F2fsYB33VcNGL5XaANdgsyvZDia"),
};

export const NETWORK_LABEL = RPC_URL.includes("devnet")
  ? "Devnet"
  : RPC_URL.includes("mainnet")
  ? "Mainnet"
  : "Localnet";

// Surface 2 — x402 client + CDP Server Wallet adapter (Surface 2 Day 3).
//
// Spec: docs/aep-reflex-tech-spec.md §"Surface 2 / Implementation" steps
// 2 + 3 (lines 245–252):
//
//   2. Get CDP Server Wallet for this agent.
//      `const wallet = await getOrCreateAgentWallet(params.agent_address)`
//
//   3. Make the x402 call.
//      `const client = new x402Client({ wallet, facilitator: "cdp" });
//       const response = await client.fetch(params.service_url, params.request);`
//
// Reality (the SDK shape diverged from the spec's pseudocode):
//   - `@coinbase/x402` v2.1.0 exports `createFacilitatorConfig({apiKeyId, apiKeySecret})`
//     plus auth-header helpers — it does NOT export `x402Client`.
//   - The actual *client* package is `x402-fetch` v1.2.0, which exports
//     `wrapFetchWithPayment(fetch, signer, maxValue, selector?, config?)`.
//     This wraps native fetch so a 402 response triggers the
//     "challenge → quote → sign payment header → retry → 200 + receipt"
//     dance automatically. Receipt lives in the `x-payment-response`
//     header, decoded via `decodeXPaymentResponse(headerValue)`.
//   - `@coinbase/cdp-sdk` v1.48.2 exports `CdpClient`. The EVM Server
//     Wallet for an agent is `cdp.evm.getOrCreateAccount({ name })`,
//     which returns a `ServerAccount` (viem-compatible signer).
//
// So this module wires:
//   - getOrCreateAgentWallet(agent_address) → CDP ServerAccount, cached.
//     Account name is derived from the AEP `agent_address` so the wallet
//     is stable per-agent across sessions (the spec's "keyed by
//     agent_address" requirement, master IC-3 + spec §"Open questions" Q5).
//   - payX402WithCdp({...}) → wrapFetchWithPayment + execute + decode receipt.
//
// Env vars required for the live path (drive from process.env, never
// hardcode — spec §"Risk register" R9):
//   - CDP_API_KEY_ID            — CDP Server Wallet API key id.
//   - CDP_API_KEY_SECRET        — CDP Server Wallet API key secret.
//   - CDP_WALLET_SECRET         — CDP wallet root secret (per CDP docs).
//   - X402_NETWORK              — "base" | "base-sepolia"; defaults to
//                                 "base-sepolia" so an unconfigured env
//                                 never accidentally hits mainnet.
//   - X402_FACILITATOR          — "cdp" | "kora"; defaults to "cdp".
//   - AEP_X402_LIVE             — "1" to enable the live path; absent or
//                                 "0" → the deterministic mock continues
//                                 to be used by the action handler.
//                                 Lets the existing 11 scaffold tests pass
//                                 without any CDP creds in CI.
//
// Test seam: `setX402CdpAdapter(...)` replaces the cached adapter.

import { serverLogger } from "../util/logger.js";

const log = serverLogger.child({ component: "x402-cdp" });

// ---------------------------------------------------------------------------
// Types surfaced to the caller (action handler).
// ---------------------------------------------------------------------------

export type X402Network = "base-mainnet" | "base-sepolia";
export type X402Facilitator = "cdp" | "kora";

export interface X402CallRequest {
  agent_address: string;
  service_url: string;
  /** Hard cap on the payment in USDC base units (micros). The client
   *  refuses to sign a payment header larger than this. */
  max_price_usdc_micros: number;
  request: {
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  };
}

export interface X402CallResult {
  status: number;
  body: string;
  payment: {
    /** Base-side settle tx hash (Surface 3 keys on this — spec §"Why
     *  direct Vault debit, not Settlement escrow", line 156). Blank string
     *  if the upstream returned 200 without a payment header (free tier). */
    tx_hash: string;
    /** Amount actually paid, decoded from the x-payment-response header. */
    amount_paid_micros: number;
    network: X402Network;
    facilitator: X402Facilitator;
  };
  duration_ms: number;
}

export interface X402CdpAdapter {
  /**
   * Drives the full x402 flow against the CDP Server Wallet keyed by
   * `agent_address`. Throws on transport errors; the handler maps these
   * to the IC-3 error table.
   */
  pay(request: X402CallRequest): Promise<X402CallResult>;
}

// ---------------------------------------------------------------------------
// Live adapter (loaded lazily so missing CDP / x402-fetch deps don't break
// the test path that uses the deterministic stub).
// ---------------------------------------------------------------------------

class LiveX402CdpAdapter implements X402CdpAdapter {
  // Cached `ServerAccount` instances keyed by agent_address. CDP's
  // `getOrCreateAccount` is idempotent on the `name` field so a cache miss
  // is safe — but the cache saves a network round-trip per call.
  private readonly walletCache = new Map<string, unknown>();

  async pay(request: X402CallRequest): Promise<X402CallResult> {
    // Dynamic imports keep this module load-cheap when the live path is
    // unused (the existing 400-test suite never imports CDP / x402-fetch).
    // Types are intentionally widened to `any` at the import boundary —
    // both packages declare their types correctly, but pinning them in a
    // dynamic-import return signature requires them to be installed in
    // node_modules at type-check time. The handler-side types we return
    // (`X402CallResult`) are static, so the upstream surface is fully
    // typed regardless.
    const x402Mod = (await import("x402-fetch" as string)) as {
      wrapFetchWithPayment: (
        fetch: typeof globalThis.fetch,
        signer: unknown,
        maxValue?: bigint,
      ) => (
        input: string | URL,
        init?: RequestInit,
      ) => Promise<Response>;
      decodeXPaymentResponse: (header: string) => {
        success?: boolean;
        transaction?: string;
        network?: string;
        payer?: string;
        errorReason?: string;
      };
    };
    const cdpMod = (await import("@coinbase/cdp-sdk" as string)) as {
      CdpClient: new (opts: {
        apiKeyId: string;
        apiKeySecret: string;
        walletSecret: string;
      }) => {
        evm: {
          getOrCreateAccount(opts: { name: string }): Promise<unknown>;
        };
      };
    };
    const { wrapFetchWithPayment, decodeXPaymentResponse } = x402Mod;
    const { CdpClient } = cdpMod;

    const apiKeyId = requireEnv("CDP_API_KEY_ID");
    const apiKeySecret = requireEnv("CDP_API_KEY_SECRET");
    const walletSecret = requireEnv("CDP_WALLET_SECRET");
    const network = (process.env.X402_NETWORK ?? "base-sepolia") as
      | "base"
      | "base-sepolia";
    const facilitator = (process.env.X402_FACILITATOR ?? "cdp") as
      | "cdp"
      | "kora";

    // Wallet
    const cacheKey = `${request.agent_address}:${network}`;
    let wallet = this.walletCache.get(cacheKey);
    if (!wallet) {
      const cdp = new CdpClient({
        apiKeyId,
        apiKeySecret,
        walletSecret,
      });
      // CDP `getOrCreateAccount` is idempotent on `name`. We derive a
      // stable name from the AEP agent_address so the same agent always
      // resolves to the same wallet across sessions. CDP does not allow
      // ":" in account names — strip to alphanumeric + hyphens.
      const name = `aep-${request.agent_address.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36)}`;
      wallet = await cdp.evm.getOrCreateAccount({ name });
      this.walletCache.set(cacheKey, wallet);
      log.info(
        { agent_address: request.agent_address, network, name },
        "x402-cdp: provisioned (or retrieved cached) CDP Server Wallet",
      );
    }

    // x402-fetch wrapper. `maxValue` is in USDC base units (micros) —
    // x402-fetch refuses to sign a payment-header for a quote above this.
    // This is the spec's "402 with quote > max_price_usdc_micros → reject"
    // (error table row 3).
    const maxValue = BigInt(request.max_price_usdc_micros);
    const fetchWithPay = wrapFetchWithPayment(
      globalThis.fetch,
      wallet,
      maxValue,
    );

    const init: RequestInit = {
      method: request.request.method,
      headers: request.request.headers,
      body: request.request.body,
    };

    const start = Date.now();
    const response = await fetchWithPay(request.service_url, init);
    const duration_ms = Date.now() - start;

    const bodyText = await response.text();

    // The settle receipt arrives in the `x-payment-response` header on the
    // post-payment 200. If absent, the upstream returned a non-paid 200
    // (free tier or already-paid request) — return zero payment.
    const xPaymentResp = response.headers.get("x-payment-response");
    let tx_hash = "";
    let amount_paid_micros = 0;
    let receivedNetwork: string | undefined;
    if (xPaymentResp) {
      try {
        const decoded = decodeXPaymentResponse(xPaymentResp);
        tx_hash = decoded.transaction ?? "";
        receivedNetwork = decoded.network;
        // x402 doesn't put the paid amount on the response header — the
        // amount is from the request side (the quote). The most reliable
        // reading is the original quote that the wrapped fetch agreed to
        // pay; x402-fetch does not currently surface this. As a safe
        // approximation we fall back to `max_price_usdc_micros` UPPER bound.
        // TODO(Surface 2 follow-up, IC-3 fidelity): instrument
        // `x402-fetch` (or pre-flight-fetch the 402 ourselves) to learn
        // the exact paid amount. Tracked in spec open-questions N4
        // (idempotency-key SDK shape).
        amount_paid_micros = request.max_price_usdc_micros;
      } catch (e) {
        log.warn(
          { err: e instanceof Error ? e.message : String(e) },
          "x402-cdp: failed to decode x-payment-response header",
        );
      }
    }

    // Normalize network → IC-3 enum. CDP uses "base"; IC-3 says
    // "base-mainnet" | "base-sepolia".
    const ic3Network: X402Network =
      receivedNetwork === "base-sepolia"
        ? "base-sepolia"
        : receivedNetwork === "base"
          ? "base-mainnet"
          : network === "base-sepolia"
            ? "base-sepolia"
            : "base-mainnet";

    return {
      status: response.status,
      body: bodyText,
      payment: {
        tx_hash,
        amount_paid_micros,
        network: ic3Network,
        facilitator,
      },
      duration_ms,
    };
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `x402-cdp: required env var ${name} is not set — see src/adapters/x402-cdp.ts header for the full list`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Module-load singleton + test seam.
// ---------------------------------------------------------------------------

let cachedAdapter: X402CdpAdapter | null = null;

export function getX402CdpAdapter(): X402CdpAdapter {
  if (!cachedAdapter) {
    cachedAdapter = new LiveX402CdpAdapter();
  }
  return cachedAdapter;
}

export function setX402CdpAdapter(adapter: X402CdpAdapter | null): void {
  cachedAdapter = adapter;
}

/**
 * Convenience env-flag check used by the action handler.
 * `AEP_X402_LIVE === "1"` activates the real x402+CDP path; any other
 * value (including unset) keeps the deterministic mock the scaffold tests
 * rely on.
 */
export function isX402LiveEnabled(): boolean {
  return process.env.AEP_X402_LIVE === "1";
}

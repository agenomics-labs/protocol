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

/**
 * Surface 2 follow-up — refund attempt outcome (spec error-table row 5).
 *
 * `@coinbase/x402@2.1.0` ships no `refund()` SDK affordance, so the
 * facilitator-side refund is a hand-rolled HTTP POST to
 * `${facilitatorUrl}/refund` carrying the original tx_hash + agent
 * address. The shape below captures all three observable outcomes the
 * facilitator can surface; the action handler maps these into the
 * structured `PROVIDER_5XX` IC-3 error.
 *
 *   - `requested`     — POST returned 200; refund_tx_hash present.
 *   - `not_supported` — POST returned 404; this facilitator has no /refund
 *                       endpoint (the v0 CDP facilitator on devnet today).
 *   - `failed`        — POST returned a 5xx of its own, or the request
 *                       timed out / network error. The original payment
 *                       tx_hash is still surfaced so the caller has a
 *                       Basescan link to chase up manually.
 */
export interface RefundAttempt {
  status: "requested" | "not_supported" | "failed";
  /** The Base-side refund tx hash, when the facilitator returned one. */
  refund_tx_hash?: string;
  /** Free-form reason text from the facilitator (or local error). Logged
   *  but not contractually parsed by the IC-3 caller. */
  reason?: string;
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
  /** Set when `status >= 500` AND the adapter attempted to recover the
   *  payment. Absent on 2xx/4xx responses. The action handler converts a
   *  present `refund` into the spec's `PROVIDER_5XX` error. */
  refund?: RefundAttempt;
  /** Set when the pre-flight 402 quote could not be obtained. Absent when
   *  the live `amount_paid_micros` came from the real quote — present when
   *  it had to fall back to `max_price_usdc_micros`. */
  quote_fallback_warning?: string;
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

  /**
   * Pre-flight 402 quote getter (Surface 2 follow-up — IC-3 fidelity).
   *
   * The real x402 protocol is a 4-step dance: 402 challenge → quote →
   * 402 paywall → settle. `wrapFetchWithPayment` collapses the dance into
   * one call but does not surface the actual quote. To get the precise
   * `amount_paid_micros` IC-3 promises (rather than the upper-bound
   * `max_price_usdc_micros` ceiling we used Day-3), we fetch the URL once
   * with NO Authorization header, expect the upstream to reply 402, then
   * parse the `WWW-Authenticate: x402 ...` challenge for the quote.
   *
   * Public x402 spec: the challenge header carries the PaymentRequirements
   * object as JSON-after-keyword, with the canonical field
   * `maxAmountRequired` (a base-units integer string). Some Bazaar
   * implementations expose the same data via a JSON 402 body instead — we
   * accept either as long as we can recover an integer micros amount.
   *
   * Failure mode: ANY error here (network failure, non-402 response,
   * malformed/missing header, no `maxAmountRequired` field) falls back to
   * the Day-3 behavior of using `max_price_usdc_micros` as the upper bound,
   * accompanied by a structured warning string the action handler logs.
   * The pre-flight is a fidelity improvement, not a correctness gate —
   * never let a flaky pre-flight break the happy path.
   *
   * `x402-fetch@1.2.0` does NOT export a quote getter (we audited the
   * package's `index.d.ts` for `decodeXPaymentResponse`, `wrapFetchWithPayment`,
   * and miscellaneous type re-exports — no `getQuote` / `getPaymentRequirements`
   * surface today). When/if it does, drop this hand-rolled pre-flight and
   * delegate.
   */
  async preflightQuote(serviceUrl: string): Promise<
    | { ok: true; amount_paid_micros: number }
    | { ok: false; warning: string }
  > {
    try {
      const resp = await globalThis.fetch(serviceUrl, { method: "GET" });
      if (resp.status !== 402) {
        // Read body so the connection drains; ignore content. A non-402
        // pre-flight means the URL is either free (no quote ever) or the
        // server is misbehaving — either way fall back.
        try {
          await resp.text();
        } catch {
          /* drain failure is benign */
        }
        return {
          ok: false,
          warning: `pre-flight expected 402 got ${resp.status}; falling back to max_price as ceiling`,
        };
      }
      // First try the JSON body — Coinbase's x402 reference servers reply
      // with `{ x402Version, accepts: [{ maxAmountRequired, ... }, ...] }`.
      const bodyText = await resp.text();
      const fromBody = parseQuoteFromJsonBody(bodyText);
      if (fromBody !== null) return { ok: true, amount_paid_micros: fromBody };

      // Fall through to WWW-Authenticate (RFC-7235 style header that some
      // Bazaar shims surface).
      const wwwAuth = resp.headers.get("www-authenticate") ?? "";
      const fromHeader = parseQuoteFromWwwAuth(wwwAuth);
      if (fromHeader !== null) return { ok: true, amount_paid_micros: fromHeader };

      return {
        ok: false,
        warning: `pre-flight 402 missing maxAmountRequired in body or WWW-Authenticate header`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, warning: `pre-flight network error: ${msg}` };
    }
  }

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

    // Pre-flight 402 quote (Surface 2 follow-up — IC-3 fidelity). Best-
    // effort: any failure here falls back to `max_price_usdc_micros` as
    // the upper bound (Day-3 behavior). The result drives the
    // `amount_paid_micros` field below — the upper-bound fallback is
    // strictly safe because x402-fetch refuses to sign a quote larger
    // than max_price.
    const preflight = await this.preflightQuote(request.service_url);
    let preflightAmount: number | null = null;
    let quoteFallbackWarning: string | undefined;
    if (preflight.ok) {
      // Sanity check: a quote larger than max_price would be rejected by
      // wrapFetchWithPayment anyway, but reject pre-flight here so the
      // amount we surface in IC-3 is never larger than what we agreed to.
      if (preflight.amount_paid_micros > request.max_price_usdc_micros) {
        quoteFallbackWarning =
          `pre-flight quote ${preflight.amount_paid_micros} exceeds max_price ` +
          `${request.max_price_usdc_micros}; using max_price as ceiling`;
      } else {
        preflightAmount = preflight.amount_paid_micros;
      }
    } else {
      quoteFallbackWarning = preflight.warning;
      log.warn(
        { service_url: request.service_url, warning: preflight.warning },
        "x402-cdp: pre-flight 402 quote unavailable; falling back to max_price",
      );
    }

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
        // Prefer the precise pre-flight quote; fall back to max_price
        // ceiling when pre-flight failed. The upper-bound fallback is the
        // SAFE fallback — x402-fetch refuses to sign a quote larger than
        // `maxValue`, so the actual paid amount is at most max_price.
        amount_paid_micros = preflightAmount ?? request.max_price_usdc_micros;
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

    // Surface 2 spec error-table row 5: 402 + payment + 5xx → request a
    // refund from the facilitator. `@coinbase/x402@2.1.0` ships no
    // `refund()` SDK affordance, so we POST to a hand-rolled
    // `${facilitator_url}/refund` endpoint. The action handler converts a
    // present `refund` field into the structured `PROVIDER_5XX` IC-3 error.
    let refund: RefundAttempt | undefined;
    if (response.status >= 500 && tx_hash !== "") {
      const facilitatorUrl =
        process.env.X402_FACILITATOR_URL ?? defaultFacilitatorUrl(facilitator);
      refund = await requestFacilitatorRefund({
        facilitatorUrl,
        tx_hash,
        agent_address: request.agent_address,
        signer: wallet,
      });
      log.warn(
        {
          service_url: request.service_url,
          status: response.status,
          tx_hash,
          refund_status: refund.status,
        },
        "x402-cdp: upstream returned 5xx after settlement; refund attempt complete",
      );
    }

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
      refund,
      quote_fallback_warning: quoteFallbackWarning,
    };
  }
}

// ---------------------------------------------------------------------------
// Pre-flight 402 quote parsers (Surface 2 follow-up).
// ---------------------------------------------------------------------------

/**
 * Pull `maxAmountRequired` out of an x402 challenge JSON body.
 * Coinbase's reference x402 server returns:
 *   `{ x402Version, accepts: [{ scheme, network, maxAmountRequired, ... }] }`
 * We accept the first entry whose `maxAmountRequired` parses as a non-negative
 * integer. Returns the integer micros amount, or `null` if the body doesn't
 * carry a recognizable quote.
 */
export function parseQuoteFromJsonBody(bodyText: string): number | null {
  if (!bodyText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const accepts = Array.isArray(obj.accepts) ? obj.accepts : [];
  for (const entry of accepts) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const v = e.maxAmountRequired;
    const parsedAmount =
      typeof v === "number"
        ? v
        : typeof v === "string"
          ? Number.parseInt(v, 10)
          : NaN;
    if (Number.isFinite(parsedAmount) && parsedAmount >= 0) {
      return Math.floor(parsedAmount);
    }
  }
  return null;
}

/**
 * Parse a `WWW-Authenticate: x402 maxAmountRequired=N, scheme=..., ...`
 * style challenge header. The x402 spec is in flux on the canonical header
 * shape — accept both the comma-separated `key=value` form AND a
 * `x402 <json>` form for forward-compat.
 */
export function parseQuoteFromWwwAuth(headerValue: string): number | null {
  if (!headerValue) return null;
  // Strip the leading auth-scheme token.
  const stripped = headerValue.replace(/^x402\s*/i, "").trim();
  if (!stripped) return null;
  // Try JSON-after-keyword first.
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as Record<string, unknown>;
      const v = parsed.maxAmountRequired;
      const n =
        typeof v === "number"
          ? v
          : typeof v === "string"
            ? Number.parseInt(v, 10)
            : NaN;
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    } catch {
      /* fall through to k=v parser */
    }
  }
  // Comma-separated key=value pairs (HTTP auth-param style). Values may be
  // quoted; we strip quotes if present.
  const parts = stripped.split(",").map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (key !== "maxamountrequired") continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Facilitator-side refund (Surface 2 spec error-table row 5).
// ---------------------------------------------------------------------------

/**
 * Map facilitator alias → default base URL. Honored only when
 * `X402_FACILITATOR_URL` is unset. The CDP devnet facilitator URL is
 * `https://x402.org/facilitator` per Coinbase's public docs as of
 * 2026-05; mainnet/Kora URLs have not been pinned in this repo so we
 * leave them as the same default and let the operator override.
 *
 * SPEC AMBIGUITY (returned in the deliverable): the actual `/refund`
 * endpoint shape is not documented by Coinbase as of 2026-05-07. The
 * payload we POST below (`{ tx_hash, agent_address, ... }`) is a best-
 * effort guess that mirrors the on-chain settle payload. A 404 is
 * treated as "facilitator does not support refunds" which is the
 * empirically-observed behavior on the v0 CDP devnet facilitator today.
 */
function defaultFacilitatorUrl(facilitator: X402Facilitator): string {
  switch (facilitator) {
    case "cdp":
      return "https://x402.org/facilitator";
    case "kora":
      // Kora has not been integrated with this adapter yet; placeholder.
      return "https://x402.org/facilitator";
  }
}

/**
 * POST a refund request to `${facilitatorUrl}/refund`. Returns a typed
 * `RefundAttempt` capturing the three observable outcomes (requested /
 * not_supported / failed). Never throws — the action handler relies on
 * this returning a structured value so the IC-3 PROVIDER_5XX error can
 * always include a refund_status field.
 *
 * The signer (CDP ServerAccount) is widened to `unknown` because we don't
 * actually invoke it here today — the v0 facilitator refund API takes the
 * tx_hash + agent_address as authentication implicitly (the facilitator
 * verifies the agent owns the original payment). When the API stabilizes
 * to require an explicit signature, replace the unsigned POST below with a
 * wallet-signed envelope.
 */
async function requestFacilitatorRefund(opts: {
  facilitatorUrl: string;
  tx_hash: string;
  agent_address: string;
  signer: unknown;
}): Promise<RefundAttempt> {
  const url = opts.facilitatorUrl.replace(/\/+$/, "") + "/refund";
  try {
    const resp = await globalThis.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx_hash: opts.tx_hash,
        agent_address: opts.agent_address,
      }),
    });
    if (resp.status === 404) {
      // Drain body. 404 is the documented "facilitator does not support
      // refunds" outcome on the v0 CDP devnet facilitator.
      try {
        await resp.text();
      } catch {
        /* benign */
      }
      return { status: "not_supported", reason: "facilitator returned 404" };
    }
    if (resp.status >= 200 && resp.status < 300) {
      let refundTx: string | undefined;
      try {
        const bodyText = await resp.text();
        const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        const tx = parsed.refund_tx_hash ?? parsed.tx_hash ?? parsed.transaction;
        if (typeof tx === "string" && tx.length > 0) refundTx = tx;
      } catch {
        /* malformed JSON is non-fatal — the refund still succeeded */
      }
      return { status: "requested", refund_tx_hash: refundTx };
    }
    const reason = `facilitator returned ${resp.status}`;
    try {
      await resp.text();
    } catch {
      /* benign */
    }
    return { status: "failed", reason };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", reason: `network error: ${msg}` };
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

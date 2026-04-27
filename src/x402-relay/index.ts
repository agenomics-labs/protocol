/** AEP x402 HTTP Payment Relay - verifies on-chain payments, issues JWT access tokens */
import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import * as crypto from "node:crypto";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { logger } from "./logger.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.RELAY_PORT || "3200", 10);
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW) {
  // Direct stderr write (not logger) because the message itself does not
  // carry a value — only the absence of one — so the redaction policy
  // around JWT_SECRET would fire incorrectly via JSON.
  process.stderr.write(
    "FATAL: JWT_SECRET environment variable must be set\n",
  );
  process.exit(1);
}
// The guard above narrows JWT_SECRET_RAW to `string` at runtime but closures
// below still see the original union. Bind to a `string`-typed local so
// `jwt.sign`/`jwt.verify` overloads resolve without `!` non-null assertions.
const JWT_SECRET: string = JWT_SECRET_RAW;
// AUD-027: enforce a minimum-entropy floor on the HS256 signing key. A short
// secret (e.g. 5 chars ≈ 25 bits of entropy) produces tokens that pass
// `jwt.verify` but are trivially brute-forceable. Mirror the MCP server's
// bearer-token policy (`MIN_TOKEN_BYTES=16` in `mcp-server/src/transport/
// auth-gate.ts`) with a stricter floor for symmetric signing keys: 32 bytes
// matches `openssl rand -hex 32` and the HS256 key-size guidance in RFC 7518.
const MIN_JWT_SECRET_BYTES = 32;
if (Buffer.byteLength(JWT_SECRET, "utf8") < MIN_JWT_SECRET_BYTES) {
  throw new Error(
    `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes; got ${Buffer.byteLength(JWT_SECRET, "utf8")}.`,
  );
}
const JWT_ALGORITHM: jwt.Algorithm = "HS256";
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || "3600", 10);
const PAYMENT_RECIPIENT = process.env.PAYMENT_RECIPIENT || "";
const REQUIRED_AMOUNT_SOL = parseFloat(process.env.REQUIRED_AMOUNT_SOL || "0.01");

// ---------------------------------------------------------------------------
// Admin / drain surface (POST /admin/drain, POST /admin/undrain,
// GET /admin/status). See `docs/INCIDENT_RESPONSE.md` §4.4 / §4.5 for the
// operator runbook context — gap #1 from the C2 incident playbook
// (commit bbeb240): operators previously had no in-app way to stop
// accepting new /pay requests during incident response and had to fall
// back to coarse network-edge blocking that was asymmetric across
// instances. Drain flips an internal flag so subsequent /pay calls
// short-circuit with 503 BEFORE the saturation guard (AUD-209) and
// BEFORE the RPC verify path. In-flight /pay requests already past the
// gate run to completion — drain is graceful, not a circuit breaker.
//
// Auth model mirrors AUD-027:
//   - `RELAY_ADMIN_TOKEN` MUST be set if drain/undrain are to be usable.
//   - When set, the same 32-byte floor as JWT_SECRET applies (RFC 7518
//     HS256 guidance; see AUD-027 comment above). The token is a static
//     bearer secret protecting a privileged write surface, so the same
//     entropy floor applies.
//   - When UNSET, the relay still serves /pay normally — but
//     POST /admin/drain and POST /admin/undrain return 503 with body
//     `{ error: "ADMIN_TOKEN_NOT_CONFIGURED", ... }`. This is a
//     deliberate divergence from JWT_SECRET's fatal-at-load behavior:
//     drain is an opt-in operational capability, not a critical-path
//     dependency. Failing closed (admin endpoints unreachable) is the
//     security-correct default — silently leaving them unauthenticated
//     would let any caller flip the relay into 503-everything mode.
//   - `GET /admin/status` is always reachable (no auth) so dashboards
//     and healthchecks can read the drain flag. When the admin token is
//     unset, the response includes `adminTokenConfigured: false` so
//     operators see the misconfiguration before they need to drain.
// ---------------------------------------------------------------------------
const RELAY_ADMIN_TOKEN_RAW = process.env.RELAY_ADMIN_TOKEN;
const MIN_ADMIN_TOKEN_BYTES = 32;
let RELAY_ADMIN_TOKEN: string | null = null;
if (RELAY_ADMIN_TOKEN_RAW !== undefined && RELAY_ADMIN_TOKEN_RAW !== "") {
  // Same length-floor + throw pattern as JWT_SECRET (AUD-027). Misconfig
  // surfaces at module load, not on the first /admin/drain call mid-incident.
  if (Buffer.byteLength(RELAY_ADMIN_TOKEN_RAW, "utf8") < MIN_ADMIN_TOKEN_BYTES) {
    throw new Error(
      `RELAY_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_BYTES} bytes; got ${Buffer.byteLength(RELAY_ADMIN_TOKEN_RAW, "utf8")}.`,
    );
  }
  RELAY_ADMIN_TOKEN = RELAY_ADMIN_TOKEN_RAW;
}

// Module state. Mutated only by POST /admin/drain and POST /admin/undrain.
// Single-instance scope — same horizontal-scale caveat as
// `redeemedSignatures` (see AUD-208 / ADR-126 comments below). Operators
// running multiple relay instances behind a load balancer must drain
// each instance individually (or front them with a coordinated drain
// orchestrator). This matches the existing single-instance scope of
// the AUD-208/AUD-209 dedup state and is deliberate: cross-instance
// coordination is the ADR-126 horizontal-scale workstream.
let draining = false;

// S-offchain-01: Express's `req.ip` respects `X-Forwarded-For` only when
// `trust proxy` is configured. With the default (off) and a real L7 proxy
// in front, every request resolves to the proxy's IP — the rate limiter
// lumps all clients into one bucket. With `trust proxy` set too liberally
// (e.g. `true`), any client can spoof `X-Forwarded-For` and rotate into
// arbitrary buckets, defeating the limiter. Deployments MUST declare the
// exact hop topology via `TRUST_PROXY`. The safe default (`"loopback"`)
// only trusts 127.0.0.1/::1 so local development works and non-proxied
// deployments fall back to the real peer address.
//
// Accepted values mirror Express's docs:
//   - "loopback" / "linklocal" / "uniquelocal" — named subnets
//   - an integer (e.g. "1") — number of proxy hops to strip
//   - a comma-separated subnet list (e.g. "10.0.0.0/8,192.168.0.0/16")
//   - "true" — trust every hop (DANGEROUS; only for tests)
const TRUST_PROXY = process.env.TRUST_PROXY || "loopback";
// Finding #16: Use "finalized" — the highest Solana commitment level — so
// the relay never grants access on a transaction that could still be dropped
// by a fork. "confirmed" (the old default) is ~2/3 stake and can reorg.
const connection = new Connection(RPC_URL, "finalized");

// Finding #16: Track each redeemed signature together with the timestamp at
// which it becomes safe to evict (the JWT TTL window + a small grace buffer).
// The old code replaced this with a naive `Set<string>` that was *cleared*
// entirely when it hit 10k entries — an attacker who flooded 10k unique
// signatures could unlock replay of every previously-redeemed signature
// that was still within its JWT TTL. Bounded TTL eviction fixes the flood
// escape hatch; no entry is removed until it is genuinely expired.
const redeemedSignatures = new Map<string, number>();
const SIGNATURE_TTL_MS = (TOKEN_EXPIRY_SECONDS + 300) * 1000;
const MAX_REDEEMED_SIGNATURES = 100_000;

// AUD-208: TOCTOU race fix. The previous get-then-set pattern allowed two
// concurrent POST /pay calls with the same txSignature to both pass the
// existence check, both perform a 200-1000ms `verifyPaymentOnChain` RPC,
// and both receive a fresh JWT for the same on-chain payment. Two JWTs
// for one payment is a privilege-escalation bug (the relay's whole job
// is to enforce 1 payment = 1 token).
//
// Fix: an in-flight verify cache keyed by txSignature. Concurrent callers
// for the same signature await the same Promise — only the first verifier
// runs the RPC, saving cost and collapsing the race window. After verify
// resolves we re-check `redeemedSignatures` (a racing redeemer that
// committed first wins; everyone else gets 409). Each redemption commit
// is then atomic with respect to the JS event loop, since `Map.set` is
// synchronous and Node is single-threaded per process.
//
// Scope: SINGLE-INSTANCE ONLY. Two relay processes behind a load balancer
// can still issue duplicate JWTs because they don't share `inFlightVerify`
// or `redeemedSignatures`. ADR-126 / AUD-028 tracks the horizontal-scale
// fix (replace these in-memory maps with a Redis SET-IF-NOT-EXISTS or
// Postgres unique-constraint-backed reservation table).
const inFlightVerify = new Map<string, Promise<PaymentVerification>>();

function pruneRedeemedSignatures(): void {
  const now = Date.now();
  for (const [sig, expiresAt] of redeemedSignatures) {
    if (now >= expiresAt) {
      redeemedSignatures.delete(sig);
    }
  }
  // AUD-209 (cycle-2): the previous safety-cap path here drained the
  // OLDEST `redeemedSignatures.size - MAX_REDEEMED_SIGNATURES` entries
  // in insertion order — a fail-OPEN mode that, under sustained
  // ~30 sigs/sec saturation, would silently drop unexpired signatures
  // and re-open the replay window for them. The replacement is a
  // fail-CLOSED gate at the /pay commit step (see
  // `processPaymentRequest` and the `kind: "saturated"` PayResult
  // variant): when the map is at cap and the incoming signature is not
  // already present, the relay returns 503 Service Unavailable. The
  // operator alert is then "the relay is at saturation; investigate
  // the burst" rather than "an unexpired signature was silently
  // evicted, allowing replay."
}
// `.unref()` so the timer does not by itself keep the event loop alive.
// In production the HTTP listener keeps the process up; this matters only
// for in-process tests (AUD-209) that import the module, exercise it, and
// then `server.close()` — without `unref` the orphaned interval would hang
// the test runner past the last subtest.
setInterval(pruneRedeemedSignatures, SIGNATURE_TTL_MS).unref();

interface PaymentVerification {
  valid: boolean;
  sender: string;
  recipient: string;
  amountSol: number;
  slot: number;
  error?: string;
}

async function verifyPaymentOnChain(
  txSignature: string,
  expectedRecipient: string,
  minAmountSol: number
): Promise<PaymentVerification> {
  try {
    // Finding #16: "finalized" guarantees the tx is past the fork-choice
    // window. Accepting "confirmed" here would let a reorged tx issue a JWT.
    const tx = await connection.getTransaction(txSignature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { valid: false, sender: "", recipient: "", amountSol: 0, slot: 0, error: "Transaction not found" };
    }

    if (tx.meta?.err) {
      return { valid: false, sender: "", recipient: "", amountSol: 0, slot: 0, error: "Transaction failed on-chain" };
    }

    // Check pre/post balances for a SOL transfer to the expected recipient
    const accountKeys = tx.transaction.message.getAccountKeys();
    const recipientIndex = accountKeys.staticAccountKeys.findIndex(
      (key) => key.toBase58() === expectedRecipient
    );

    if (recipientIndex === -1) {
      return { valid: false, sender: "", recipient: expectedRecipient, amountSol: 0, slot: tx.slot, error: "Recipient not found in transaction" };
    }

    const preBalance = tx.meta?.preBalances[recipientIndex] || 0;
    const postBalance = tx.meta?.postBalances[recipientIndex] || 0;
    const transferredLamports = postBalance - preBalance;
    const transferredSol = transferredLamports / LAMPORTS_PER_SOL;

    if (transferredSol < minAmountSol) {
      return {
        valid: false,
        sender: accountKeys.staticAccountKeys[0].toBase58(),
        recipient: expectedRecipient,
        amountSol: transferredSol,
        slot: tx.slot,
        error: `Insufficient payment: ${transferredSol} SOL < ${minAmountSol} SOL`,
      };
    }

    return {
      valid: true,
      sender: accountKeys.staticAccountKeys[0].toBase58(),
      recipient: expectedRecipient,
      amountSol: transferredSol,
      slot: tx.slot,
    };
  } catch (err) {
    return { valid: false, sender: "", recipient: "", amountSol: 0, slot: 0, error: `Verification error: ${err}` };
  }
}

interface TokenPayload {
  sender: string;
  txSignature: string;
  amountSol: number;
  iat: number;
  exp: number;
}

function issueAccessToken(sender: string, txSignature: string, amountSol: number): string {
  return jwt.sign(
    { sender, txSignature, amountSol } as Omit<TokenPayload, "iat" | "exp">,
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY_SECONDS, algorithm: JWT_ALGORITHM }
  );
}

function verifyAccessToken(token: string): TokenPayload | null {
  try {
    // S-offchain-03: Pin verification to HS256. Without an explicit
    // `algorithms` list, `jwt.verify` accepts whatever `alg` the token's
    // header advertises — the classic algorithm-confusion CVE class
    // (`alg: none`, HS/RS confusion when the key could be interpreted as
    // either secret or public key material).
    return jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    }) as unknown as TokenPayload;
  } catch {
    return null;
  }
}

function requirePayment(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(402).json({
      error: "Payment Required",
      payment: {
        recipient: PAYMENT_RECIPIENT,
        amountSol: REQUIRED_AMOUNT_SOL,
        endpoint: "/pay",
        proofFormat: "solana_tx_signature",
        tokenExpiry: TOKEN_EXPIRY_SECONDS,
      },
      headers: {
        "X-Payment-Endpoint": "/pay",
        "X-Price": `${REQUIRED_AMOUNT_SOL} SOL`,
        "X-Payment-Proof": "tx_signature",
      },
    });
    return;
  }

  const token = authHeader.substring(7);
  const payload = verifyAccessToken(token);

  if (!payload) {
    res.status(401).json({ error: "Invalid or expired access token. Make a new payment." });
    return;
  }

  (req as Request & { payment?: TokenPayload }).payment = payload;
  next();
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 10;
// S-offchain-02: Cap the rate-limit map. Without a cap, a scanner rotating
// source IPs grows this map unbounded. 100k distinct IPs * ~80B overhead
// per entry ≈ 8 MB, which is a comfortable ceiling for a single-purpose
// service. If the cap is hit the oldest entry (insertion order) is
// evicted — this is safe because each entry already expires after
// RATE_LIMIT_WINDOW_MS, so eviction under pressure just means an
// attacker's earliest bucket is forgotten slightly sooner than its
// natural expiry. The cap is a backstop; periodic pruning below is the
// primary mechanism.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_ENTRIES = 100_000;

function pruneRateLimitMap(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
  while (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    const oldest = rateLimitMap.keys().next().value;
    if (oldest === undefined) break;
    rateLimitMap.delete(oldest);
  }
}
setInterval(pruneRateLimitMap, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  // S-offchain-01: `req.ip` is correct only when `trust proxy` is set
  // (see TRUST_PROXY above). With the default `loopback` setting Express
  // returns the peer's real address for non-local connections and
  // respects `X-Forwarded-For` only when the peer is 127.0.0.1/::1.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  entry.count++;
  next();
}

/**
 * Admin auth middleware. See the admin-surface header comment near the
 * top of the file for full rationale.
 *
 * Three outcomes:
 *   - RELAY_ADMIN_TOKEN unset           -> 503 ADMIN_TOKEN_NOT_CONFIGURED
 *   - Bearer token missing or mismatch  -> 401 (uniform error to avoid
 *                                          leaking whether the route
 *                                          exists vs. token is wrong)
 *   - Bearer token matches              -> next()
 *
 * Constant-time compare via `crypto.timingSafeEqual` to deny a timing
 * oracle on the secret. Length-mismatch is checked before the compare
 * (timingSafeEqual throws on unequal-length buffers).
 */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (RELAY_ADMIN_TOKEN === null) {
    res.status(503).json({
      error: "ADMIN_TOKEN_NOT_CONFIGURED",
      details:
        "RELAY_ADMIN_TOKEN env var is unset; admin endpoints are disabled. " +
        "Set RELAY_ADMIN_TOKEN (>= 32 bytes) to enable drain/undrain.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const presented = authHeader.substring(7);

  // Length check before timingSafeEqual: the latter throws on unequal
  // length, but the throw itself is fast — the timing leak is in the
  // *comparison*. Returning early on length mismatch is fine because
  // the secret length is fixed and known to the operator (the env var
  // they configured); it is not secret-derived.
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(RELAY_ADMIN_TOKEN, "utf8");
  if (presentedBuf.length !== expectedBuf.length) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!crypto.timingSafeEqual(presentedBuf, expectedBuf)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const app = express();
// S-offchain-01: Must be set BEFORE routes/middleware so `req.ip` resolves
// consistently. Convert the env var through `parseTrustProxy` so integer
// hop counts and boolean literals survive the string→Express conversion.
app.set("trust proxy", parseTrustProxy(TRUST_PROXY));
app.use(express.json());
app.use("/pay", rateLimit);

function parseTrustProxy(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const asInt = Number(trimmed);
  if (Number.isInteger(asInt) && asInt >= 0) return asInt;
  // Named subnets ("loopback", "linklocal", "uniquelocal") or a CIDR list
  // are passed through verbatim; Express parses them.
  return trimmed;
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    relay: "x402",
    recipient: PAYMENT_RECIPIENT,
    requiredAmountSol: REQUIRED_AMOUNT_SOL,
    tokenExpirySeconds: TOKEN_EXPIRY_SECONDS,
  });
});

/**
 * AUD-208: extracted /pay handler core. Takes an injectable verifier so
 * tests can drive the concurrency invariants (single RPC per signature,
 * single JWT per signature) without standing up a full Express server or
 * a real Solana validator. Production code passes the bound
 * `verifyPaymentOnChain`; the unit test passes a 100ms-delayed mock.
 *
 * Returns a discriminated union the route handler maps onto HTTP status:
 *   - { kind: "ok",       ... } -> 200
 *   - { kind: "redeemed" }      -> 409
 *   - { kind: "invalid",  ... } -> 402
 *   - { kind: "bad-input" }     -> 400 (handled by caller, not here)
 *   - { kind: "no-config" }     -> 500
 *   - { kind: "saturated" }     -> 503 (AUD-209)
 */
type PayResult =
  | {
      kind: "ok";
      accessToken: string;
      expiresIn: number;
      sender: string;
      amountSol: number;
      slot: number;
    }
  | { kind: "redeemed" }
  | { kind: "invalid"; details?: string; verification: PaymentVerification }
  | { kind: "no-config" }
  | { kind: "saturated" };

async function processPaymentRequest(
  txSignature: string,
  verifier: (sig: string) => Promise<PaymentVerification>,
  recipient: string,
): Promise<PayResult> {
  // Fast-reject: prior commit short-circuits before paying for an RPC
  // roundtrip. The check is repeated post-verify below to close the
  // TOCTOU window.
  const existingExpiry = redeemedSignatures.get(txSignature);
  if (existingExpiry !== undefined && Date.now() < existingExpiry) {
    return { kind: "redeemed" };
  }

  if (!recipient) {
    return { kind: "no-config" };
  }

  // In-flight verify dedup. If another request for this same txSignature
  // is already mid-RPC, await its Promise instead of firing a second
  // `getTransaction` call. Verification is a pure function of
  // (signature, recipient, minAmount); recipient and minAmount are
  // process-wide constants, so sharing the result across concurrent
  // callers with the same signature is safe. The first caller to reach
  // this branch installs the Promise; later callers find it via `.get`.
  let verifyPromise = inFlightVerify.get(txSignature);
  if (!verifyPromise) {
    verifyPromise = verifier(txSignature);
    inFlightVerify.set(txSignature, verifyPromise);
    // Drop the cache entry once the RPC settles, regardless of outcome.
    // `.finally` runs after every awaiter has resolved their `.then`,
    // so no awaiter races a second attempt against a half-deleted entry.
    verifyPromise.finally(() => {
      inFlightVerify.delete(txSignature);
    });
  }

  const verification = await verifyPromise;

  if (!verification.valid) {
    return { kind: "invalid", details: verification.error, verification };
  }

  // Race-window collapse: re-check redeemedSignatures *after* the RPC
  // settles. Without this, two concurrent callers that both passed the
  // pre-verify check (no prior commit) and shared a single in-flight
  // Promise would both reach the commit step. The map is mutated on a
  // single thread (Node event loop) so this `has` + `set` pair runs
  // without interleaving — the first awaiter to wake commits and the
  // rest get "redeemed". `Map.has` and `Map.set` are synchronous; no
  // `await` may appear between them, otherwise the atomicity guarantee
  // is lost.
  if (redeemedSignatures.has(txSignature)) {
    return { kind: "redeemed" };
  }
  // AUD-209 (cycle-2): fail-closed saturation guard. The previous
  // implementation evicted oldest entries to make room — a fail-open
  // mode that re-enabled replay for the dropped signatures. Now: if
  // the map is at MAX_REDEEMED_SIGNATURES and this signature is not
  // already present (we just checked above), refuse the redemption.
  // The caller retries; operators see 503s and investigate the burst
  // rather than silently absorbing it as replay surface.
  if (redeemedSignatures.size >= MAX_REDEEMED_SIGNATURES) {
    return { kind: "saturated" };
  }
  redeemedSignatures.set(txSignature, Date.now() + SIGNATURE_TTL_MS);

  const accessToken = issueAccessToken(
    verification.sender,
    txSignature,
    verification.amountSol,
  );

  return {
    kind: "ok",
    accessToken,
    expiresIn: TOKEN_EXPIRY_SECONDS,
    sender: verification.sender,
    amountSol: verification.amountSol,
    slot: verification.slot,
  };
}

app.post("/pay", async (req: Request, res: Response) => {
  // Drain gate (incident-response §4.4 / §4.5). Fires BEFORE input
  // validation, BEFORE `processPaymentRequest`, and therefore BEFORE
  // both the saturation check (AUD-209) and the on-chain RPC verify.
  // The 503 body intentionally mirrors the saturation 503 shape (a
  // single `error` field of `string`) so SDK clients with retry-on-503
  // logic do not need a special case for drain. In-flight requests
  // already past this line continue to completion — drain is graceful.
  if (draining) {
    res.status(503).json({
      error: "Relay is draining; retry against another instance",
    });
    return;
  }

  const { txSignature } = req.body;

  if (!txSignature || typeof txSignature !== "string") {
    res.status(400).json({ error: "Missing txSignature in request body" });
    return;
  }

  const result = await processPaymentRequest(
    txSignature,
    (sig) => verifyPaymentOnChain(sig, PAYMENT_RECIPIENT, REQUIRED_AMOUNT_SOL),
    PAYMENT_RECIPIENT,
  );

  switch (result.kind) {
    case "redeemed":
      res.status(409).json({ error: "Transaction signature already redeemed" });
      return;
    case "no-config":
      res
        .status(500)
        .json({ error: "Relay not configured: PAYMENT_RECIPIENT not set" });
      return;
    case "invalid":
      res.status(402).json({
        error: "Payment verification failed",
        details: result.details,
        verification: result.verification,
      });
      return;
    case "saturated":
      // AUD-209 (cycle-2): redeemed-signature map at capacity. Returning
      // 503 here is the fail-closed response; operators should treat
      // this as a saturation alarm and either scale horizontally
      // (ADR-126) or investigate a burst attacker.
      res.status(503).json({
        error: "Relay redeemed-signature capacity exhausted; retry shortly",
      });
      return;
    case "ok":
      res.json({
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        sender: result.sender,
        amountSol: result.amountSol,
        slot: result.slot,
      });
      return;
  }
});

app.get("/verify", (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ valid: false, error: "No Bearer token provided" });
    return;
  }

  const payload = verifyAccessToken(authHeader.substring(7));
  if (!payload) {
    res.status(401).json({ valid: false, error: "Token invalid or expired" });
    return;
  }

  const remainingSeconds = payload.exp - Math.floor(Date.now() / 1000);
  res.json({ valid: true, sender: payload.sender, remainingSeconds });
});

app.get("/protected", requirePayment, (req: Request, res: Response) => {
  const payment = (req as Request & { payment?: TokenPayload }).payment!;
  res.json({
    message: "Access granted. This is a protected resource.",
    paidBy: payment.sender,
    paidAmount: payment.amountSol,
    txSignature: payment.txSignature,
  });
});

// ---------------------------------------------------------------------------
// Admin endpoints — see the admin-surface header comment near the top of
// the file (and `docs/INCIDENT_RESPONSE.md` §4.4 / §4.5) for the operator
// runbook context. Surface is intentionally minimal: drain, undrain,
// status. Other admin facilities (key rotation, state dump, etc.) are
// SEPARATE features and must not be added here.
// ---------------------------------------------------------------------------

app.post("/admin/drain", requireAdmin, (_req: Request, res: Response) => {
  const wasAlready = draining;
  draining = true;
  // Structured log so the audit trail captures who drained when. The
  // bearer token itself is NOT logged (it is the secret); we log only
  // the transition. Operators correlate via the request log + their
  // out-of-band record of which on-call ran the drain.
  logger.warn(
    { event: "admin_drain", was_already_draining: wasAlready },
    "Relay drain ENABLED — new /pay requests will be 503'd",
  );
  res.json({ draining: true, wasAlreadyDraining: wasAlready });
});

app.post("/admin/undrain", requireAdmin, (_req: Request, res: Response) => {
  const wasDraining = draining;
  draining = false;
  logger.warn(
    { event: "admin_undrain", was_draining: wasDraining },
    "Relay drain DISABLED — /pay requests will be served normally",
  );
  res.json({ draining: false, wasDraining });
});

app.get("/admin/status", (_req: Request, res: Response) => {
  // Read-only. No auth required so dashboards and external healthchecks
  // can poll without provisioning the admin token. The admin-token
  // configured flag is exposed so operators see the misconfiguration
  // (admin endpoints unusable) BEFORE they need to drain mid-incident.
  res.json({
    draining,
    adminTokenConfigured: RELAY_ADMIN_TOKEN !== null,
  });
});

// Captured so tests that import this module in-process can `.close()` the
// listener in their teardown — otherwise the open server keeps the Node
// event loop alive and the test runner hangs at exit. Production callers
// continue to receive the same `app.listen` semantics; the only behavioral
// change is that the returned `http.Server` is now reachable.
const server = app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      recipient: PAYMENT_RECIPIENT || "(not configured)",
      required_amount_sol: REQUIRED_AMOUNT_SOL,
      token_expiry_seconds: TOKEN_EXPIRY_SECONDS,
      endpoints: [
        "POST /pay",
        "GET /verify",
        "GET /protected",
        "POST /admin/drain",
        "POST /admin/undrain",
        "GET /admin/status",
      ],
      admin_token_configured: RELAY_ADMIN_TOKEN !== null,
    },
    "AEP x402 payment relay listening",
  );
});

// AUD-208 test hook: reset the in-memory redemption + in-flight state so a
// test suite can run multiple `processPaymentRequest` scenarios in
// isolation without polluting global module state. Not part of the public
// runtime contract — production callers must never invoke this.
function __resetRedemptionStateForTests(): void {
  redeemedSignatures.clear();
  inFlightVerify.clear();
}

// AUD-209 test hook: pre-populate the redemption map with `count` synthetic
// entries so the saturation guard (`redeemedSignatures.size >=
// MAX_REDEEMED_SIGNATURES`) can be exercised without driving 100k real
// `processPaymentRequest` calls through the verifier path. Each entry's
// expiry is set far in the future so the pruner does not race the test by
// evicting them as TTL-expired. Not part of the public runtime contract —
// production callers must never invoke this.
function __fillRedemptionStateForTests(count: number): void {
  const farFuture = Date.now() + SIGNATURE_TTL_MS * 10;
  for (let i = 0; i < count; i++) {
    redeemedSignatures.set(`__test-fill-${i}`, farFuture);
  }
}

// Drain test hook: reset the drain flag so test subtests are isolated.
// Not part of the public runtime contract — production callers must
// never invoke this. Operators wanting to undrain go through
// POST /admin/undrain (which is the auditable code path).
function __resetDrainStateForTests(): void {
  draining = false;
}

export {
  app,
  server,
  requirePayment,
  requireAdmin,
  verifyPaymentOnChain,
  verifyAccessToken,
  processPaymentRequest,
  __resetRedemptionStateForTests,
  __fillRedemptionStateForTests,
  __resetDrainStateForTests,
};

/** AEAP x402 HTTP Payment Relay - verifies on-chain payments, issues JWT access tokens */
import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.RELAY_PORT || "3200", 10);
const JWT_SECRET_RAW = process.env.JWT_SECRET;
if (!JWT_SECRET_RAW) {
  console.error("FATAL: JWT_SECRET environment variable must be set");
  process.exit(1);
}
// The guard above narrows JWT_SECRET_RAW to `string` at runtime but closures
// below still see the original union. Bind to a `string`-typed local so
// `jwt.sign`/`jwt.verify` overloads resolve without `!` non-null assertions.
const JWT_SECRET: string = JWT_SECRET_RAW;
const JWT_ALGORITHM: jwt.Algorithm = "HS256";
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || "3600", 10);
const PAYMENT_RECIPIENT = process.env.PAYMENT_RECIPIENT || "";
const REQUIRED_AMOUNT_SOL = parseFloat(process.env.REQUIRED_AMOUNT_SOL || "0.01");

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

function pruneRedeemedSignatures(): void {
  const now = Date.now();
  for (const [sig, expiresAt] of redeemedSignatures) {
    if (now >= expiresAt) {
      redeemedSignatures.delete(sig);
    }
  }
  // Safety cap: if TTL eviction hasn't kept pace (which would require
  // ~100k unique signatures per TTL window — i.e. ~30 signatures/second
  // for the default 3600s token), drop the oldest entries in insertion
  // order. Map iteration order IS insertion order. Critically, this does
  // NOT wipe the set — at most it evicts entries that have been held
  // far longer than normal usage requires.
  while (redeemedSignatures.size > MAX_REDEEMED_SIGNATURES) {
    const oldest = redeemedSignatures.keys().next().value;
    if (oldest === undefined) break;
    redeemedSignatures.delete(oldest);
  }
}
setInterval(pruneRedeemedSignatures, SIGNATURE_TTL_MS);

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
setInterval(pruneRateLimitMap, RATE_LIMIT_WINDOW_MS);

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

app.post("/pay", async (req: Request, res: Response) => {
  const { txSignature } = req.body;

  if (!txSignature || typeof txSignature !== "string") {
    res.status(400).json({ error: "Missing txSignature in request body" });
    return;
  }

  const existingExpiry = redeemedSignatures.get(txSignature);
  if (existingExpiry !== undefined && Date.now() < existingExpiry) {
    res.status(409).json({ error: "Transaction signature already redeemed" });
    return;
  }

  if (!PAYMENT_RECIPIENT) {
    res.status(500).json({ error: "Relay not configured: PAYMENT_RECIPIENT not set" });
    return;
  }

  const verification = await verifyPaymentOnChain(
    txSignature,
    PAYMENT_RECIPIENT,
    REQUIRED_AMOUNT_SOL
  );

  if (!verification.valid) {
    res.status(402).json({
      error: "Payment verification failed",
      details: verification.error,
      verification,
    });
    return;
  }

  redeemedSignatures.set(txSignature, Date.now() + SIGNATURE_TTL_MS);

  const accessToken = issueAccessToken(
    verification.sender,
    txSignature,
    verification.amountSol
  );

  res.json({
    accessToken,
    expiresIn: TOKEN_EXPIRY_SECONDS,
    sender: verification.sender,
    amountSol: verification.amountSol,
    slot: verification.slot,
  });
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

app.listen(PORT, () => {
  console.log(`AEAP x402 Payment Relay listening on http://localhost:${PORT}`);
  console.log(`Recipient: ${PAYMENT_RECIPIENT || "(not configured)"}`);
  console.log(`Required: ${REQUIRED_AMOUNT_SOL} SOL`);
  console.log(`Token expiry: ${TOKEN_EXPIRY_SECONDS}s`);
  console.log("Endpoints: POST /pay, GET /verify, GET /protected");
});

export { app, requirePayment, verifyPaymentOnChain, verifyAccessToken };

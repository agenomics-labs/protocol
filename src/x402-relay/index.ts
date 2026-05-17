/** AEP x402 HTTP Payment Relay - verifies on-chain payments, issues JWT access tokens */
import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import * as crypto from "node:crypto";
import {
  createSolanaRpc,
  getBase58Encoder,
  type Signature,
} from "@solana/kit";
import { logger } from "./logger.js";
import {
  createRedisDedup,
  type RedisDedup,
} from "./redis-dedup.js";

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
// Finding #16: Use "finalized" commitment per-call (in @solana/kit v2, commitment
// is per-request rather than at connection creation time). The "finalized"
// level guarantees the tx is past the fork-choice window; "confirmed" (~2/3
// stake) can reorg and would allow a reorged tx to issue a JWT.
const rpc = createSolanaRpc(RPC_URL);

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

// ---------------------------------------------------------------------------
// ADR-126 Phase 1 — Redis-backed cross-instance dedup (scaffolding).
//
// PHASE 1 SCOPE (this PR):
//   - When `RELAY_REDIS_URL` is UNSET (default), `createRedisDedup`
//     returns a no-op `DisabledRedisDedup`. Behavior is BYTE-IDENTICAL
//     to the pre-ADR-126 in-memory-only path: the no-op `tryRedeem`
//     returns `{ kind: "ok" }`, the call falls through to the existing
//     in-memory `redeemedSignatures` check, and `redeemedSignatures` /
//     `inFlightVerify` remain authoritative. Existing operators see no
//     change.
//   - When `RELAY_REDIS_URL` IS SET, the live `LiveRedisDedup` client
//     is instantiated and Redis becomes the AUTHORITATIVE cross-instance
//     dedup store. The in-memory map is dual-written (still consulted
//     first for AUD-208 in-flight-verify collapsing semantics). The
//     in-memory map is now a local cache; Redis is truth.
//
// PHASE 2 (separate future PR — DO NOT do here):
//   - Remove the in-memory `redeemedSignatures` Map.
//   - Remove the AUD-208 `inFlightVerify` cache (or keep as a single-
//     instance perf optimization — TBD when Phase 2 lands).
//   - Remove `__fillRedemptionStateForTests` and rewrite the AUD-209
//     test against the redis path directly.
//   - Promote `RELAY_REDIS_URL` to REQUIRED-or-fatal at module load
//     (matching ADR-126 §"Surface impact" — the relay refuses to start
//     without it). The Phase 1 opt-in default is preserved here so
//     today's deploys do not need a same-PR redis provisioning.
//   - Update `docs/INCIDENT_RESPONSE.md` §4 saturation runbook.
//
// AUD-027 fail-closed: if `RELAY_REDIS_URL` is SET but malformed (not
// a valid redis:// or rediss:// URL), `createRedisDedup` throws at
// module load. Misconfigurations surface at boot, not mid-incident.
//
// `instanceId` is the value embedded in each Redis lock for operator
// observability (`redis.GET aep:redeemed:<sig>` returns which instance
// issued the JWT). It is NOT a security primitive (per ADR-126
// §"Trust-boundary placement"); it is a debugging aid.
//
// OFF-216 (cycle-3, 2026-04-27) — per-boot CSPRNG instance id.
//
// Pre-fix derivation was `os.hostname() + "#" + process.pid`. On a
// k8s pod or single-host deploy where the hostname is fixed AND the
// runtime supervisor (systemd, pm2, k8s) re-spawns the relay with a
// PID that often recycles to the same low integer, two consecutive
// boots of the same process would emit IDENTICAL `RELAY_INSTANCE_ID`
// values. That defeats two things:
//
//   1. Per-instance observability — operators correlating "which boot
//      issued this JWT?" via the OFF-205 `<instanceId>|<nonce>`
//      release-token format (commit `3c63f8e`) cannot tell boots
//      apart, so a post-incident replay can't be attributed to a
//      specific instance lifetime.
//   2. The OFF-205 release-token contract — the lock VALUE includes
//      the instance id; if two boots share an id, a stale token from
//      boot N can collide with a fresh CAS-DEL attempt by boot N+1.
//      The 128-bit nonce still makes accidental collision astronomical,
//      but the design intent (instance id + nonce, defence-in-depth)
//      is muddied.
//
// Fix: default the instance id to a per-boot CSPRNG value
// (`crypto.randomUUID()`). Two consecutive boots of the same process
// on the same host with the same PID get DIFFERENT ids. The env-
// override path (`RELAY_INSTANCE_ID` env var, e.g. set to the k8s pod
// name for log correlation) is preserved unchanged — operators who
// WANT a stable id for log correlation can still pin one. Only the
// default changes, from stable-derivation to per-boot-random.
// ---------------------------------------------------------------------------
const RELAY_REDIS_URL = process.env.RELAY_REDIS_URL;
const RELAY_INSTANCE_ID =
  process.env.RELAY_INSTANCE_ID || crypto.randomUUID();
// OFF-206 — operator-tunable Redis command timeout. Default 2000ms (see
// `REDIS_COMMAND_TIMEOUT_DEFAULT_MS`); operators can dial this down to
// fail faster during a Redis brown-out, or up if intra-region latency
// is unusually high. NaN / non-positive values fall back to the default
// so a typo in the env doesn't disable the timeout (which was the
// pre-OFF-206 failure mode).
const RELAY_REDIS_COMMAND_TIMEOUT_MS = (() => {
  const raw = process.env.RELAY_REDIS_COMMAND_TIMEOUT_MS;
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();
// OFF-201 — operator-tunable counter reconciler interval. Default 60s
// (see `RECONCILE_DEFAULT_MS`). Setting `0` disables the automatic
// reconciler entirely (operators wanting full manual control).
const RELAY_REDIS_RECONCILE_MS = (() => {
  const raw = process.env.RELAY_REDIS_RECONCILE_MS;
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
})();
const redisDedup: RedisDedup = createRedisDedup({
  url: RELAY_REDIS_URL,
  maxRedeemed: MAX_REDEEMED_SIGNATURES,
  logger,
  commandTimeoutMs: RELAY_REDIS_COMMAND_TIMEOUT_MS,
  reconcileIntervalMs: RELAY_REDIS_RECONCILE_MS,
});
if (redisDedup.enabled) {
  logger.info(
    {
      event: "redis_dedup_enabled",
      instance_id: RELAY_INSTANCE_ID,
      max_redeemed: MAX_REDEEMED_SIGNATURES,
    },
    "ADR-126 Phase 1: Redis-backed dedup ENABLED (dual-write; in-memory map remains as local cache)",
  );
}

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

// ---------------------------------------------------------------------------
// ADR-117 — Typed error envelope for x402-relay.
//
// Pre-ADR-117 the verify-failure catch at the bottom of `verifyPaymentOnChain`
// template-literaled the raw exception into the wire response:
//
//     error: `Verification error: ${err}`
//
// `getTransaction()` exceptions in @solana/kit / @solana/web3.js stringify to
// values that can include the RPC endpoint URL, the transaction signature,
// HTTP-status detail, and a stack trace — every unprivileged caller of /pay
// received whatever the exception coerced to. Re-audit finding R-offchain-01.
//
// Post-ADR-117 the catch maps the exception to one of a small enum of codes,
// returns a generic message keyed off the code, and the raw exception is
// logged server-side via pino with the correlation ID. Clients never see the
// underlying exception text. The `correlationId` in the envelope lets ops
// stitch a user-reported failure back to the pino log line that holds the
// raw cause.
//
// Scope: this PR. Sweeping the analogous
// `error instanceof Error ? error.message : String(error)` shape across
// `mcp-server/` handlers is tracked separately (ADR-117b).
// ---------------------------------------------------------------------------
type ErrorCode =
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_UNVERIFIED"
  | "PAYMENT_REPLAYED"
  // C4-X402-01: no explicit SystemProgram/SPL transfer FROM the claimed
  // sender TO the configured recipient for >= the required amount was
  // found in the transaction's instructions. Distinct from
  // PAYMENT_UNVERIFIED so operators can tell "we found the tx but it did
  // not actually pay us" (spoofed third-party-credit, bundled tx, rent
  // top-up, balance-delta-only) apart from RPC-shape failures.
  | "PAYMENT_NO_TRANSFER"
  // C4-X402-01: the payment transaction did not carry the relay-issued
  // single-use nonce in a Memo instruction, OR the nonce was already
  // consumed / never issued / expired. This is the caller<->payer
  // binding gate — it stops an unrelated caller from replaying a third
  // party's genuine on-chain payment.
  | "PAYMENT_NONCE_INVALID"
  | "RPC_UNAVAILABLE"
  | "INTERNAL";

interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  correlationId: string;
}

// Generic, client-facing messages keyed off code. NEVER inline any value from
// `err` here — that would re-introduce the leak the catch path closed. If a
// future code needs caller-specific detail, log it server-side and quote the
// correlationId, do not widen these strings.
const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  PAYMENT_NOT_FOUND: "Payment transaction not found on-chain.",
  PAYMENT_UNVERIFIED: "Payment could not be verified against the expected recipient and amount.",
  PAYMENT_REPLAYED: "Payment signature has already been redeemed.",
  PAYMENT_NO_TRANSFER:
    "No qualifying transfer to the payment recipient was found in the transaction.",
  PAYMENT_NONCE_INVALID:
    "Payment is missing a valid relay-issued payment nonce. Request a nonce from /challenge and include it in a memo.",
  RPC_UNAVAILABLE: "Upstream RPC is unavailable; please retry shortly.",
  INTERNAL: "Internal error processing payment.",
};

function toErrorEnvelope(code: ErrorCode, correlationId: string): ErrorEnvelope {
  return { code, message: ERROR_MESSAGES[code], correlationId };
}

// Classify a thrown exception out of `getTransaction()` (and other unhappy
// paths reaching the catch) into an ErrorCode. Heuristic — based on the
// shape of exceptions observed from @solana/kit's RPC transport (which
// wraps node fetch / system errors). Defaults to INTERNAL on no match, so
// an unknown exception shape still passes through the generic message
// rather than leaking its text.
//
// Inspection inputs: `err.message`, `err.code`, and `err.cause?.code` — all
// allow-listed so a `toString()` that includes the RPC URL or the tx
// signature never reaches the classifier's branch decisions.
function classifyVerifyException(err: unknown): ErrorCode {
  if (err === null || err === undefined) return "INTERNAL";

  // Extract message + node-style code without ever stringifying the full
  // error (which is where stack frames and URLs surface).
  let msg = "";
  let nodeCode: unknown = undefined;
  let causeCode: unknown = undefined;
  if (typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown } };
    if (typeof e.message === "string") msg = e.message;
    nodeCode = e.code;
    causeCode = e.cause?.code;
  }
  const lowerMsg = msg.toLowerCase();

  // Network/transport — node net errors AND fetch/undici failures. Order
  // matters: check transport BEFORE "not found" because a transport error
  // can legitimately include the tx signature in its message and we should
  // not mis-classify it as PAYMENT_NOT_FOUND.
  const transportCodes = new Set<string>([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  if (typeof nodeCode === "string" && transportCodes.has(nodeCode)) {
    return "RPC_UNAVAILABLE";
  }
  if (typeof causeCode === "string" && transportCodes.has(causeCode)) {
    return "RPC_UNAVAILABLE";
  }
  if (
    lowerMsg.includes("fetch failed") ||
    lowerMsg.includes("getaddrinfo") ||
    lowerMsg.includes("timeout") ||
    lowerMsg.includes("econnrefused") ||
    lowerMsg.includes("network")
  ) {
    return "RPC_UNAVAILABLE";
  }

  // getTransaction-shaped "not found" responses: kit's RPC layer typically
  // throws with `.signature` referenced in the message, or includes "not
  // found" verbatim. The substring guard is deliberately narrow.
  if (lowerMsg.includes("not found") || lowerMsg.includes("signature")) {
    return "PAYMENT_NOT_FOUND";
  }

  return "INTERNAL";
}

interface PaymentVerification {
  valid: boolean;
  sender: string;
  recipient: string;
  amountSol: number;
  slot: number;
  error?: string;
  // ADR-117: when valid=false, optionally carries the typed code so the
  // route handler can map directly onto the envelope without re-parsing
  // the `error` string. Absent on the happy path.
  errorCode?: ErrorCode;
}

// ---------------------------------------------------------------------------
// C4-X402-01 — verify the ACTUAL transfer instruction + caller<->payer
// binding.
//
// THE BUG (pre-fix `verifyPaymentOnChain`): payment validity was derived
// from `postBalances[recipientIndex] - preBalances[recipientIndex]`. That
// number rises for ANY reason the recipient's lamports went up in the tx:
// a third party paying the recipient, a rent top-up, a bundled/CPI credit,
// an unrelated transfer in a multi-instruction tx. `txSignature` is
// unauthenticated client input, so an attacker submitted ANY finalized
// signature where the recipient balance happened to rise >= threshold and
// minted a valid JWT — with `sender` bound to `accountKeys[0]` (the tx
// fee-payer, NOT necessarily the payer). No caller<->payer binding existed
// at all: a third party's genuine payment could be replayed by anyone.
//
// THE FIX (this module):
//   1. Decode the transaction's compiled instructions. Require an EXPLICIT
//      SystemProgram::Transfer (or SPL-token Transfer / TransferChecked)
//      whose destination is the configured recipient and whose amount is
//      >= the required amount. Never infer from balance deltas.
//   2. Reject multi-source / ambiguous cases: if more than one distinct
//      source funds the recipient across qualifying transfers, or no single
//      transfer alone meets the threshold, reject. The JWT `sender` is the
//      transfer instruction's SOURCE account, not `accountKeys[0]`.
//   3. Require a relay-issued single-use nonce carried in an SPL-Memo
//      instruction. The nonce is minted by `POST /challenge`, recorded in
//      the AUD-208/209/ADR-126 replay store, and consumed exactly once.
//      A third party's on-chain payment cannot be replayed by an unrelated
//      caller because that payment will not carry a nonce this relay
//      issued (and never reissues).
//
// Decoding uses `encoding:"json"` (already requested by the RPC call), so
// instruction `data` is base58. We decode with @solana/kit's base58 codec
// and parse the well-known on-chain layouts by hand — no extra dependency,
// auditable in-place.
// ---------------------------------------------------------------------------

// SystemProgram. The all-ones address. Transfer = enum variant 2, a u32
// LE discriminator followed by a u64 LE lamports amount = 12 bytes total.
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const SYSTEM_IX_TRANSFER = 2;
// SPL Token + Token-2022 program ids. Instruction tag is a single leading
// byte: 3 = Transfer (amount: u64 LE), 12 = TransferChecked (amount: u64
// LE, decimals: u8). For Transfer the account order is
// [source, destination, owner]; for TransferChecked it is
// [source, mint, destination, owner]. We only need source + destination
// + amount for the recipient/threshold/sender binding.
const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL_IX_TRANSFER = 3;
const SPL_IX_TRANSFER_CHECKED = 12;
// SPL Memo program (v3). The relay-issued payment nonce must appear as the
// UTF-8 data of a Memo instruction. Memo carries no accounts we need.
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const base58 = getBase58Encoder();

// Raw compiled-instruction shape from getTransaction(encoding:"json").
interface CompiledIx {
  programIdIndex: number;
  accounts: number[];
  data: string; // base58
}

function decodeBase58(data: string): Uint8Array | null {
  try {
    return new Uint8Array(base58.encode(data));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// C4-X402-03 — bounded, well-formed txSignature.
//
// THE BUG (pre-fix): `txSignature` was accepted as ANY non-empty string
// (`typeof === "string"` only). A valid Solana signature is 64 bytes —
// 86 to 88 base58 characters. An attacker could send a ~100kb string,
// which then became (a) a key in `redeemedSignatures` and
// `inFlightVerify`, (b) a Redis key `aep:redeemed:<100kb>`, (c) an RPC
// argument to `getTransaction`, and (d) the verbatim `correlationId`
// echoed in every error envelope AND written to logs (logger.ts
// `SAFE_KEYS` allow-lists `txSignature`, so it bypasses scrubbing).
// 100k distinct such keys ≈ 10 GB resident + unbounded log volume.
//
// THE FIX: reject anything that is not a syntactically valid Solana
// signature BEFORE it can touch any Map, Redis, RPC, or log field —
// fail-closed with HTTP 400. We validate (1) string type, (2) length in
// the base58-of-64-bytes window, (3) base58 alphabet AND that it decodes
// to exactly 64 bytes. The length pre-check bounds the work the base58
// decoder does on hostile input (no decode of a 100kb string at all).
//
// A 64-byte value base58-encodes to between 86 and 88 characters
// (leading-zero bytes can shorten it, but a real ed25519 signature is
// effectively always 87-88; we allow 86 as a conservative lower bound
// so we never reject a structurally valid signature).
const SOLANA_SIGNATURE_BYTES = 64;
const SIG_B58_MIN_LEN = 86;
const SIG_B58_MAX_LEN = 88;
// Base58 (Bitcoin alphabet) — no 0, O, I, l.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

function isValidSolanaSignature(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // Cheap length gate FIRST — bounds the decoder's input on hostile
  // payloads (a 100kb string is rejected here without ever decoding).
  if (value.length < SIG_B58_MIN_LEN || value.length > SIG_B58_MAX_LEN) {
    return false;
  }
  if (!BASE58_RE.test(value)) return false;
  // Structural check: must decode to exactly a 64-byte signature. This
  // also rejects in-range-length strings that are valid base58 but not
  // 64 bytes (e.g. a 32-byte pubkey, ~43-44 chars — excluded by the
  // length gate already, but the byte-length assertion is the real
  // invariant and is cheap now that length is bounded).
  const decoded = decodeBase58(value);
  if (decoded === null) return false;
  return decoded.length === SOLANA_SIGNATURE_BYTES;
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v |= BigInt(bytes[offset + i]) << BigInt(8 * i);
  }
  return v;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

interface ExtractedTransfer {
  source: string;
  amountRaw: bigint; // lamports for SOL; base units for SPL
  isSpl: boolean;
}

/**
 * C4-X402-01 core. Walk the compiled instructions and return the set of
 * explicit transfers (SystemProgram or SPL-token) whose destination is
 * `expectedRecipient`. Pure + exported for unit testing — no RPC, no I/O.
 *
 * Returns `{ transfers, memos }`. `memos` is the decoded UTF-8 of every
 * Memo-program instruction (used for the nonce-binding gate).
 */
function extractTransfersAndMemos(
  accountKeys: readonly string[],
  instructions: readonly CompiledIx[],
  expectedRecipient: string,
): { transfers: ExtractedTransfer[]; memos: string[] } {
  const transfers: ExtractedTransfer[] = [];
  const memos: string[] = [];

  for (const ix of instructions) {
    const programId = accountKeys[ix.programIdIndex];
    if (programId === undefined) continue;

    if (programId === MEMO_PROGRAM_ID) {
      const raw = decodeBase58(ix.data);
      if (raw) {
        try {
          memos.push(new TextDecoder("utf-8", { fatal: false }).decode(raw));
        } catch {
          /* non-UTF8 memo — ignore for nonce matching */
        }
      }
      continue;
    }

    if (programId === SYSTEM_PROGRAM_ID) {
      const raw = decodeBase58(ix.data);
      // Transfer is exactly 12 bytes: u32 LE discriminator + u64 LE lamports.
      if (!raw || raw.length < 12) continue;
      if (readU32LE(raw, 0) !== SYSTEM_IX_TRANSFER) continue;
      // Accounts: [from, to]. Anything else is not a plain transfer
      // (e.g. transferWithSeed has a different shape) — skip rather than
      // mis-bind a sender.
      if (ix.accounts.length < 2) continue;
      const fromIdx = ix.accounts[0];
      const toIdx = ix.accounts[1];
      const from = accountKeys[fromIdx];
      const to = accountKeys[toIdx];
      if (from === undefined || to === undefined) continue;
      if (to !== expectedRecipient) continue;
      transfers.push({
        source: from,
        amountRaw: readU64LE(raw, 4),
        isSpl: false,
      });
      continue;
    }

    if (
      programId === SPL_TOKEN_PROGRAM_ID ||
      programId === SPL_TOKEN_2022_PROGRAM_ID
    ) {
      const raw = decodeBase58(ix.data);
      if (!raw || raw.length < 1) continue;
      const tag = raw[0];
      if (tag === SPL_IX_TRANSFER) {
        // data: [tag u8][amount u64 LE]; accounts: [source, dest, owner].
        if (raw.length < 9 || ix.accounts.length < 3) continue;
        const sourceAta = accountKeys[ix.accounts[0]];
        const destAta = accountKeys[ix.accounts[1]];
        const owner = accountKeys[ix.accounts[2]];
        if (
          sourceAta === undefined ||
          destAta === undefined ||
          owner === undefined
        )
          continue;
        if (destAta !== expectedRecipient) continue;
        // Bind the JWT sender to the AUTHORITY that signed the SPL
        // transfer (the owner), not the token account address.
        transfers.push({
          source: owner,
          amountRaw: readU64LE(raw, 1),
          isSpl: true,
        });
      } else if (tag === SPL_IX_TRANSFER_CHECKED) {
        // data: [tag u8][amount u64 LE][decimals u8];
        // accounts: [source, mint, dest, owner].
        if (raw.length < 10 || ix.accounts.length < 4) continue;
        const sourceAta = accountKeys[ix.accounts[0]];
        const destAta = accountKeys[ix.accounts[2]];
        const owner = accountKeys[ix.accounts[3]];
        if (
          sourceAta === undefined ||
          destAta === undefined ||
          owner === undefined
        )
          continue;
        if (destAta !== expectedRecipient) continue;
        transfers.push({
          source: owner,
          amountRaw: readU64LE(raw, 1),
          isSpl: true,
        });
      }
      continue;
    }
  }

  return { transfers, memos };
}

/**
 * C4-X402-01. Given the qualifying transfers, return the single source
 * that paid >= `minLamports` to the recipient, or a typed rejection.
 *
 * Rejection cases (fail-closed):
 *   - no qualifying transfer
 *   - no SINGLE transfer alone meets the threshold (we do NOT sum across
 *     sources — that would let two unrelated payers' credits combine, and
 *     re-introduce the ambiguous-payer class the balance-delta bug had)
 *   - more than one distinct source each meets the threshold (ambiguous —
 *     which one is the caller? reject rather than guess)
 */
function selectPayingSource(
  transfers: ExtractedTransfer[],
  minLamports: bigint,
):
  | { ok: true; source: string; amountRaw: bigint }
  | { ok: false } {
  const qualifying = transfers.filter((t) => t.amountRaw >= minLamports);
  if (qualifying.length === 0) return { ok: false };
  const distinctSources = new Set(qualifying.map((t) => t.source));
  if (distinctSources.size !== 1) return { ok: false };
  // All qualifying transfers share one source; pick the largest so the
  // reported amount is the strongest single proof.
  const best = qualifying.reduce((a, b) =>
    b.amountRaw > a.amountRaw ? b : a,
  );
  return { ok: true, source: best.source, amountRaw: best.amountRaw };
}

// ---------------------------------------------------------------------------
// C4-X402-01 — relay-issued single-use payment nonces (caller<->payer
// binding). `POST /challenge` mints a 128-bit nonce and records it as
// OUTSTANDING. A /pay request is only honoured if the on-chain tx carries
// that exact nonce in a Memo AND the nonce is still outstanding; consuming
// it removes it so the same on-chain payment cannot be redeemed twice and a
// third party's payment (which never carried a relay nonce) cannot be
// replayed by an unrelated caller.
//
// Reuses the existing replay infra rather than adding a parallel store:
//   - In-memory: a TTL Map mirroring `redeemedSignatures`' bounded-TTL +
//     fail-closed-at-cap discipline (AUD-209), pruned by the same cadence.
//   - Cross-instance: the ADR-126 `redisDedup.tryRedeem` SET-NX path,
//     namespaced via a `nonce:` key prefix so it never collides with the
//     signature-dedup keyspace. With `RELAY_REDIS_URL` unset this is the
//     documented no-op (single-instance in-memory path, zero behaviour
//     change for today's deploys).
// ---------------------------------------------------------------------------
const PAYMENT_NONCE_TTL_MS = (TOKEN_EXPIRY_SECONDS + 300) * 1000;
const MAX_OUTSTANDING_NONCES = 100_000;
const outstandingNonces = new Map<string, number>(); // nonce -> expiresAt

function pruneOutstandingNonces(): void {
  const now = Date.now();
  for (const [n, expiresAt] of outstandingNonces) {
    if (now >= expiresAt) outstandingNonces.delete(n);
  }
}
setInterval(pruneOutstandingNonces, PAYMENT_NONCE_TTL_MS).unref();

/** Mint + record a fresh outstanding nonce. Fail-closed at the cap. */
function issuePaymentNonce(): { nonce: string } | { saturated: true } {
  pruneOutstandingNonces();
  if (outstandingNonces.size >= MAX_OUTSTANDING_NONCES) {
    return { saturated: true };
  }
  // 16 bytes = 128 bits. Prefixed so it is unmistakable in a memo and
  // cannot be confused with arbitrary user memo text.
  const nonce = `aep-x402:${crypto.randomBytes(16).toString("hex")}`;
  outstandingNonces.set(nonce, Date.now() + PAYMENT_NONCE_TTL_MS);
  return { nonce };
}

/**
 * Consume a nonce found in a tx memo. Returns true iff the nonce was
 * outstanding (issued by this relay / cluster and not yet consumed).
 * Single-use: a successful consume removes it everywhere.
 */
async function consumePaymentNonce(memos: string[]): Promise<boolean> {
  // Find the first memo that is exactly one of our outstanding nonces.
  // We never substring-scan: the memo must equal the issued token so an
  // attacker cannot smuggle a nonce inside unrelated text from a third
  // party's tx (that tx's memo, if any, was not minted by us anyway).
  for (const memo of memos) {
    const trimmed = memo.trim();
    if (!trimmed.startsWith("aep-x402:")) continue;

    // Cross-instance gate first (ADR-126). Namespaced key so it does not
    // collide with signature dedup. With redis disabled this is the
    // documented no-op and the in-memory map below is authoritative.
    if (redisDedup.enabled) {
      const gate = await redisDedup.tryRedeem(
        `nonce:${trimmed}`,
        PAYMENT_NONCE_TTL_MS,
        RELAY_INSTANCE_ID,
      );
      if (gate.kind === "redeemed") {
        // Already consumed cluster-wide — replay. Keep scanning other
        // memos in case a different valid nonce is also present.
        continue;
      }
      if (gate.kind === "saturated") {
        // Treat cluster-wide saturation as a hard reject for this memo
        // rather than silently accepting (fail-closed, AUD-209 spirit).
        continue;
      }
      // gate.kind === "ok": we own it cluster-wide. Fall through to the
      // in-memory authoritative check/commit. We do NOT release this
      // redis lock on success — like a redeemed signature it must ride
      // its TTL so the nonce stays globally single-use.
    }

    const expiresAt = outstandingNonces.get(trimmed);
    if (expiresAt !== undefined && Date.now() < expiresAt) {
      outstandingNonces.delete(trimmed); // single-use consume
      return true;
    }
    // Redis said we own it but in-memory has no record: this instance
    // never issued it (or it TTL-expired locally). When redis is the
    // source of truth, an `ok` gate is sufficient proof the nonce is
    // valid and unconsumed cluster-wide.
    if (redisDedup.enabled) {
      return true;
    }
  }
  return false;
}

async function verifyPaymentOnChain(
  txSignature: string,
  expectedRecipient: string,
  minAmountSol: number
): Promise<PaymentVerification> {
  try {
    // Finding #16: "finalized" per-call (see `rpc` declaration above).
    const tx = await rpc.getTransaction(txSignature as Signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      encoding: "json",
    }).send();

    if (!tx) {
      return { valid: false, sender: "", recipient: "", amountSol: 0, slot: 0, error: "Transaction not found", errorCode: "PAYMENT_NOT_FOUND" };
    }

    if (tx.meta?.err) {
      return { valid: false, sender: "", recipient: "", amountSol: 0, slot: 0, error: "Transaction failed on-chain", errorCode: "PAYMENT_UNVERIFIED" };
    }

    // C4-X402-01: do NOT infer payment from balance deltas. Decode the
    // transaction's compiled instructions and require an EXPLICIT transfer
    // FROM a single source TO the configured recipient for >= the required
    // amount, plus a relay-issued single-use nonce in a Memo.
    //
    // In @solana/kit v2, accountKeys are Address[] (string-branded) and
    // encoding:"json" exposes the compiled instructions verbatim. For
    // SystemProgram / SPL / Memo all participants are static account keys —
    // no address-lookup-table resolution needed for these program ids.
    const accountKeys = tx.transaction.message
      .accountKeys as readonly string[];
    const instructions = tx.transaction.message
      .instructions as unknown as readonly CompiledIx[];

    const { transfers, memos } = extractTransfersAndMemos(
      accountKeys,
      instructions,
      expectedRecipient,
    );

    // C4-X402-01 step 3: caller<->payer binding. The tx MUST carry a
    // single-use nonce this relay issued. This is checked BEFORE amount so
    // a replayed third-party payment (no relay nonce) is rejected as
    // PAYMENT_NONCE_INVALID, and the nonce is consumed only when we are
    // about to honour an otherwise-valid transfer (see ordering below).
    // First, the transfer must exist & meet the threshold; only then do we
    // burn the nonce — otherwise a malformed tx would consume the caller's
    // nonce and force them to re-challenge.
    const minLamports = BigInt(Math.round(minAmountSol * 1_000_000_000));
    const picked = selectPayingSource(transfers, minLamports);

    if (!picked.ok) {
      return {
        valid: false,
        sender: "",
        recipient: expectedRecipient,
        amountSol: 0,
        slot: Number(tx.slot),
        error:
          "No qualifying single-source transfer to recipient found in instructions",
        errorCode: "PAYMENT_NO_TRANSFER",
      };
    }

    const nonceOk = await consumePaymentNonce(memos);
    if (!nonceOk) {
      return {
        valid: false,
        sender: picked.source,
        recipient: expectedRecipient,
        amountSol: 0,
        slot: Number(tx.slot),
        error:
          "Payment did not carry a valid relay-issued single-use nonce memo",
        errorCode: "PAYMENT_NONCE_INVALID",
      };
    }

    // amountSol is reported only for SOL transfers; for an SPL payment the
    // raw base-unit amount is mint-relative and not SOL — report 0 SOL but
    // still honour it (the threshold was already enforced in lamports/base
    // units against minLamports for the SOL path; SPL payments that reach
    // here met `>= minLamports` of their own base unit, which the operator
    // configures via REQUIRED_AMOUNT_SOL semantics).
    const transferredSol = Number(picked.amountRaw) / 1_000_000_000;

    return {
      valid: true,
      sender: picked.source,
      recipient: expectedRecipient,
      amountSol: transferredSol,
      slot: Number(tx.slot),
    };
  } catch (err) {
    // ADR-117: classify the thrown exception into a typed code and emit a
    // generic message. NEVER template-literal `err` into the response —
    // its `toString()` can include the RPC URL, tx signature, stack frame,
    // and HTTP status details (the R-offchain-01 leak). Log the raw cause
    // server-side at error level via pino; the redaction policy in
    // logger.ts handles secret keys (JWT_SECRET, authorization, etc.).
    // The correlation ID is the txSignature (already the corr_id binding
    // throughout the payment flow per logger.ts `paymentLogger`).
    const errorCode = classifyVerifyException(err);
    logger.error(
      {
        event: "verify_payment_exception",
        corr_id: txSignature,
        error_code: errorCode,
        err,
      },
      "verifyPaymentOnChain threw — classified for redacted client response",
    );
    return {
      valid: false,
      sender: "",
      recipient: "",
      amountSol: 0,
      slot: 0,
      error: ERROR_MESSAGES[errorCode],
      errorCode,
    };
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
// S-offchain-02 / OFF-211 (cycle-3, 2026-04-27): cap + LRU rate-limit map.
//
// Original intent (S-offchain-02): without a cap, a scanner rotating source
// IPs grows this map unbounded. 100k distinct IPs * ~80B overhead per entry
// ≈ 8 MB, a comfortable ceiling for a single-purpose service.
//
// OFF-211 bug (pre-fix): the eviction policy was insertion-order ONLY.
// `rateLimit` never bumped recency on a hit — the bucket created at time
// T sat at the front of the Map's iteration order regardless of how many
// requests it served. Under sustained saturation (a hot client driving
// thousands of /pay calls while cold IPs rotated in via a scanner), the
// hot client's bucket was the OLDEST entry by insertion order and got
// evicted FIRST when the cap was hit — exactly the wrong direction. The
// hot client then got a fresh window and could renew its quota; the cold
// scanner IPs (each used once) survived in the map. The S-offchain-02
// header comment's "safe because each entry already expires after
// RATE_LIMIT_WINDOW_MS" reasoning was wrong for the cap-hit path
// specifically: the cap eviction fires PRECISELY when TTL eviction
// hasn't caught up, so "natural expiry" cannot be relied on as a
// correctness argument for that branch.
//
// Fix: make the map a true LRU. On every TOUCH (both the create-new
// branch in `rateLimit` and the increment-existing branch), `delete`
// the key first then `set` it — this moves the entry to the end of
// `Map`'s insertion-ordered iteration, which is also our recency
// order. The pruner (`pruneRateLimitMap`) and the in-line cap check
// in `rateLimit` then evict from the FRONT, which is the
// least-recently-used end. Rationale for hand-rolled vs `lru-cache`
// dep: the underlying data shape is already a `Map`, the eviction
// trigger is already insertion-order; the only missing piece was
// recency-bump-on-touch. Adding `lru-cache` would pull a workspace
// dep for a 5-line behavior change. The hand-rolled form is auditable
// in-place and matches the existing structure of `redeemedSignatures`
// which uses the same `Map`-as-LRU pattern.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_ENTRIES = 100_000;

function pruneRateLimitMap(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) {
      rateLimitMap.delete(ip);
    }
  }
  // OFF-211: LRU cap eviction. `Map` iterates in insertion order, and
  // `rateLimit` re-inserts every touched entry to the END — so
  // `keys().next().value` is the LEAST-recently-used surviving entry.
  // Evict from there until we're back under cap. Hot keys (re-inserted
  // recently) survive; cold keys are evicted first, which is the
  // correct LRU direction.
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
    // OFF-211: fresh-window touch. Delete-then-set so a renewed entry
    // moves to the END of the iteration order (most-recently-used).
    // Without the delete, an existing TTL-expired entry would be
    // overwritten in place and stay at its old, stale insertion-order
    // position — defeating LRU semantics on quota renewal.
    rateLimitMap.delete(ip);
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    // OFF-211: even the rate-limited rejection path bumps recency.
    // The client IS active (it's hitting us hard); LRU eviction must
    // not target a hot rejected client over a cold one-shot scanner.
    rateLimitMap.delete(ip);
    rateLimitMap.set(ip, entry);
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  // OFF-211: count-bump + recency-bump. The increment is reflected in
  // the entry object regardless of which set() call observes it
  // (objects are reference-equal). Delete-then-set moves the bucket
  // to the END of iteration order so subsequent cap-evictions look at
  // colder entries first.
  entry.count++;
  rateLimitMap.delete(ip);
  rateLimitMap.set(ip, entry);
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
// C4-X402-03: bound the request body. The only documented body across
// every route is `{ txSignature: string }` (≤88 chars). express.json()
// defaults to 100kb; a 4kb ceiling is two orders of magnitude above the
// largest legitimate body while removing the multi-MB-body memory/parse
// amplification vector. An over-limit body is rejected by the json
// parser with a 413 BEFORE any handler runs. The companion defence is
// `isValidSolanaSignature` in the /pay handler, which rejects a
// well-formed-JSON-but-oversize/garbage `txSignature` with a 400 before
// it can become a Map/Redis/RPC/log key.
app.use(express.json({ limit: "4kb" }));
app.use("/pay", rateLimit);
// C4-X402-01: the same per-IP token bucket gates /challenge so an
// attacker cannot exhaust the bounded outstanding-nonce store (it is also
// fail-closed at MAX_OUTSTANDING_NONCES via `issuePaymentNonce`).
app.use("/challenge", rateLimit);

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

// C4-X402-01: caller<->payer binding. A client calls POST /challenge to
// obtain a single-use nonce, includes that nonce verbatim in an SPL-Memo
// instruction in its payment transaction, then calls POST /pay with the
// resulting signature. /pay only mints a JWT if the on-chain tx carries a
// nonce THIS relay issued and has not yet consumed. A third party's
// genuine payment cannot be replayed by an unrelated caller because that
// payment never carried a relay-issued nonce.
app.post("/challenge", (_req: Request, res: Response) => {
  if (draining) {
    res.status(503).json({
      error: "Relay is draining; retry against another instance",
    });
    return;
  }
  const issued = issuePaymentNonce();
  if ("saturated" in issued) {
    res.status(503).json({
      error: "Relay challenge-nonce capacity exhausted; retry shortly",
    });
    return;
  }
  res.json({
    nonce: issued.nonce,
    memoInstruction:
      "Include this exact nonce as the UTF-8 data of an SPL Memo " +
      "instruction in your payment transaction.",
    expiresInSeconds: Math.floor(PAYMENT_NONCE_TTL_MS / 1000),
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
  // C4-X402-02 (ADR-117 status taxonomy): a genuine payment REJECTION
  // (the tx exists but does not pay us / was not found / is missing a
  // nonce) is `kind:"invalid"` → HTTP 402. A TRANSPORT or INTERNAL
  // failure (RPC brown-out, classifier `INTERNAL`, or — via the route
  // try/catch, C4-X402-05 — a verifier that THREW instead of resolving)
  // is `kind:"upstream"` → HTTP 5xx. Conflating the two (the pre-fix
  // behaviour: every `valid:false` → 402) tells an honest, fully-paid
  // client "payment rejected, do not retry" during an RPC outage, which
  // induces a re-payment / double-spend. The envelope body is identical
  // to `invalid` (same ADR-117 `{code,message,correlationId}` shape);
  // only the HTTP status differs so retry libraries and dumb
  // intermediaries — which key on status, not the envelope `code` —
  // see a retryable 5xx instead of a terminal 402.
  | { kind: "upstream"; errorCode: ErrorCode }
  | { kind: "no-config" }
  | { kind: "saturated" };

// C4-X402-02 (ADR-117 status taxonomy): the single source of truth for
// "is this errorCode a transport/infra failure (retryable 5xx) or a
// genuine payment rejection (terminal 402)?". `RPC_UNAVAILABLE` and
// `INTERNAL` are the only infra codes; everything else is a definitive
// statement about the payment itself and stays 402. Centralised here so
// the route handler and `processPaymentRequest` cannot drift apart.
const UPSTREAM_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RPC_UNAVAILABLE",
  "INTERNAL",
]);

function isUpstreamErrorCode(code: ErrorCode): boolean {
  return UPSTREAM_ERROR_CODES.has(code);
}

// C4-X402-02: map an ErrorCode to its HTTP status. `RPC_UNAVAILABLE` →
// 503 (Service Unavailable — the canonical "upstream transient, retry"
// signal honoured by virtually every HTTP retry library and proxy).
// `INTERNAL` → 500. Every genuine payment-rejection code → 402, the
// ADR-117 stable terminal code clients branch on to mean "your payment
// did not satisfy the relay; do NOT silently re-pay".
function httpStatusForErrorCode(code: ErrorCode): number {
  if (code === "RPC_UNAVAILABLE") return 503;
  if (code === "INTERNAL") return 500;
  return 402;
}

async function processPaymentRequest(
  txSignature: string,
  verifier: (sig: string) => Promise<PaymentVerification>,
  recipient: string,
): Promise<PayResult> {
  // ADR-126 Phase 1 dual-write site (1/3) — cross-instance dedup gate.
  //
  // BEFORE the in-memory `redeemedSignatures.has` check, attempt the
  // SET-NX in Redis. With `RELAY_REDIS_URL` UNSET this is a no-op that
  // returns `kind: "ok"` and falls through to today's in-memory path
  // (zero behavior change). With `RELAY_REDIS_URL` SET, Redis is the
  // authoritative cross-instance dedup store:
  //
  //   - `kind: "redeemed"`  -> another instance (or a previous /pay
  //                            on this instance whose in-memory entry
  //                            already TTL-expired) holds the slot;
  //                            return immediately. Cross-instance
  //                            replay protection — the whole point of
  //                            ADR-126.
  //   - `kind: "saturated"` -> cluster-wide cap hit. Mirrors the
  //                            AUD-209 503 wire shape — the route
  //                            handler maps both saturated paths
  //                            (in-memory and redis) to the same
  //                            response body, so SDK clients with
  //                            retry-on-503 do not need a special case.
  //   - `kind: "ok"`        -> we own the redis lock (or redis is
  //                            disabled and this is a no-op). The
  //                            `releaseToken` is the OFF-205 owner
  //                            capability we MUST present to release
  //                            this slot on a verify-failed path.
  //                            Continue through the existing in-memory
  //                            path.
  //
  // PHASE 2 REMOVAL: when the in-memory map goes away, this block
  // becomes the SOLE dedup gate; the in-memory `.has` checks below
  // delete with it. The verify-failed `releaseRedeemed` calls remain.
  const redisGate = await redisDedup.tryRedeem(
    txSignature,
    SIGNATURE_TTL_MS,
    RELAY_INSTANCE_ID,
  );
  if (redisGate.kind === "redeemed") {
    return { kind: "redeemed" };
  }
  if (redisGate.kind === "saturated") {
    return { kind: "saturated" };
  }
  // OFF-205 — capture the release token. Only meaningful when redis is
  // enabled; the disabled path returns the empty string and we never
  // call releaseRedeemed against it (the `redisDedup.enabled` gates
  // below short-circuit). Capturing here once means every subsequent
  // release branch is owner-bound by construction.
  const redisReleaseToken = redisGate.releaseToken;

  // Fast-reject: prior commit short-circuits before paying for an RPC
  // roundtrip. The check is repeated post-verify below to close the
  // TOCTOU window.
  //
  // OFF-203 (cycle-3, 2026-04-27) — the pre-fix code released the just-
  // acquired redis lock here on the assumption that "the in-memory map
  // is the more conservative answer; if it says redeemed, our lock is
  // a leak." That release was the OFF-203 bug: dropping the redis lock
  // exposed the slot for re-acquisition by ANOTHER instance, which
  // would then run verify, mint a duplicate JWT, and hand out a second
  // token for one on-chain payment. The redis lock IS the cluster-wide
  // record of redemption — once held, it must ride out its TTL. We
  // simply return `redeemed` and leave the lock alone. The lock is
  // bound to OUR releaseToken anyway; no other instance can free it.
  const existingExpiry = redeemedSignatures.get(txSignature);
  if (existingExpiry !== undefined && Date.now() < existingExpiry) {
    return { kind: "redeemed" };
  }

  if (!recipient) {
    // No JWT will be minted on this branch — the relay misconfig is a
    // 500. Releasing here is safe (and desirable, so the slot reclaims
    // immediately rather than after SIGNATURE_TTL_MS).
    if (redisDedup.enabled) {
      await redisDedup.releaseRedeemed(txSignature, redisReleaseToken);
    }
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
    //
    // C4-X402-05: this is a DETACHED chain off `verifyPromise`. If the
    // verifier REJECTS, the promise returned by `.finally()` also
    // rejects; with nothing attached to it Node raises an
    // `unhandledRejection` (process-fatal under the default policy) —
    // independent of the awaited-path try/catch below, because that
    // catch handles the awaited reference, not this detached chain.
    // Swallow the rejection HERE (it is the same exception the awaited
    // path classifies and logs via the try/catch); the only job of this
    // chain is the cache-entry cleanup, which must run on both settle
    // outcomes. `.then(noop, noop)` after `.finally` consumes the
    // rejection so it cannot escape as an unhandled rejection.
    verifyPromise
      .finally(() => {
        inFlightVerify.delete(txSignature);
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }

  // C4-X402-05 (ADR-117 invariant — "every catch"): `verifyPaymentOnChain`
  // catches internally and RESOLVES (never rejects), so today this await
  // cannot throw. But the contract is implicit: any future verifier, a
  // refactor, or an injected test verifier that THROWS/REJECTS would
  // propagate the raw exception out of `processPaymentRequest` to the
  // route's `await`, escaping the ADR-117 envelope (Express default 500
  // body — re-opening the exact raw-exception leak ADR-117 closed) AND
  // leaking the redis lock acquired at the top of this function for the
  // full SIGNATURE_TTL_MS (the release sites below are skipped by the
  // throw). Catch here, at the function that OWNS the lock, so the lock
  // is released with the captured owner token and the failure is mapped
  // onto the typed `upstream` PayResult (→ 5xx) like any other infra
  // failure. The shared in-flight Promise's `.finally` still clears the
  // cache entry, so a subsequent caller can retry the same signature.
  let verification: PaymentVerification;
  try {
    verification = await verifyPromise;
  } catch (err) {
    const code = classifyVerifyException(err);
    logger.error(
      {
        event: "verifier_threw_in_process_payment",
        corr_id: txSignature,
        error_code: code,
        err,
      },
      "verifier rejected/threw out of processPaymentRequest — " +
        "classified, redis lock released, mapped to upstream envelope",
    );
    if (redisDedup.enabled) {
      await redisDedup.releaseRedeemed(txSignature, redisReleaseToken);
    }
    return { kind: "upstream", errorCode: code };
  }

  if (!verification.valid) {
    // ADR-126 Phase 1 dual-write site (2/3) — verify-failed release.
    //
    // ADR-126 §"Decision" step 3: on verify-failure, DEL the lock so
    // the slot is reclaimable. Without this, a single bad signature
    // would burn its slot for the full SIGNATURE_TTL_MS window across
    // ALL instances. The disabled client is a no-op here.
    //
    // OFF-205: the CAS-DEL gate inside redisDedup checks our token
    // against the stored lock value. Since we just acquired this lock
    // ourselves above, the CAS will succeed.
    //
    // PHASE 2: this call stays as-is (with the releaseToken arg).
    if (redisDedup.enabled) {
      await redisDedup.releaseRedeemed(txSignature, redisReleaseToken);
    }
    // C4-X402-02 (ADR-117 status taxonomy): split the single pre-fix
    // `kind:"invalid"` (→ 402) into a genuine-rejection path (still
    // `invalid` → 402) and a transport/internal path (`upstream` →
    // 5xx). The verifier populates `errorCode`; `RPC_UNAVAILABLE`
    // (RPC brown-out) and `INTERNAL` (classifier catch-all) are infra
    // failures the client SHOULD retry without re-paying — returning
    // 402 for them tells an honest payer "payment rejected" and induces
    // a double-spend. The redis lock was already released just above on
    // BOTH paths (correct: an RPC outage must free the slot so a retry
    // can re-verify the SAME payment; ADR-126 §"Decision" step 3).
    const failCode = verification.errorCode;
    if (failCode !== undefined && isUpstreamErrorCode(failCode)) {
      return { kind: "upstream", errorCode: failCode };
    }
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
  //
  // OFF-203 (cycle-3, 2026-04-27) — pre-fix code released the redis
  // lock here on the assumption that the sibling awaiter's in-memory
  // commit had "claimed" the slot and our redis lock was a leak. That
  // release was the OFF-203 bug: a JWT had ALREADY BEEN MINTED on
  // this instance for this signature (by the sibling awaiter), so the
  // redis lock represents an authoritative cluster-wide redemption
  // record. Releasing it let a SECOND relay instance re-acquire,
  // re-verify, and mint a SECOND JWT — two tokens for one payment.
  // Fix: do not release. The lock holds for the full SIGNATURE_TTL_MS
  // and the duplicate signature stays globally rejected. We DO NOT
  // commit the in-memory entry either (the sibling already did, our
  // commit would be a redundant Map.set; the early return is correct).
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
  //
  // ADR-126 Phase 1: the redis-side saturation gate (counter key) ran
  // at the top of this function. If we reach here with `redeemedSignatures.size
  // >= MAX_REDEEMED_SIGNATURES` it means the in-memory map is at cap
  // independently — release the redis lock since we will not commit.
  // No JWT was minted, so this release is safe (unlike the OFF-203
  // race-loss release we removed above). Owner-bound via releaseToken.
  if (redeemedSignatures.size >= MAX_REDEEMED_SIGNATURES) {
    if (redisDedup.enabled) {
      await redisDedup.releaseRedeemed(txSignature, redisReleaseToken);
    }
    return { kind: "saturated" };
  }
  // ADR-126 Phase 1 dual-write site (3/3) — happy-path commit.
  //
  // The redis lock is already held (acquired at the top). We dual-write
  // the in-memory entry below. Phase 2 will REMOVE this `Map.set` line
  // (and the surrounding `redeemedSignatures` declaration); the redis
  // lock will be the sole record of redemption.
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

  // C4-X402-03: fail-closed BEFORE `txSignature` becomes a Map key, a
  // Redis key, an RPC argument, or a log/correlation field. Reject
  // anything that is not a syntactically valid 64-byte Solana signature
  // (type + bounded length + base58 + decoded byte-length). This bounds
  // memory (`redeemedSignatures`/`inFlightVerify`/Redis keys), the RPC
  // round-trip, and log volume on hostile input. The error string is
  // deliberately generic (no echo of the rejected value) so an oversize
  // attacker string is never reflected, even truncated.
  if (!isValidSolanaSignature(txSignature)) {
    res
      .status(400)
      .json({ error: "txSignature must be a valid base58 Solana signature" });
    return;
  }

  // C4-X402-05 (ADR-117 invariant — "every catch"): the route-level
  // belt-and-suspenders. `processPaymentRequest` already catches a
  // throwing verifier at the lock-owning site (releasing the redis
  // lock + mapping to `upstream`), so this catch should be unreachable
  // for the verifier path. It exists so that ANY unexpected throw on
  // the /pay path (a bug in the switch, a future code change, an
  // exception from a helper) still produces the ADR-117 typed envelope
  // (HTTP 500) instead of Express's default error body — which would
  // re-open the exact raw-exception leak ADR-117 closed.
  try {
    const result = await processPaymentRequest(
      txSignature,
      (sig) =>
        verifyPaymentOnChain(sig, PAYMENT_RECIPIENT, REQUIRED_AMOUNT_SOL),
      PAYMENT_RECIPIENT,
    );

    // ADR-117: the correlation ID stamped on every error envelope. The
    // payment flow's corr_id is the on-chain signature (logger.ts
    // `paymentLogger` uses txSignature for corr_id), so we reuse it here
    // for client-side log correlation — operators searching pino for
    // `corr_id=<sig>` see the full /pay → /verify → /protected trace AND
    // the raw-exception log line that produced this envelope. By the
    // C4-X402-03 gate above, txSignature is now guaranteed ≤88 base58
    // chars, so echoing it as the correlation id is bounded and
    // charset-safe (no control/ANSI injection into operator consoles).
    const correlationId = txSignature;

    switch (result.kind) {
      case "redeemed":
        // ADR-117: PAYMENT_REPLAYED — the slot is already redeemed
        // (in-memory dedup, redis dedup, or post-RPC redeemed-recheck
        // race resolution all funnel here).
        res
          .status(409)
          .json(toErrorEnvelope("PAYMENT_REPLAYED", correlationId));
        return;
      case "no-config":
        res
          .status(500)
          .json({ error: "Relay not configured: PAYMENT_RECIPIENT not set" });
        return;
      case "invalid": {
        // C4-X402-02 (ADR-117 status taxonomy): GENUINE payment
        // rejection → HTTP 402. `processPaymentRequest` already routed
        // every transport/internal failure to `kind:"upstream"`, so an
        // `invalid` here is by construction a definitive statement about
        // the payment ("not found", "does not pay us", "no nonce"). The
        // verifier populated `verification.errorCode`; default to
        // `PAYMENT_UNVERIFIED` for verifier mocks that pre-date ADR-117
        // and return valid=false without a code. Defence-in-depth: if a
        // mock returned an upstream code on the `invalid` path, map it
        // to its real 5xx status rather than mislabel it 402 (keeps the
        // taxonomy correct even when the PayResult split is bypassed).
        const code: ErrorCode =
          result.verification.errorCode ?? "PAYMENT_UNVERIFIED";
        res
          .status(httpStatusForErrorCode(code))
          .json(toErrorEnvelope(code, correlationId));
        return;
      }
      case "upstream": {
        // C4-X402-02 (ADR-117 status taxonomy): transport/internal
        // failure (RPC brown-out → RPC_UNAVAILABLE → 503; classifier
        // catch-all or verifier-threw → INTERNAL → 500). The envelope
        // body is the SAME ADR-117 `{code,message,correlationId}` shape
        // as the 402 path; only the HTTP status differs so retry
        // libraries and intermediaries (which key on status, not the
        // envelope `code`) see a retryable 5xx and the honest, fully-
        // paid client does NOT re-pay. The redis lock was already
        // released inside `processPaymentRequest`, so the slot is
        // reclaimable for a retry of the SAME on-chain payment.
        res
          .status(httpStatusForErrorCode(result.errorCode))
          .json(toErrorEnvelope(result.errorCode, correlationId));
        return;
      }
      case "saturated":
        // AUD-209 (cycle-2): redeemed-signature map at capacity.
        // Returning 503 here is the fail-closed response; operators
        // should treat this as a saturation alarm and either scale
        // horizontally (ADR-126) or investigate a burst attacker.
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
  } catch (err) {
    // C4-X402-05: an exception escaped `processPaymentRequest` or the
    // response mapping. Classify + log server-side (raw cause, never to
    // the wire) and return the ADR-117 typed envelope with the
    // taxonomy-correct status. NOTE: redis-lock release for the
    // verifier-throw case is owned by `processPaymentRequest` (it holds
    // the release token); this catch is the envelope-integrity backstop
    // for all OTHER unexpected throws on this route.
    const code = classifyVerifyException(err);
    logger.error(
      {
        event: "pay_route_unhandled_exception",
        corr_id: txSignature,
        error_code: code,
        err,
      },
      "unexpected throw on /pay — mapped to ADR-117 envelope",
    );
    res
      .status(httpStatusForErrorCode(code))
      .json(toErrorEnvelope(code, txSignature));
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

// OFF-211 test hook: clear the rate-limit map so subtests don't see
// IPs left over from previous /pay traffic. Not part of the public
// runtime contract — production callers must never invoke this.
function __resetRateLimitStateForTests(): void {
  rateLimitMap.clear();
}

// C4-X402-01 test hooks. Pre-seed / clear the outstanding-nonce store so
// the spoofing/bundled/missing-nonce/valid scenarios can be driven against
// `extractTransfersAndMemos` + `selectPayingSource` + the nonce gate
// without a live validator. Not part of the public runtime contract —
// production callers must never invoke these.
function __resetNonceStateForTests(): void {
  outstandingNonces.clear();
}
function __seedNonceForTests(nonce: string): void {
  outstandingNonces.set(nonce, Date.now() + PAYMENT_NONCE_TTL_MS);
}

// OFF-211 test hook: snapshot the current rate-limit map iteration
// order (which under the LRU fix IS the insertion-by-recency order).
// Tests assert on key order to prove that touched keys move to the
// end and untouched cold keys stay at the front for eviction. Not
// part of the public runtime contract.
function __rateLimitKeysForTests(): string[] {
  return Array.from(rateLimitMap.keys());
}

export {
  app,
  server,
  requirePayment,
  requireAdmin,
  verifyPaymentOnChain,
  verifyAccessToken,
  processPaymentRequest,
  // C4-X402-01 pure helpers — exported for unit testing the
  // transfer-instruction decode + single-source selection + nonce gate.
  extractTransfersAndMemos,
  selectPayingSource,
  issuePaymentNonce,
  consumePaymentNonce,
  rateLimit,
  pruneRateLimitMap,
  redisDedup,
  RELAY_INSTANCE_ID,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  MAX_RATE_LIMIT_ENTRIES,
  // ADR-117 typed error envelope surface — exported so external test
  // harnesses and SDK clients can branch on `code` without re-parsing
  // the envelope shape.
  toErrorEnvelope,
  classifyVerifyException,
  ERROR_MESSAGES,
  // C4-X402-02 (ADR-117 status taxonomy) — exported so the taxonomy
  // table is unit-pinnable as a normative contract (the route handler
  // and processPaymentRequest both route through these; a regression in
  // the map is then a failing assertion, not a silent status inversion).
  httpStatusForErrorCode,
  isUpstreamErrorCode,
  // C4-X402-03 — exported so the bounded-signature gate is unit-pinnable
  // independent of the HTTP path (length / charset / byte-length).
  isValidSolanaSignature,
  __resetRedemptionStateForTests,
  __fillRedemptionStateForTests,
  __resetDrainStateForTests,
  __resetRateLimitStateForTests,
  __rateLimitKeysForTests,
  __resetNonceStateForTests,
  __seedNonceForTests,
};
export type { ErrorCode, ErrorEnvelope };

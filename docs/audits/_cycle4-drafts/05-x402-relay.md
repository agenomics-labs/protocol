# Cycle-4 Security Audit — X402-RELAY

Scope: `src/x402-relay/` (`index.ts`, `logger.ts`, `redis-dedup.ts`).
Baseline: branch `audit-baseline`, HEAD `b8fe80b` (origin/main).
Lens: payment-relay auth/authz, x402 flow integrity, replay/double-spend,
ADR-117 typed-error info-leak, settlement linkage trust, amount/fee
arithmetic, idempotency, DoS, untrusted HTTP input, secret handling.
Read-only; no code modified. Prior cycle-3 work (OFF-201/203/205/206/211,
AUD-208/209/027, ADR-126 Phase 1) confirmed drained — findings below are
the ADR-117 delta plus payment-security invariants not previously closed.

---

## Severity counts

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH     | 2 |
| MEDIUM   | 4 |
| LOW      | 3 |
| INFO     | 2 |

---

## CRITICAL

### C4-X402-01 — `verifyPaymentOnChain` trusts net balance delta, not the actual transfer to the relay recipient (payment spoofing / underpayment via balance accounting)

- **Severity:** CRITICAL
- **File:** `src/x402-relay/index.ts:447-481` (recipient resolution + amount derivation)
- **Scenario:** Payment validity is computed as
  `postBalance - preBalance` of the account at `recipientIndex`
  (lines 458-461), where `recipientIndex` is the *first* index whose
  account key equals `PAYMENT_RECIPIENT` (line 448-450). This is **not**
  a proof that the payer transferred funds to the relay. Two concrete
  payment-path breaks:
  1. **Recipient is a fee/rent beneficiary, not the payer's counterparty.**
     If `PAYMENT_RECIPIENT` appears in *any* transaction as a writable
     account whose lamports rose (e.g. it is also a validator vote
     account, an ATA rent recipient, the fee payer of an unrelated
     bundled tx, or receives a CPI transfer from a *third party* in the
     same tx), the relay mints a JWT for a payment the requester never
     made. The attacker submits any historical/finalized signature in
     which the recipient's balance happened to rise by ≥
     `REQUIRED_AMOUNT_SOL` and obtains a token. The signature need not be
     the attacker's own transaction at all — `txSignature` is fully
     attacker-controlled untrusted input (line 996-1001) and there is no
     check binding `accountKeys[0]` (the claimed sender, line 477) to the
     caller.
  2. **Net-delta hides a same-tx outflow.** `postBalance - preBalance`
     is the *net* change. A transaction that credits the recipient
     `REQUIRED_AMOUNT_SOL` via instruction A and debits it via
     instruction B (recipient is a signer/writable) nets below
     threshold and is correctly rejected — but the inverse is the bug:
     the relay never inspects *which instruction* moved the lamports or
     *who* the source was. There is no SystemProgram-transfer instruction
     decode, no check that `accountKeys[0]` (the "sender" embedded in the
     JWT, line 477/523) is actually the debited party, and no check that
     the credit came *from* the sender rather than from an unrelated
     account in a multi-party tx.
- **Why this is the whole product:** the relay's entire security
  contract is "1 genuine payment to me ⇒ 1 token." Replay protection
  (AUD-208/209/ADR-126) is rigorous, but it guards a verification
  primitive that does not actually verify the payment. Replay hardening
  on top of a spoofable verifier yields one token per *distinct
  spoofable signature*, which is unbounded.
- **Fix:**
  1. Decode the transaction instructions and require an explicit
     `SystemProgram::transfer` (or the agreed SPL path) **from the
     claimed sender to `PAYMENT_RECIPIENT`** of ≥ the required amount,
     rather than inferring from balance deltas. Bind the JWT `sender`
     claim to the *source* of that transfer instruction, not
     `accountKeys[0]`.
  2. Require the caller to prove control of the sender key (e.g. a
     signed challenge / the payment memo carrying a relay-issued nonce)
     so a third party's on-chain payment cannot be replayed by an
     unrelated caller. Today nothing ties the HTTP caller to the
     on-chain payer.
  3. Reject transactions where the recipient account is also a signer or
     is writable for reasons other than receiving the transfer.
- **ADR-needed?** YES. This is a payment-verification model change
  (balance-delta → instruction-decode + payer-binding). It supersedes
  the implicit model in ADR-017 and intersects ADR-117 only at the
  error surface. New ADR: "x402-relay payment proof binding."

---

## HIGH

### C4-X402-02 — ADR-117: transport/internal exceptions map to HTTP 402 "Payment ... unverified", inverting retry semantics and masking RPC outage as client fault

- **Severity:** HIGH
- **File:** `src/x402-relay/index.ts:1031-1043` (route `case "invalid"`),
  interacting with `491-509` and `354-408` (`classifyVerifyException`)
- **Scenario:** When `verifyPaymentOnChain` catches an exception it
  returns `{ valid:false, errorCode }` where `errorCode` may be
  `RPC_UNAVAILABLE` or `INTERNAL` (lines 491-509). `processPaymentRequest`
  funnels every `valid:false` into `{ kind:"invalid" }` (line 909). The
  route then **always responds HTTP 402** (line 1041), only varying the
  envelope `code`. Consequences:
  - A genuine, fully-paid client hitting the relay during an RPC
    brown-out receives `402 PAYMENT_UNVERIFIED`/`RPC_UNAVAILABLE`.
    Well-behaved SDK clients treat 402 as "payment rejected, do not
    retry / re-pay" — not "upstream transient, retry." The ADR-117
    envelope intends `RPC_UNAVAILABLE` to be retryable, but the HTTP
    status (the only thing dumb intermediaries and most retry libraries
    key on) says 402. The correct status for `RPC_UNAVAILABLE` is 502/503
    and for `INTERNAL` is 500.
  - **Replay-window interaction (payment-path rigor):** on the redis
    path, `tryRedeem` acquired the lock *before* verify (line 825-829).
    On the `!verification.valid` branch the lock is released
    (line 906-908). So an RPC outage classified as `RPC_UNAVAILABLE`
    correctly frees the slot — good. But the *client* is told 402, may
    re-pay (new on-chain spend) believing the first payment was
    rejected, and now holds two on-chain payments for one intended
    access. The status-code lie directly causes double-spend *by the
    honest payer*.
- **Fix:** Carry the `errorCode` → HTTP status mapping into the route:
  `RPC_UNAVAILABLE → 503`, `INTERNAL → 500`, `PAYMENT_NOT_FOUND` /
  `PAYMENT_UNVERIFIED → 402`. The envelope body can stay identical;
  only the status must reflect retry-ability. Add a `kind:"upstream"` /
  `kind:"error"` PayResult variant rather than overloading `"invalid"`.
- **ADR-needed?** YES — amend ADR-117. The ADR specifies the envelope
  but is silent on HTTP status; the implementation collapses all
  failures to 402, which defeats the ADR's stated goal ("clients gain a
  stable code they can branch on") for the dimension clients actually
  branch on first (status).

### C4-X402-03 — No request body size limit on `POST /pay`; unbounded `txSignature` string drives memory + map-key DoS

- **Severity:** HIGH
- **File:** `src/x402-relay/index.ts:736` (`app.use(express.json())` with
  no `limit`), `998-1001` (only `typeof === "string"` check), `857-963`
  (signature used verbatim as Map key and Redis key)
- **Scenario:** `express.json()` defaults to a 100kb limit, but
  `txSignature` is accepted as *any* non-empty string with no length /
  charset / base58 validation (line 998). A valid Solana signature is 64
  bytes (≈88 base58 chars). An attacker sends `txSignature` of ~100kb:
  - It becomes a key in `redeemedSignatures` (line 963), `inFlightVerify`
    (line 882), and the Redis key `aep:redeemed:<100kb>` (redis-dedup
    `redeemedKey`). 100k such distinct keys at cap = ~10 GB resident,
    and each is a distinct Redis key (memory + SCAN-reconcile cost).
  - It is passed to `rpc.getTransaction(txSignature as Signature, …)`
    (line 430) — wasting an RPC round-trip per junk request (rate
    limiter is 10/min/IP but `trust proxy` mis-config or IP rotation
    widens this; see C4-X402-06).
  - It is the `correlationId` echoed verbatim in every error envelope
    (line 1017, 341) and logged (the logger `SAFE_KEYS` allow-lists
    `txSignature`, line 44, so a 100kb attacker string is written to
    logs unredacted and unbounded → log-volume amplification).
- **Fix:** (1) `express.json({ limit: "4kb" })`. (2) Validate
  `txSignature` against the base58 Solana signature shape (length 86-88,
  base58 alphabet) *before* it touches any map, Redis, RPC, or log —
  reject with 400 otherwise. (3) Truncate/hash the correlation id used
  for the wire envelope rather than echoing arbitrary client input.
- **ADR-needed?** No — input-validation hardening within existing
  boundaries.

---

## MEDIUM

### C4-X402-04 — JWT `sender`/`amountSol` claims trusted downstream but derived from spoofable verifier; `/protected` echoes attacker-influenced `sender`

- **Severity:** MEDIUM (CRITICAL when chained with C4-X402-01)
- **File:** `src/x402-relay/index.ts:521-527` (`issueAccessToken`),
  `1082-1090` (`/protected` echoes `payment.sender`,
  `payment.amountSol`, `payment.txSignature`)
- **Scenario:** The JWT embeds `sender = accountKeys[0]` and
  `amountSol = transferredSol`. `/protected` returns these to the caller
  and any downstream service consuming the token trusts them as
  "who paid / how much." Because C4-X402-01 lets a caller redeem a
  third party's signature, `paidBy` is attacker-chosen (any tx whose
  fee payer / `accountKeys[0]` they like) while the relay attests it.
  Independently of C4-X402-01: `accountKeys[0]` is the *fee payer*, not
  necessarily the lamport *source* of the transfer — so even for a
  legitimate payment the attested `sender` can be wrong (e.g.
  fee-payer-funded relayer pattern), causing downstream
  authorization/attribution to bind to the wrong principal.
- **Fix:** Derive `sender` from the decoded transfer instruction's
  source account (see C4-X402-01 fix #1), and document that
  `/protected`'s `paidBy` is only as trustworthy as the verifier. Add a
  `jti` claim (logger already mints `newJwtId()` but `issueAccessToken`
  never sets it — see C4-X402-08) for downstream correlation/revocation.
- **ADR-needed?** Folds into the C4-X402-01 ADR (payer binding).

### C4-X402-05 — In-flight verify Promise is cached but not result-validated; a rejected verify Promise is shared across concurrent callers

- **Severity:** MEDIUM
- **File:** `src/x402-relay/index.ts:879-891`
- **Scenario:** `verifyPromise = verifier(txSignature)` is installed in
  `inFlightVerify` (line 882) and awaited by all concurrent callers for
  the same signature. `verifyPaymentOnChain` catches internally and
  resolves (never rejects), so today this is safe — but the contract is
  implicit. Any future verifier (or the injected test verifier, or a
  refactor) that *throws/rejects* causes every concurrent awaiter to
  reject, and the `.finally` (line 886-888) deletes the entry only after
  settle, so a thundering herd that arrives during the rejected window
  all fail together with an unclassified exception that escapes the
  ADR-117 envelope (the throw propagates out of `processPaymentRequest`
  to the unguarded `await` at line 1003 — there is **no try/catch around
  `processPaymentRequest` in the route handler**). Result: a 500 with
  Express's default error body, re-opening the exact raw-exception leak
  ADR-117 closed, plus the redis lock acquired at line 825 is **never
  released** (the release sites at 906/951 are skipped by the throw) —
  leaking the slot for the full `SIGNATURE_TTL_MS`.
- **Fix:** Wrap the `processPaymentRequest` await (line 1003) in
  try/catch that maps to `toErrorEnvelope("INTERNAL", …)` + HTTP 500 and,
  on the redis path, releases the lock with the captured token. Make the
  in-flight cache store the settled result, not the raw Promise, or
  guarantee-by-type that the verifier never rejects.
- **ADR-needed?** No — defensive hardening of the ADR-117 invariant
  (the ADR says "every catch", the route-level catch is missing).

### C4-X402-06 — `GET /verify` and `GET /protected` are not rate-limited; JWT brute-force / oracle surface

- **Severity:** MEDIUM
- **File:** `src/x402-relay/index.ts:737` (`app.use("/pay", rateLimit)`
  scopes the limiter to `/pay` only), `1065-1090`
- **Scenario:** Only `/pay` is rate-limited. `/verify` and `/protected`
  call `verifyAccessToken` (HS256, 32-byte-min secret — strong) with no
  per-IP throttle. While the 32-byte secret floor (AUD-027) makes
  offline brute-force infeasible, the unthrottled endpoints are a free
  online oracle for: token-validity probing, timing analysis of
  `jwt.verify`, and unbounded CPU (HS256 verify) amplification — a
  cheap DoS vector distinct from `/pay`. `/admin/status` (line 1124) is
  also unauthenticated and unthrottled (acknowledged for dashboards,
  but still an unbounded surface).
- **Fix:** Apply `rateLimit` (or a lighter limiter) to `/verify` and
  `/protected`; consider a global fallback limiter.
- **ADR-needed?** No.

### C4-X402-07 — `classifyVerifyException` substring heuristic can misclassify a "not found" RPC error as `PAYMENT_NOT_FOUND` → wrong 402 vs retry signal

- **Severity:** MEDIUM
- **File:** `src/x402-relay/index.ts:390-407`
- **Scenario:** Classification is heuristic on `err.message`
  substrings. The order checks transport first (good), but the
  `not found || signature` branch (line 403) is broad: an RPC provider
  returning `429 Too Many Requests: method getTransaction signature ...`
  or a gateway HTML error page containing the word "signature" is
  classified `PAYMENT_NOT_FOUND` (a definitive "your payment doesn't
  exist, don't retry") when the truth is a transient/rate-limit
  condition the client *should* retry. Combined with C4-X402-02 the
  client gets a definitive-sounding 402 for a transient fault and may
  re-pay. The ADR-117 catch-all default of `INTERNAL` is safe, but the
  `signature` substring (line 403) is too eager — virtually every kit
  RPC error message references the signature argument.
- **Fix:** Tighten to structured fields only (RPC error `code`
  -32xxx / HTTP status) rather than message substrings; default
  ambiguous cases to `RPC_UNAVAILABLE` (retryable) not
  `PAYMENT_NOT_FOUND` (terminal).
- **ADR-needed?** Amend ADR-117 (classification precision is part of
  the envelope contract).

---

## LOW

### C4-X402-08 — `issueAccessToken` never sets `jti`; logger advertises a correlation/revocation handle that does not exist on issued tokens

- **Severity:** LOW
- **File:** `src/x402-relay/index.ts:521-527`; `src/x402-relay/logger.ts:13,89-105`
- **Scenario:** `logger.ts` documents (`@file` header lines 11-13, and
  `newJwtId()` lines 89-96) that "OUT [correlation flows] as the JWT's
  `jti` claim." `issueAccessToken` signs `{ sender, txSignature,
  amountSol }` with no `jti` and never calls `newJwtId()`. The
  documented per-token correlation/revocation primitive is absent, so
  there is no token-level revocation handle and post-incident tracing
  must fall back to `txSignature` (which C4-X402-03 shows is
  attacker-controlled and unbounded). Dead code (`newJwtId`,
  `paymentLogger`'s `jti` param) implies a control that isn't wired.
- **Fix:** Add `jti: newJwtId()` to the signed payload and thread it
  through `paymentLogger`, or remove the misleading doc/`newJwtId`.
- **ADR-needed?** No.

### C4-X402-09 — `txSignature` echoed verbatim as `correlationId` in client-facing error envelope (reflected-input / log-injection vector)

- **Severity:** LOW
- **File:** `src/x402-relay/index.ts:1017`, `340-342`
- **Scenario:** The unvalidated client `txSignature` is returned
  verbatim in the JSON envelope `correlationId` and logged with
  `corr_id` allow-listed in `SAFE_KEYS` (logger.ts:44, bypassing
  `scrubJsonPaths`). An attacker can inject newline/control sequences or
  ANSI escapes (pino-pretty is enabled in non-prod, logger.ts:72-82)
  for log forging / terminal injection in operator consoles, and the
  reflected value (JSON-encoded, so XSS is low) aids fingerprinting.
- **Fix:** Use a server-generated `randomUUID()` as the wire
  `correlationId`; log the (validated, see C4-X402-03) signature
  separately under `corr_id`.
- **ADR-needed?** No (resolved jointly with C4-X402-03 input validation).

### C4-X402-10 — Amount comparison `transferredSol < minAmountSol` uses lossy float; sub-lamport / large-value precision edge

- **Severity:** LOW
- **File:** `src/x402-relay/index.ts:461,463`
- **Scenario:** `transferredSol = Number(transferredLamports) /
  1_000_000_000` then compared `< minAmountSol` (a `parseFloat` of an
  env string, line 43). Lamports are exact `bigint`; converting to JS
  `number` and dividing introduces IEEE-754 error. At normal magnitudes
  (0.01 SOL) this is benign, but the comparison should be done in
  integer lamports against `Math.round(minAmountSol * 1e9)` to remove
  any boundary ambiguity (an attacker paying exactly `minAmount` minus
  1 lamport could, under float rounding, pass). Defense-in-depth, not a
  demonstrated exploit at current params.
- **Fix:** Compare in `bigint` lamports:
  `transferredLamports < requiredLamports` where `requiredLamports`
  is derived once from env as an integer.
- **ADR-needed?** No.

---

## INFO

### C4-X402-11 — Single-instance dedup is fail-safe only with `RELAY_REDIS_URL` set; default deploy is double-spendable across replicas
- **File:** `src/x402-relay/index.ts:90-98,257-262`
- ADR-126 Phase 1 default (`RELAY_REDIS_URL` unset) means two relay
  replicas behind an LB issue duplicate JWTs for one payment. This is
  documented and tracked (ADR-126 Phase 2), restating here because it
  compounds C4-X402-01: spoofable verify × multi-instance = unbounded
  token mint. Recommend Phase 2 promotion be gated on C4-X402-01 fix.

### C4-X402-12 — `RELAY_ADMIN_TOKEN` unset disables drain but `/admin/status` still serves unauthenticated; drain is single-instance
- **File:** `src/x402-relay/index.ts:90-98,1124-1133`
- Documented design (graceful per-instance drain). Noted only so the
  incident-response runbook reviewer confirms the multi-instance drain
  orchestration gap is owned elsewhere (ADR-126).

---

## Summary (≤250 words)

**Severity counts:** CRITICAL 1, HIGH 2, MEDIUM 4, LOW 3, INFO 2.

**Top 3:**

1. **C4-X402-01 (CRITICAL) — spoofable payment verification.**
   `verifyPaymentOnChain` accepts any finalized signature where the
   recipient's *net* balance rose ≥ threshold. It never decodes the
   transfer instruction, never binds the on-chain payer to the HTTP
   caller, and trusts `accountKeys[0]` as "sender." An attacker replays
   any third party's signature (txSignature is unauthenticated client
   input) to mint tokens. All the rigorous AUD-208/209/ADR-126 replay
   hardening sits on top of a verifier that does not actually verify
   the payment. Needs a new ADR (instruction-decode + payer binding).

2. **C4-X402-02 (HIGH) — ADR-117 status inversion.** Every verify
   failure, including `RPC_UNAVAILABLE`/`INTERNAL`, returns HTTP 402.
   Retry libraries and intermediaries key on status, not the envelope
   `code`, so an RPC brown-out is presented to a paid client as
   "payment rejected," inducing honest double-spend (re-payment).
   Amend ADR-117 to map code→status.

3. **C4-X402-03 (HIGH) — unbounded `txSignature` DoS.** No body-size
   limit and no base58/length validation; the raw string becomes a
   Map/Redis key, an RPC arg, and an unredacted log field, enabling
   ~10 GB memory growth and log-volume amplification.

Also notable: missing route-level try/catch (C4-X402-05) re-opens the
ADR-117 raw-exception leak and leaks redis locks on verifier throw.

**Files:** `/home/neo/dev/projects/protocol/src/x402-relay/index.ts`,
`/home/neo/dev/projects/protocol/src/x402-relay/logger.ts`,
`/home/neo/dev/projects/protocol/src/x402-relay/redis-dedup.ts`.

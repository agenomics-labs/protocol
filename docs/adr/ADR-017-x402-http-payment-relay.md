# ADR-017: x402 HTTP Payment Relay

## Status
Accepted

## Date
2026-04-15

## Context
The AEP architecture defines an x402 HTTP Payment Relay as an optional component (Architecture doc, Section 2: Flow 4). The HTTP 402 "Payment Required" status code enables a standard web pattern where agents can pay for API access using on-chain Solana transactions. This bridges the gap between HTTP-based agent APIs and on-chain settlement.

The relay needs to:
- Return 402 responses with payment instructions when no valid token is present
- Verify on-chain SOL transfers match the required payment amount and recipient
- Issue time-bound JWT access tokens upon successful payment verification
- Protect arbitrary HTTP endpoints behind payment gates

## Decision
Implement an Express-based x402 relay (`src/x402-relay/index.ts`) with the following design:

1. **`POST /pay`** - Accepts a Solana transaction signature as payment proof. Verifies the transaction on-chain by checking:
   - Transaction exists and is confirmed
   - Transaction did not fail (no `meta.err`)
   - Recipient received at least the required SOL amount (comparing pre/post balances)
   - Issues a JWT access token with sender, txSignature, and amount claims

2. **`GET /verify`** - Stateless token validation endpoint returning validity and remaining seconds

3. **`requirePayment` middleware** - Express middleware that:
   - Returns 402 with payment instructions (recipient, amount, endpoint, proof format) if no Bearer token
   - Returns 401 if token is invalid/expired
   - Attaches payment payload to request and calls next() if valid

4. **`GET /protected`** - Example protected endpoint demonstrating the payment gate

Configuration is via environment variables: `PAYMENT_RECIPIENT`, `REQUIRED_AMOUNT_SOL`, `JWT_SECRET`, `TOKEN_EXPIRY`.

## Alternatives Considered

### Alternative A: Use SPL token transfers instead of SOL
Rejected for MVP simplicity. SOL transfers are verifiable with balance diffs alone, without needing to decode SPL token instructions. SPL token support can be added later by parsing token transfer instructions.

### Alternative B: Store payment records in a database
Rejected because the JWT itself is the proof of payment. Stateless verification via JWT signature is simpler and avoids database dependencies. The on-chain transaction is the permanent receipt.

### Alternative C: Use webhook-based verification (Helius/Shyft)
Rejected because it adds external dependencies and latency. Direct RPC `getTransaction` is sufficient and works with any Solana RPC endpoint including local validators.

## Consequences

### Positive
- Standard HTTP 402 flow compatible with any HTTP client
- Stateless JWT verification scales horizontally
- On-chain verification provides cryptographic payment proof
- Middleware pattern makes it easy to protect any Express route
- No database required

### Negative
- JWT tokens cannot be revoked before expiry (stateless trade-off)
- SOL-only verification in initial version (no SPL token support)
- Requires the client to make the on-chain transfer before calling `/pay`
- JWT_SECRET must be kept secure; compromise allows token forgery

## Files Changed
- `src/x402-relay/index.ts` - x402 relay implementation
- `src/x402-relay/package.json` - Dependencies (express, jsonwebtoken, @solana/web3.js)

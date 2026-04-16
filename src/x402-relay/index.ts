/** AEAP x402 HTTP Payment Relay - verifies on-chain payments, issues JWT access tokens */
import express, { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = parseInt(process.env.RELAY_PORT || "3200", 10);
const JWT_SECRET = process.env.JWT_SECRET || "aeap-x402-dev-secret-change-in-production";
const TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || "3600", 10);
const PAYMENT_RECIPIENT = process.env.PAYMENT_RECIPIENT || "";
const REQUIRED_AMOUNT_SOL = parseFloat(process.env.REQUIRED_AMOUNT_SOL || "0.01");
const connection = new Connection(RPC_URL, "confirmed");

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
    const tx = await connection.getTransaction(txSignature, {
      commitment: "confirmed",
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
    { expiresIn: TOKEN_EXPIRY_SECONDS }
  );
}

function verifyAccessToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
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

const app = express();
app.use(express.json());

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

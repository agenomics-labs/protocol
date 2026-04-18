/**
 * Vault handler functions for the Agenomics MCP Server.
 * Manages programmable wallets with spending policies.
 */

import {
  loadWallet,
  getConnection,
  getVaultProgram,
  deriveVaultPDA,
  getAssociatedTokenAddressSync,
  parsePublicKey,
  solToLamports,
  lamportsToSol,
  BN,
  PublicKey,
  TOKEN_PROGRAM_ID,
} from "../solana.js";
import { SystemProgram } from "@solana/web3.js";
import {
  requireString,
  requireNumber,
  requirePositiveNumber,
} from "./validation.js";

/**
 * Initialize a new vault for this agent.
 * Seeds: ["vault", authority] -> vault PDA
 */
export async function handleCreateVault(args: Record<string, unknown>) {
  const agentIdentity = parsePublicKey(requireString(args, "agentIdentity"));
  const dailyLimitSol = requirePositiveNumber(args, "dailyLimitSol");
  const perTxLimitSol = requirePositiveNumber(args, "perTxLimitSol");
  const maxTxsPerHour = requireNumber(args, "maxTxsPerHour");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .initializeVault(
      agentIdentity,
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour
    )
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    agentIdentity: agentIdentity.toBase58(),
    policies: { dailyLimitSol, perTxLimitSol, maxTxsPerHour },
    transactionSignature: sig,
  };
}

/**
 * Fetch vault account state from chain.
 */
export async function handleGetVaultInfo(args: Record<string, unknown>) {
  const program = getVaultProgram();
  let vaultAddress: PublicKey;

  if (args.vaultAddress && typeof args.vaultAddress === "string") {
    vaultAddress = parsePublicKey(args.vaultAddress);
  } else {
    const wallet = loadWallet();
    [vaultAddress] = deriveVaultPDA(wallet.publicKey);
  }

  const vault = await (program.account as any).vault.fetch(vaultAddress);
  const conn = getConnection();
  const balanceLamports = await conn.getBalance(vaultAddress);

  return {
    vaultAddress: vaultAddress.toBase58(),
    balanceSol: lamportsToSol(balanceLamports),
    agentIdentity: (vault.agentIdentity as PublicKey).toBase58(),
    authority: (vault.authority as PublicKey).toBase58(),
    paused: vault.paused as boolean,
    spentTodaySol: lamportsToSol(
      (vault.spentTodayLamports as any).toNumber()
    ),
    lastSpendDay: (vault.lastSpendDay as any).toNumber(),
    policies: {
      dailyLimitSol: lamportsToSol(
        (vault.policy as any).dailyLimitLamports.toNumber()
      ),
      perTxLimitSol: lamportsToSol(
        (vault.policy as any).perTxLimitLamports.toNumber()
      ),
      maxTxsPerHour: (vault.policy as any).maxTxsPerHour,
      tokenAllowlist: (vault.policy as any).tokenAllowlist.map(
        (pk: PublicKey) => pk.toBase58()
      ),
      programAllowlist: (vault.policy as any).programAllowlist.map(
        (pk: PublicKey) => pk.toBase58()
      ),
    },
    txsInCurrentWindow: (vault.txsInCurrentWindow as any),
    rateLimitWindowStart: (vault.rateLimitWindowStart as any).toNumber(),
  };
}

/**
 * Transfer SOL from the vault to a recipient.
 */
export async function handleVaultTransfer(args: Record<string, unknown>) {
  const recipientAddress = parsePublicKey(requireString(args, "recipientAddress"));
  const amountSol = requirePositiveNumber(args, "amountSol");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .executeTransfer(new BN(solToLamports(amountSol)))
    .accounts({
      vault: vaultPDA,
      agent: wallet.publicKey,
      recipient: recipientAddress,
      systemProgram: SystemProgram.programId,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    recipient: recipientAddress.toBase58(),
    amountSol,
    transactionSignature: sig,
  };
}

/**
 * Execute an SPL token transfer from the vault.
 * Derives the vault's ATA for the given mint and transfers tokens to the recipient.
 */
export async function handleVaultTokenTransfer(args: Record<string, unknown>) {
  const tokenMintAddress = parsePublicKey(requireString(args, "tokenMintAddress"));
  const recipientTokenAccount = parsePublicKey(requireString(args, "recipientTokenAccount"));
  const amount = requirePositiveNumber(args, "amount");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  // Derive the vault's ATA for this token mint
  const vaultTokenAccount = getAssociatedTokenAddressSync(tokenMintAddress, vaultPDA, true);

  const sig = await program.methods
    .executeTokenTransfer(new BN(amount))
    .accounts({
      vault: vaultPDA,
      agent: wallet.publicKey,
      vaultTokenAccount: vaultTokenAccount,
      recipientTokenAccount: recipientTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    tokenMint: tokenMintAddress.toBase58(),
    recipientTokenAccount: recipientTokenAccount.toBase58(),
    amount,
    transactionSignature: sig,
  };
}

/**
 * Update the vault's spending policy.
 */
export async function handleUpdateVaultPolicy(args: Record<string, unknown>) {
  const dailyLimitSol = requirePositiveNumber(args, "dailyLimitSol");
  const perTxLimitSol = requirePositiveNumber(args, "perTxLimitSol");
  const maxTxsPerHour = requireNumber(args, "maxTxsPerHour");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .updatePolicy(
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour
    )
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    newPolicies: { dailyLimitSol, perTxLimitSol, maxTxsPerHour },
    transactionSignature: sig,
  };
}

/**
 * Pause the vault.
 */
export async function handlePauseVault() {
  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .pauseVault()
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    paused: true,
    transactionSignature: sig,
  };
}

/**
 * Resume the vault.
 */
export async function handleResumeVault() {
  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  const sig = await program.methods
    .resumeVault()
    .accounts({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    paused: false,
    transactionSignature: sig,
  };
}

/**
 * Add/remove token or program from the vault's allowlist.
 *
 * Findings #13/#14: When action is "add_token", callers MUST supply
 * `perTxLimit` and `dailyLimit` in the mint's base units (e.g. 6-decimal
 * USDC → 1_000_000 base units = 1 USDC). The chain now rejects token
 * transfers for any mint without explicit per-mint limits.
 */
export async function handleManageAllowlist(args: Record<string, unknown>) {
  const action = requireString(args, "action");
  const address = parsePublicKey(requireString(args, "address"));

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  let sig: string;
  const accounts = {
    vault: vaultPDA,
    authority: wallet.publicKey,
  };

  switch (action) {
    case "add_token": {
      const perTxLimit = requirePositiveNumber(args, "perTxLimit");
      const dailyLimit = requirePositiveNumber(args, "dailyLimit");
      sig = await program.methods
        .addTokenAllowlist(address, new BN(perTxLimit), new BN(dailyLimit))
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    }
    case "remove_token": {
      sig = await program.methods
        .removeTokenAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    }
    case "add_program":
      sig = await program.methods
        .addProgramAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    case "remove_program":
      sig = await program.methods
        .removeProgramAllowlist(address)
        .accounts(accounts)
        .signers([wallet])
        .rpc();
      break;
    default:
      throw new Error(
        `Unknown action: ${action}. Use add_token, remove_token, add_program, or remove_program.`
      );
  }

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    action,
    address: address.toBase58(),
    transactionSignature: sig,
  };
}

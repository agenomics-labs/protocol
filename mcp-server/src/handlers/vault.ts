/**
 * Vault handler functions for the Agenomics MCP Server.
 * Manages programmable wallets with spending policies.
 */

import {
  loadWallet,
  getConnection,
  getVaultProgram,
  deriveVaultPDA,
  deriveAgentProfilePDA,
  deriveOwnerNoncePDA,
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
 *
 * AUD-008 / PR-J: Strict register-first. The vault context now requires the
 * Registry's `OwnerNonce` PDA at `initialize_vault` time, replacing the old
 * `profile_nonce: u64` argument that callers could supply (and silently
 * brick downstream `agent_profile` lookups by passing a stale value). The
 * `profileNonce` arg is no longer accepted; if a caller is mid-flow and has
 * not yet registered, this call will revert at the on-chain seeds
 * constraint. The SDK's `ensureAgentRegistered(authority)` helper (PR-JJ)
 * will paper over the UX for first-time users; for now the MCP surface
 * surfaces the on-chain failure directly.
 */
export async function handleCreateVault(args: Record<string, unknown>) {
  const agentIdentity = parsePublicKey(requireString(args, "agentIdentity"));
  const dailyLimitSol = requirePositiveNumber(args, "dailyLimitSol");
  const perTxLimitSol = requirePositiveNumber(args, "perTxLimitSol");
  const maxTxsPerHour = requireNumber(args, "maxTxsPerHour");

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);
  // AUD-008 / PR-J: source the profile nonce from the Registry's `OwnerNonce`
  // PDA. Anchor will reject the tx if the account does not exist (i.e. the
  // authority has not yet `register_agent`'d), surfacing the protocol-level
  // register-first invariant.
  const [ownerNoncePDA] = deriveOwnerNoncePDA(wallet.publicKey);

  // ADR-088: see registry handler — `.accountsPartial()` accepts
  // PDA-resolvable accounts (e.g. `vault` here is `pda: ["vault", authority]`).
  const sig = await program.methods
    .initializeVault(
      agentIdentity,
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour
    )
    .accountsPartial({
      vault: vaultPDA,
      authority: wallet.publicKey,
      ownerNonce: ownerNoncePDA,
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

  // ADR-088: typed via `Program<AgentVault>.account.vault`. `policy` is the
  // nested `defined: { name: "spendingPolicy" }` struct with typed fields.
  const vault = await program.account.vault.fetch(vaultAddress);
  const conn = getConnection();
  const balanceLamports = await conn.getBalance(vaultAddress);

  return {
    vaultAddress: vaultAddress.toBase58(),
    balanceSol: lamportsToSol(balanceLamports),
    agentIdentity: vault.agentIdentity.toBase58(),
    authority: vault.authority.toBase58(),
    paused: vault.paused,
    spentTodaySol: lamportsToSol(vault.spentTodayLamports.toNumber()),
    lastSpendDay: vault.lastSpendDay.toNumber(),
    policies: {
      dailyLimitSol: lamportsToSol(vault.policy.dailyLimitLamports.toNumber()),
      perTxLimitSol: lamportsToSol(vault.policy.perTxLimitLamports.toNumber()),
      maxTxsPerHour: vault.policy.maxTxsPerHour,
      tokenAllowlist: vault.policy.tokenAllowlist.map((pk: PublicKey) => pk.toBase58()),
      programAllowlist: vault.policy.programAllowlist.map((pk: PublicKey) =>
        pk.toBase58()
      ),
    },
    txsInCurrentWindow: vault.txsInCurrentWindow,
    rateLimitWindowStart: vault.rateLimitWindowStart.toNumber(),
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

  // ADR-095: the suspension gate requires the agent_profile whose nonce the
  // vault was initialized with. Read vault.profile_nonce so the PDA matches
  // regardless of whether the user ever deregistered + re-registered.
  const vaultAccount = await program.account.vault.fetch(vaultPDA);
  const profileNonce = BigInt(vaultAccount.profileNonce.toString());
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey, profileNonce);

  const sig = await program.methods
    .executeTransfer(new BN(solToLamports(amountSol)))
    .accountsPartial({
      vault: vaultPDA,
      agent: wallet.publicKey,
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
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

  // ADR-095: derive agent_profile from vault.profile_nonce for suspension gate.
  const vaultAccount = await program.account.vault.fetch(vaultPDA);
  const profileNonce = BigInt(vaultAccount.profileNonce.toString());
  const [agentProfilePDA] = deriveAgentProfilePDA(wallet.publicKey, profileNonce);

  const sig = await program.methods
    .executeTokenTransfer(new BN(amount))
    .accountsPartial({
      vault: vaultPDA,
      agent: wallet.publicKey,
      authority: wallet.publicKey,
      agentProfile: agentProfilePDA,
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
 * ADR-069 / AUD-015: Rotate the vault's `agent_identity` hot key.
 *
 * `agent_identity` is the off-chain agent runtime's signing key, distinct
 * from the human-custodied `authority`. This wraps the on-chain
 * `update_agent_identity` ix (gated by `has_one = authority`) so off-chain
 * operators can rotate via the standard MCP surface.
 *
 * Rotation is a pure key-swap: balances, policies, daily-spend counters,
 * and rate-limit counters are intentionally preserved.
 */
export async function handleRotateAgentIdentity(args: Record<string, unknown>) {
  const newAgentIdentity = parsePublicKey(requireString(args, "newAgentIdentity"));

  const wallet = loadWallet();
  const program = getVaultProgram();
  const [vaultPDA] = deriveVaultPDA(wallet.publicKey);

  // Fetch current state so we can return the rotated-from key alongside the
  // rotated-to key — useful for operator audit logs.
  const vaultBefore = await program.account.vault.fetch(vaultPDA);
  const oldAgentIdentity = vaultBefore.agentIdentity.toBase58();

  const sig = await program.methods
    .updateAgentIdentity(newAgentIdentity)
    .accountsPartial({
      vault: vaultPDA,
      authority: wallet.publicKey,
    })
    .signers([wallet])
    .rpc();

  return {
    success: true,
    vaultAddress: vaultPDA.toBase58(),
    authority: wallet.publicKey.toBase58(),
    oldAgentIdentity,
    newAgentIdentity: newAgentIdentity.toBase58(),
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
    .accountsPartial({
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
    .accountsPartial({
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
    .accountsPartial({
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
        .accountsPartial(accounts)
        .signers([wallet])
        .rpc();
      break;
    }
    case "remove_token": {
      sig = await program.methods
        .removeTokenAllowlist(address)
        .accountsPartial(accounts)
        .signers([wallet])
        .rpc();
      break;
    }
    case "add_program":
      sig = await program.methods
        .addProgramAllowlist(address)
        .accountsPartial(accounts)
        .signers([wallet])
        .rpc();
      break;
    case "remove_program":
      sig = await program.methods
        .removeProgramAllowlist(address)
        .accountsPartial(accounts)
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

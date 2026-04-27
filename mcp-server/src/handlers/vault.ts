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
import {
  Ed25519Program,
  Keypair,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import * as crypto from "node:crypto";
// `bs58` is already a transitive dep of `@solana/web3.js`; we import it
// directly via the package.json declaration so the agent_identity secret-key
// decode path doesn't reach into web3.js internals. The dep is pinned in
// `mcp-server/package.json`.
import bs58 from "bs58";
import {
  requireString,
  requireNumber,
  requirePositiveNumber,
} from "./validation.js";

/**
 * ADR-124 (AUD-116 path-a): vault-side domain tag for the proof-of-control
 * signature. MUST stay in lockstep with `VAULT_IDENTITY_BIND_DOMAIN` in
 * `programs/agent-vault/src/lib.rs` (= `b"AEP_VAULT_IDENTITY_BIND_V1\x00"`,
 * 26 ASCII chars + a trailing NUL terminator, 27 bytes total).
 */
const VAULT_IDENTITY_BIND_DOMAIN = Buffer.concat([
  Buffer.from("AEP_VAULT_IDENTITY_BIND_V1", "utf8"),
  Buffer.from([0]),
]);

/**
 * ADR-124 (AUD-116 path-a): Compute the 32-byte bind message that the
 * `agent_identity` private-key holder must sign for `initialize_vault` to
 * succeed. Mirrors `vault_identity_bind_message(authority, agent_identity)`
 * in `programs/agent-vault/src/lib.rs`.
 */
function vaultIdentityBindMessage(
  authority: PublicKey,
  agentIdentity: PublicKey,
): Buffer {
  return crypto
    .createHash("sha256")
    .update(VAULT_IDENTITY_BIND_DOMAIN)
    .update(authority.toBuffer())
    .update(agentIdentity.toBuffer())
    .digest();
}

/**
 * Decode an `agent_identity` secret-key argument supplied by the caller.
 * Accepts either a base58-encoded 64-byte Solana secret key or a JSON-style
 * `number[]` of length 64. Validates length and surfaces a clear error so
 * caller mistakes (wrong format, truncated key) fail loudly rather than
 * silently producing an invalid signature.
 */
function decodeAgentIdentitySecret(raw: unknown): Keypair {
  if (Array.isArray(raw)) {
    if (raw.length !== 64 || !raw.every((n) => typeof n === "number")) {
      throw new Error(
        "agentIdentitySecretKey: expected an array of 64 numbers (Solana secret-key bytes)",
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
  }
  if (typeof raw === "string") {
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(raw);
    } catch {
      throw new Error(
        "agentIdentitySecretKey: expected a base58-encoded 64-byte Solana secret key or a number[64]",
      );
    }
    if (decoded.length !== 64) {
      throw new Error(
        `agentIdentitySecretKey: decoded length ${decoded.length}, expected 64`,
      );
    }
    return Keypair.fromSecretKey(decoded);
  }
  throw new Error(
    "agentIdentitySecretKey: expected a base58 string or a number[64]; received " +
      typeof raw,
  );
}

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
 *
 * ADR-124 / AUD-116 (path-a, cycle-3): proof-of-control. The on-chain
 * `initialize_vault` now requires a 64-byte Ed25519 signature from the
 * holder of `agent_identity`'s private key over
 * `vault_identity_bind_message(authority, agent_identity)`, paired with an
 * `Ed25519Program::verify` instruction in the same transaction.
 *
 * Two operator flows are supported:
 *
 *   1. **Self-bind** (default) — if the caller does NOT supply
 *      `agentIdentitySecretKey`, the handler treats the loaded wallet as
 *      both the vault `authority` AND the `agent_identity`, and uses the
 *      wallet's secret key to sign the bind message. The `agentIdentity`
 *      argument MUST equal `wallet.publicKey` in this mode (it's checked,
 *      not silently overridden, so an operator typo still surfaces).
 *
 *   2. **Operator-managed** — caller supplies `agentIdentitySecretKey`
 *      (base58 64-byte secret key OR `number[64]`) for a distinct
 *      `agent_identity` keypair held off-chain by the operator. The
 *      handler decodes it, verifies the derived pubkey matches the
 *      supplied `agentIdentity` arg, and signs the bind message locally.
 *      Secret material does NOT leave this process — only the resulting
 *      64-byte signature is sent on-chain.
 *
 * The handler does NOT support a "signature-only" mode (where the caller
 * pre-signs the bind message and sends the signature without the secret)
 * because the precompile pubkey/message bytes must match the on-chain
 * handler args exactly; mismatches between caller-pre-signed bytes and the
 * derived bind message are a common source of bugs. The two supported
 * flows construct the bind message and precompile ix server-side.
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

  // ADR-124 (AUD-116 path-a): resolve the agent_identity signer.
  let agentIdentitySigner: Keypair;
  if (args.agentIdentitySecretKey !== undefined) {
    // Operator-managed flow: caller supplied the agent_identity secret.
    agentIdentitySigner = decodeAgentIdentitySecret(args.agentIdentitySecretKey);
    if (!agentIdentitySigner.publicKey.equals(agentIdentity)) {
      throw new Error(
        `agentIdentitySecretKey decodes to pubkey ${agentIdentitySigner.publicKey.toBase58()}, ` +
          `which does not match the supplied agentIdentity ${agentIdentity.toBase58()}. ` +
          "Either pass a matching secret key or omit it to fall back to the wallet self-bind path.",
      );
    }
  } else {
    // Self-bind flow: agent_identity == wallet (the typical dev/test case).
    if (!wallet.publicKey.equals(agentIdentity)) {
      throw new Error(
        `agentIdentity ${agentIdentity.toBase58()} does not match the wallet pubkey ` +
          `${wallet.publicKey.toBase58()}, but agentIdentitySecretKey was not supplied. ` +
          "Either supply the agent_identity secret key (base58 or number[64]) or pass " +
          "the wallet pubkey as agentIdentity for the self-bind flow.",
      );
    }
    agentIdentitySigner = wallet;
  }

  const bindMessage = vaultIdentityBindMessage(wallet.publicKey, agentIdentity);
  // Sign with noble (matches the Rust ed25519 precompile's expected signature
  // shape exactly; the `KeypairSigner` adapter in `handlers-v2/keypair-signer.ts`
  // uses the same path). Solana `Keypair.secretKey` is `[seed(32) || pubkey(32)]`;
  // EdDSA wants the 32-byte seed.
  const signature = Buffer.from(
    ed25519.sign(bindMessage, agentIdentitySigner.secretKey.slice(0, 32)),
  );
  const precompileIx = Ed25519Program.createInstructionWithPublicKey({
    publicKey: agentIdentity.toBuffer(),
    message: bindMessage,
    signature,
  });

  // ADR-088: see registry handler — `.accountsPartial()` accepts
  // PDA-resolvable accounts (e.g. `vault` here is `pda: ["vault", authority]`).
  const sig = await program.methods
    .initializeVault(
      agentIdentity,
      new BN(solToLamports(dailyLimitSol)),
      new BN(solToLamports(perTxLimitSol)),
      maxTxsPerHour,
      Array.from(signature),
    )
    .accountsPartial({
      vault: vaultPDA,
      authority: wallet.publicKey,
      ownerNonce: ownerNoncePDA,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([precompileIx])
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

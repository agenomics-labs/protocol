/**
 * PDA derivation helpers shared across load scenarios.
 *
 * Mirrors the derivation rules used in tests/agent-{registry,vault}.ts and
 * tests/settlement.ts. Keep in sync with the on-chain seed constants when
 * any program seed changes; a drift here surfaces as ConstraintSeeds at
 * the first ix call of a campaign, not as silent mis-routing.
 */
import { PublicKey } from "@solana/web3.js";

export const REGISTRY_PROGRAM_ID = new PublicKey(
  "8VQuBFUdtCapqpEk9moZAnPTq5GbH9Fe6UUeS9jMZtfh",
);
export const VAULT_PROGRAM_ID = new PublicKey(
  "4wjdJPbp59gjUcVsp7gcc8XmcAeWaGBDhNAPz2KKgvwN",
);
export const SETTLEMENT_PROGRAM_ID = new PublicKey(
  "GK8LBYz7LoSxqFPNYjo2hS6aQkRWE3x2GQGXWFu3wvc3",
);

/** ADR-097: agent_profile PDA seeds = [authority, "agent-profile", nonce-le u64]. */
export function deriveAgentProfilePDA(
  authority: PublicKey,
  nonce: bigint = 0n,
): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("agent-profile"), nonceBuf],
    REGISTRY_PROGRAM_ID,
  );
}

/** ADR-097: owner_nonce PDA seeds = [authority, "owner-nonce"]. */
export function deriveOwnerNoncePDA(
  authority: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [authority.toBuffer(), Buffer.from("owner-nonce")],
    REGISTRY_PROGRAM_ID,
  );
}

/** Vault PDA seeds = ["vault", authority]. */
export function deriveVaultPDA(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), authority.toBuffer()],
    VAULT_PROGRAM_ID,
  );
}

/** Escrow PDA seeds = ["escrow", client, provider, task_id-le u64]. */
export function deriveEscrowPDA(
  client: PublicKey,
  provider: PublicKey,
  taskId: bigint,
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(taskId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), client.toBuffer(), provider.toBuffer(), buf],
    SETTLEMENT_PROGRAM_ID,
  );
}

/** Settlement-side singleton PDAs used by approve_milestone CPI plumbing. */
export const PROTOCOL_CONFIG_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol_config")],
  SETTLEMENT_PROGRAM_ID,
)[0];

export const SETTLEMENT_AUTHORITY_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("settlement_authority")],
  SETTLEMENT_PROGRAM_ID,
)[0];

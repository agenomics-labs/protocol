/**
 * ADR-139 — wiring helper for the indexer's reputation-attestor mount.
 *
 * Split from `index.ts` so the indexer's monolith doesn't grow the
 * `@agenomics/reputation-attestor` import directly. Tests can also
 * exercise this helper without booting the full indexer.
 *
 * Production AgentProfile decoder: we read the on-chain account via raw
 * `getAccountInfo` (no Anchor dependency in the indexer process) and
 * decode only the slice of fields the snapshot needs. The account
 * layout is pinned to `programs/agent-registry/src/state.rs` —
 * `AgentProfile`. Any forward-compatible field additions land after
 * `cdp_wallet`, so the prefix-decode is stable across future versions.
 */

import type { Application } from "express";
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
// ADR-091-style guidance: @agenomics/reputation-attestor is ESM-only, and
// the indexer is implicit CJS. We import via dynamic `await import(...)`
// inside the mount fn so the indexer's TS compile (CommonJS module target)
// does not down-emit the import into a `require(...)` that would fail at
// load time. Type-only imports compile away and are safe.
import type {
  AgentProfileSnapshot,
  IssuerKeypair,
} from "@agenomics/reputation-attestor";
import {
  mountReputationAttestor,
  type AgentProfileFetcher,
} from "./reputation-attestor.js";

interface IndexerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

type IndexerRpc = Rpc<SolanaRpcApi>;

/**
 * Try to mount the reputation-attestor issuer on `app`. No-op when issuer
 * env vars are not set. Logs the active mode at INFO level on success.
 *
 * Env vars (also documented on `mountReputationAttestor`):
 *   - REPUTATION_ATTESTOR_KEYPAIR_PATH / _B64 — issuer key material.
 *   - REPUTATION_ATTESTOR_ISSUER_URL — discovery URL in the credential.
 *   - REPUTATION_ATTESTOR_EXPIRY_SECONDS — credential expiry (default 0).
 *   - REPUTATION_ATTESTOR_DISABLE_RATELIMIT — disable rate limiter.
 */
export async function tryMountReputationAttestorFromEnv(
  app: Application,
  rpc: IndexerRpc,
  logger: IndexerLogger,
): Promise<void> {
  const path = process.env.REPUTATION_ATTESTOR_KEYPAIR_PATH;
  const b64 = process.env.REPUTATION_ATTESTOR_KEYPAIR_B64;
  if (!path && !b64) {
    logger.info(
      { adr: "ADR-139", mounted: false },
      "reputation-attestor: no issuer key configured (REPUTATION_ATTESTOR_KEYPAIR_PATH / _B64 unset) — skipping mount",
    );
    return;
  }

  // Dynamic import keeps the ESM-only `@agenomics/reputation-attestor`
  // out of the indexer's CJS resolution graph at module load time.
  const mod: typeof import("@agenomics/reputation-attestor") = await import(
    "@agenomics/reputation-attestor"
  );

  let issuer: IssuerKeypair;
  try {
    issuer = mod.loadIssuerKeypair(process.env);
  } catch (e) {
    logger.warn(
      { adr: "ADR-139", err: e instanceof Error ? e.message : String(e) },
      "reputation-attestor: issuer key load failed; skipping mount",
    );
    return;
  }

  const issuerUrl =
    process.env.REPUTATION_ATTESTOR_ISSUER_URL ?? "http://localhost:3001";
  const expirySeconds = Number.parseInt(
    process.env.REPUTATION_ATTESTOR_EXPIRY_SECONDS ?? "0",
    10,
  );

  const fetcher = new RpcAgentProfileFetcher(rpc);

  mountReputationAttestor({
    app,
    issuer,
    fetcher,
    issuerUrl,
    expirySeconds: Number.isFinite(expirySeconds) && expirySeconds >= 0 ? expirySeconds : 0,
  });

  logger.info(
    {
      adr: "ADR-139",
      mounted: true,
      issuer: issuer.publicKey,
      issuerUrl,
      expirySeconds,
      routes: ["GET /reputation/:agent_id", "GET /reputation/:agent_id/at/:slot"],
    },
    "reputation-attestor mounted",
  );
}

/**
 * Reads `AgentProfile` account bytes from RPC and decodes the
 * reputation-bearing fields. Anchor-independent — uses a hand-rolled
 * Borsh slice tied to the `AgentProfile` Rust struct field order.
 *
 * Layout (relative offsets, NO Anchor discriminator awareness here — we
 * skip the 8-byte discriminator manually):
 *
 *   off    field                                size
 *   0      [Anchor discriminator]               8
 *   8      authority                            32
 *   40     name: String                         u32 LE len + bytes
 *   ...    description: String                  variable
 *   ...    category: String                     variable
 *   ...    capabilities: Vec<String>            variable
 *   ...    pricing_model: PricingModel          u8
 *   ...    pricing_amount: u64                  8
 *   ...    accepted_tokens: Vec<Pubkey>         variable
 *   ...    vault_address                        32
 *   ...    status: AgentStatus                  u8
 *   ...    reputation_score: u64                8
 *   ...    __padding_aud007: [u8; 17]           17
 *   ...    created_at: i64                      8
 *   ...    updated_at: i64                      8
 *   ...    reputation_stake.staked_amount: u64  8
 *   ...    reputation_stake.slash_count: u8     1
 *   ...    bump: u8                             1
 *   ...    manifest_cid: [u8; 64]               64
 *   ...    manifest_hash: [u8; 32]              32
 *   ...    manifest_signature: [u8; 64]         64
 *   ...    manifest_version: u16                2
 *   ...    version: u8                          1
 *   ...    registration_nonce: u64              8
 *   ...    cleared_count: u8                    1
 *   ...    cdp_wallet: Option<[u8; 20]>         1 + 20
 *
 * For the snapshot we need: authority, status (active?), reputation_score,
 * reputation_stake.{staked_amount,slash_count}, manifest_hash,
 * registration_nonce.
 */
export class RpcAgentProfileFetcher implements AgentProfileFetcher {
  constructor(private readonly rpc: IndexerRpc) {}

  async fetchCurrent(
    agentId: string,
  ): Promise<{ snapshot: AgentProfileSnapshot; isActive: boolean } | null> {
    const [info, slot] = await Promise.all([
      this.rpc
        .getAccountInfo(agentId as Address, { encoding: "base64" })
        .send(),
      this.rpc.getSlot({ commitment: "confirmed" }).send(),
    ]);
    if (!info || info.value === null || info.value === undefined) {
      return null;
    }
    const data = info.value.data;
    let bytes: Uint8Array;
    if (Array.isArray(data) && data.length === 2 && data[1] === "base64") {
      bytes = Uint8Array.from(Buffer.from(data[0] as string, "base64"));
    } else {
      throw new Error("unexpected getAccountInfo data shape");
    }
    const decoded = decodeAgentProfileSlice(bytes, agentId);
    const snapshot: AgentProfileSnapshot = {
      agent_id: agentId,
      authority: decoded.authority,
      manifest_hash: decoded.manifest_hash,
      reputation_score: Math.min(100, Math.max(0, Number(decoded.reputation_score))),
      slash_count: decoded.slash_count,
      reputation_stake_lamports: decoded.staked_amount,
      registration_nonce: decoded.registration_nonce,
      snapshot_slot: BigInt(slot.toString()),
      snapshot_timestamp: Math.floor(Date.now() / 1000),
    };
    return { snapshot, isActive: decoded.status === 0 /* Active */ };
  }
}

/**
 * Minimal `AgentProfile` slice decoder — reads only the fields the
 * snapshot needs. Skips the Anchor 8-byte discriminator.
 */
export function decodeAgentProfileSlice(
  bytes: Uint8Array,
  _agentId: string,
): {
  authority: string;
  status: number;
  reputation_score: bigint;
  staked_amount: bigint;
  slash_count: number;
  manifest_hash: string;
  registration_nonce: bigint;
} {
  const r = new BorshSlice(bytes, 8 /* skip Anchor discriminator */);
  const authority = r.pubkey();
  r.string(); // name
  r.string(); // description
  r.string(); // category
  const capLen = r.u32();
  for (let i = 0; i < capLen; i++) r.string();
  r.u8(); // pricing_model
  r.u64(); // pricing_amount
  const acceptedLen = r.u32();
  for (let i = 0; i < acceptedLen; i++) r.skip(32);
  r.skip(32); // vault_address
  const status = r.u8();
  const reputation_score = r.u64();
  r.skip(17); // __padding_aud007
  r.i64(); // created_at
  r.i64(); // updated_at
  const staked_amount = r.u64();
  const slash_count = r.u8();
  r.u8(); // bump
  r.skip(64); // manifest_cid
  const manifest_hash = r.hexBytes(32);
  r.skip(64); // manifest_signature
  r.u16(); // manifest_version
  r.u8(); // version
  const registration_nonce = r.u64();
  // cleared_count + cdp_wallet are not part of the snapshot today; we
  // stop here to avoid hard-coding the trailing struct layout, which
  // future ADRs may extend.
  return {
    authority,
    status,
    reputation_score,
    staked_amount,
    slash_count,
    manifest_hash,
    registration_nonce,
  };
}

// ---------------------------------------------------------------------------
// Internal Borsh-slice reader. Trimmed-down version of the indexer's
// BorshReader, sufficient for `AgentProfile`. We intentionally keep this
// local so the dependency direction stays `index.ts → wire`.
// ---------------------------------------------------------------------------

class BorshSlice {
  private offset: number;
  constructor(private readonly buf: Uint8Array, startOffset = 0) {
    this.offset = startOffset;
  }
  private view(): DataView {
    return new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }
  u8(): number {
    if (this.offset + 1 > this.buf.length) throw new Error("u8 overflow");
    const v = this.buf[this.offset]!;
    this.offset += 1;
    return v;
  }
  u16(): number {
    const v = this.view().getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view().getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = this.view().getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.view().getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  string(): string {
    const len = this.u32();
    const s = new TextDecoder("utf-8").decode(
      this.buf.subarray(this.offset, this.offset + len),
    );
    this.offset += len;
    return s;
  }
  hexBytes(n: number): string {
    const slice = this.buf.subarray(this.offset, this.offset + n);
    if (slice.length !== n) throw new Error(`hexBytes: short read ${slice.length}/${n}`);
    this.offset += n;
    return Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  pubkey(): string {
    const slice = this.buf.subarray(this.offset, this.offset + 32);
    if (slice.length !== 32) throw new Error("pubkey: short read");
    this.offset += 32;
    return base58Encode(slice);
  }
  skip(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new Error(`skip: overflow (${this.offset + n} > ${this.buf.length})`);
    }
    this.offset += n;
  }
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHABET[rem]! + out;
  }
  for (let i = 0; i < zeros; i++) out = "1" + out;
  return out;
}

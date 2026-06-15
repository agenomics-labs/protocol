/**
 * Registry reputation snapshot handler.
 *
 * Read-only — fetches an agent's on-chain `AgentProfile` and composes it with
 * the off-chain ADR-060 capability manifest (validated via
 * `@agenomics/capability-manifest-validator`) and the optional ADR-061 SAS
 * attestation signal (resolved via `@agenomics/sas-resolver`).
 *
 * Implementation follows ADR-061 §4 resolution flow step-for-step:
 *   1. Registry fetch.
 *   2. Manifest-pointer extraction (manifest_cid / manifest_hash /
 *      manifest_signature).
 *   3. Off-chain manifest fetch from an IPFS HTTP gateway.
 *      Validated via `validateManifest(...)` (schema + hash + Ed25519 sig).
 *   4. Optional SAS resolution of `manifest.agent.owner_attestation`.
 *   5. Merge — Registry native values are the authoritative signal; manifest
 *      metadata + SAS reputation are additive advisory overlays.
 *
 * Module loading note (ADR-091): mcp-server is now ESM (NodeNext); the two
 * `@agenomics/*` packages are ESM too. Plain `await import("...")` works
 * end-to-end — the prior `new Function("s", "return import(s);")` shim
 * (workaround for `module: commonjs` rewriting `import()` to `require()`)
 * has been removed. Static `import` would also work, but lazy import keeps
 * the get-agent-reputation handler the only entry point that pays the
 * package-load cost.
 */

import {
  getRegistryProgram,
  getWalletPublicKey,
  deriveAgentProfilePDA,
  parsePublicKey,
  lamportsToSol,
  PublicKey,
} from "../solana.js";
import { createRpc } from "../solana-v2.js";
import {
  formatAgentStatus,
} from "./formatters.js";
import type { IdlAccounts } from "@anchor-lang/core";
import type { AgentRegistry } from "../idl/types.js";
import { serverLogger } from "../util/logger.js";
import {
  boundedFetchBytes,
  BoundedFetchError,
} from "../util/bounded-fetch.js";

// ADR-144 — manifests are KB-scale; cap the IPFS fetch well below the
// helper default and abort on slow/oversize gateways before validation.
const MANIFEST_MAX_BYTES = 256 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;

// CIDv0 (base58btc `Qm…`, 46 chars) or CIDv1 (base32 lowercase `b…`).
// Cheap well-formedness gate applied BEFORE the network call so a
// garbage / oversize-by-construction CID is rejected without a fetch.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/;

// ADR-088: typed AgentProfile shape — `manifest_cid: [u8; 64]` etc. land as
// `number[]` of fixed length, `reputation_score: u64` as `BN`, etc. The
// duck-typed `numLike` / `stringLike` / `byteArrayLike` adapters this file
// used to carry are gone — the IDL now tells us each field's exact type.
// Exported so tests can synthesise fixtures against the same shape.
export type AgentProfileAccount = IdlAccounts<AgentRegistry>["agentProfile"];

const log = serverLogger.child({ handler: "reputation" });

// ESM type surface surfaced through `import type` — safe because type-only
// imports emit no JS, so they cost nothing at runtime.
import type {
  SasResolver as SasResolverClass,
  ResolvedReputation,
} from "@agenomics/sas-resolver";
import type {
  CapabilityManifest,
  ValidationResult,
} from "@agenomics/capability-manifest-validator";

// --------------------------------------------------------------------------
// SAS resolver lifecycle: lazy, single-instance per process.
// --------------------------------------------------------------------------
//
// - Construction is deferred until the first call so the module loads
//   cleanly in environments without SAS configured (tests, dev shells).
// - Missing env vars degrade the resolver to a no-op stub that returns
//   `{ absent: true, reason: 'sas-not-configured' }` for every subject —
//   the action stays functional but surfaces the degraded-mode marker.
// - A warning is emitted exactly once when we fall back to the stub.

interface SasHandle {
  /** Resolve a subject. Mirrors the @agenomics/sas-resolver contract. */
  resolve(
    manifest: { agent: { pubkey: string; owner_attestation?: string } },
    subjectAuthority: string,
  ): Promise<
    | { ok: true; value: ResolvedReputation }
    | { ok: false; error: { code: string; message: string } }
  >;
  /** True when the resolver is configured; false when it's the no-op stub. */
  configured: boolean;
  /** Reason the resolver is a stub (present iff `configured: false`). */
  reason?: string;
}

let _sasHandle: SasHandle | null = null;
let _sasConfigWarned = false;

async function getSasHandle(): Promise<SasHandle> {
  if (_sasHandle) return _sasHandle;

  const schemaPda = process.env.AEP_SAS_SCHEMA_PDA;
  const allowedRaw = process.env.AEP_SAS_ALLOWED_CREDENTIALS;

  if (!schemaPda || !allowedRaw) {
    if (!_sasConfigWarned) {
      _sasConfigWarned = true;
      log.warn(
        {
          AEP_SAS_SCHEMA_PDA: schemaPda ? "set" : "unset",
          AEP_SAS_ALLOWED_CREDENTIALS: allowedRaw ? "set" : "unset",
        },
        "SAS not configured — get_agent_reputation will return absent:true for every subject",
      );
    }
    _sasHandle = {
      configured: false,
      reason: "sas-not-configured",
      async resolve(_manifest, subjectAuthority: string) {
        return {
          ok: true,
          value: {
            subject: subjectAuthority,
            absent: true,
          } as ResolvedReputation,
        };
      },
    };
    return _sasHandle;
  }

  const allowed = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // ADR-091: plain dynamic import works under NodeNext.
  const resolverMod = await import("@agenomics/sas-resolver");
  const allowlist = resolverMod.buildAllowlist(allowed);

  const rpc = createRpc();
  const resolver: SasResolverClass = new resolverMod.SasResolver({
    rpc: rpc as unknown as ConstructorParameters<
      typeof resolverMod.SasResolver
    >[0]["rpc"],
    allowedCredentials: allowlist,
    schemaPda,
  });

  _sasHandle = {
    configured: true,
    async resolve(manifest, subjectAuthority) {
      return resolver.resolve(manifest, subjectAuthority);
    },
  };
  return _sasHandle;
}

// --------------------------------------------------------------------------
// Manifest fetch — naive public-gateway HTTP GET. v1 scope.
// --------------------------------------------------------------------------

/**
 * Default gateway base URL (no trailing `/ipfs` — that is appended per request
 * so `AEP_IPFS_GATEWAY` can be set to any gateway root, e.g. a local Kubo node
 * at `http://localhost:8080`).
 */
const DEFAULT_IPFS_GATEWAY_BASE = "https://ipfs.io";

/**
 * Fetch a manifest body from IPFS via an HTTP gateway.
 *
 * Gateway base is configurable via the `AEP_IPFS_GATEWAY` env var (trailing
 * slashes stripped). The final URL is `${base}/ipfs/${cid}`, so the value
 * must be the gateway root (e.g. `http://localhost:8080` or
 * `https://ipfs.io`), NOT `.../ipfs`. Defaults to `https://ipfs.io`.
 *
 * This is intentionally minimal — no pinning, no caching, no content
 * verification beyond what `validateManifest` performs once the bytes
 * arrive. A production deployment would front this with a pinned gateway
 * or a local IPFS node.
 *
 * Local-node usage (preferred for testing — no rate limits, no propagation
 * delays):
 *
 *   ipfs daemon &                           # starts HTTP gateway on :8080
 *   AEP_IPFS_GATEWAY=http://localhost:8080 \
 *     npm start
 */
async function fetchManifestFromIpfs(
  cid: string,
): Promise<{ bytes: Uint8Array; json: unknown }> {
  // ADR-144: CID well-formedness pre-check. Reject early and cheaply
  // before any network I/O; also tightens the URL surface further.
  if (!CID_RE.test(cid)) {
    throw new Error(
      `manifest CID '${cid}' is not a well-formed CIDv0/CIDv1 ` +
        `(rejected before fetch — ADR-144)`,
    );
  }

  const rawBase = (
    process.env.AEP_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY_BASE
  ).replace(/\/+$/, "");
  // ADR-144: explicit scheme allowlist on the operator-configured gateway.
  if (!/^https?:\/\//i.test(rawBase)) {
    throw new Error(
      `AEP_IPFS_GATEWAY must be http(s); got '${rawBase}' (ADR-144)`,
    );
  }
  const base = rawBase;
  const url = `${base}/ipfs/${encodeURIComponent(cid)}`;

  let buf: Uint8Array;
  try {
    // ADR-144 bounded fetch: timeout + streamed byte cap + redirect:error
    // (the CID is on-chain-attacker-influenceable, so do not chase
    // redirects to attacker-chosen origins). The OOM/hang DoS that was
    // reachable here pre-validation is now closed.
    ({ bytes: buf } = await boundedFetchBytes(url, {
      timeoutMs: MANIFEST_FETCH_TIMEOUT_MS,
      maxBytes: MANIFEST_MAX_BYTES,
      redirect: "error",
    }));
  } catch (e) {
    if (e instanceof BoundedFetchError) {
      throw new Error(
        `IPFS manifest fetch failed for CID ${cid} (${url}): ` +
          `${e.kind} — ${e.message}`,
      );
    }
    throw e;
  }
  const text = new TextDecoder("utf-8").decode(buf);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Manifest body at CID ${cid} is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return { bytes: buf, json };
}

// --------------------------------------------------------------------------
// On-chain Registry adapters.
// --------------------------------------------------------------------------

export interface RegistrySnapshot {
  agentProfileAddress: string;
  authority: string;
  name: string;
  status: string;
  reputationScore: number;
  /** AUD-007 (PR-Q): `totalTasksCompleted` and `avgRating` were removed from
   * the on-chain `AgentProfile`. PR-G had already deleted the only writer
   * (`update_reputation`), making them permanently zero and misleading.
   * Per-task telemetry now belongs exclusively to the indexer. */
  stakedAmountSol: number;
  slashCount: number;
}

export interface ManifestPointer {
  cid: string | null;
  hash: Uint8Array | null;
  signature: Uint8Array | null;
  version: number | null;
}

/**
 * Extract the `AgentProfile` fields the reputation snapshot needs.
 *
 * ADR-088: typed via `IdlAccounts<AgentRegistry>["agentProfile"]`. The
 * old `numLike` / `stringLike` / `byteArrayLike` duck-typed coercers are
 * gone — each manifest field has a known concrete shape from the IDL:
 *   - `manifestCid` is `number[]` of length 64 (Anchor decodes `[u8; 64]`)
 *   - `manifestHash` is `number[]` of length 32
 *   - `manifestSignature` is `number[]` of length 64
 *   - `manifestVersion` is `number` (u16)
 *   - `reputationStake.stakedAmount` is `BN` (u64)
 *   - `reputationStake.slashCount` is `number` (u8)
 *
 * "Manifest absent" semantics (ADR-061 §4 row 4a, lifted to the manifest
 * layer): the Registry zero-pads unset CID / hash / signature; the helpers
 * below trim trailing zeros and return `null` for the all-zero case.
 */
// Exported for tests — see test/reputation-adapter.test.ts. ADR-088 demands
// the typed `IdlAccounts<AgentRegistry>["agentProfile"]` shape; the test
// would have caught the pre-fix `(field as any).toNumber()` regression.
export function adaptRegistryProfile(
  pda: PublicKey,
  profile: AgentProfileAccount,
): { snapshot: RegistrySnapshot; pointer: ManifestPointer } {
  const stake = profile.reputationStake;
  const snapshot: RegistrySnapshot = {
    agentProfileAddress: pda.toBase58(),
    authority: profile.authority.toBase58(),
    name: profile.name,
    status: formatAgentStatus(profile.status),
    reputationScore: profile.reputationScore.toNumber(),
    // AUD-007 (PR-Q): `totalTasksCompleted` and `avgRating` removed.
    stakedAmountSol: lamportsToSol(stake.stakedAmount.toNumber()),
    slashCount: stake.slashCount,
  };

  const pointer: ManifestPointer = {
    cid: decodeManifestCid(profile.manifestCid),
    hash: nonZeroBytes(profile.manifestHash),
    signature: nonZeroBytes(profile.manifestSignature),
    // `manifestVersion === 0` is the on-chain "unset" marker per ADR-060.
    version: profile.manifestVersion > 0 ? profile.manifestVersion : null,
  };

  return { snapshot, pointer };
}

/**
 * Decode the on-chain `manifest_cid` (zero-padded `[u8; 64]`) into a UTF-8
 * string. Returns `null` for the all-zero "manifest absent" sentinel.
 */
function decodeManifestCid(bytes: number[]): string | null {
  const u = Uint8Array.from(bytes);
  const trimmed = trimZeros(u);
  if (trimmed.length === 0) return null;
  return new TextDecoder("utf-8").decode(trimmed);
}

/**
 * Convert a fixed-size on-chain byte array to `Uint8Array`, returning
 * `null` for the all-zero case (the on-chain "unset" sentinel).
 */
function nonZeroBytes(bytes: number[]): Uint8Array | null {
  const u = Uint8Array.from(bytes);
  return isAllZero(u) ? null : u;
}

function isAllZero(u: Uint8Array): boolean {
  for (let i = 0; i < u.length; i++) if (u[i] !== 0) return false;
  return true;
}

function trimZeros(u: Uint8Array): Uint8Array {
  let end = u.length;
  while (end > 0 && u[end - 1] === 0) end--;
  return u.subarray(0, end);
}

// --------------------------------------------------------------------------
// Handler.
// --------------------------------------------------------------------------

export interface AgentReputationSnapshot {
  registry: RegistrySnapshot;
  manifest:
    | {
        cid: string;
        version: number | null;
        name: string;
        agentVersion: string;
        publishedAt: string;
        ownerAttestation: string | null;
      }
    | null;
  sas:
    | (ResolvedReputation & { resolver: "configured" | "stub" })
    | { absent: true; reason: string; subject: string }
    | null;
  freshness: {
    manifestPresent: boolean;
    manifestValidated: boolean;
    sasAttested: boolean;
    sasStale: boolean;
    sasConfigured: boolean;
  };
}

export async function handleGetAgentReputation(
  args: Record<string, unknown>,
): Promise<AgentReputationSnapshot> {
  const program = getRegistryProgram();

  const authorityKey: PublicKey =
    typeof args.agentAddress === "string"
      ? parsePublicKey(args.agentAddress)
      : getWalletPublicKey();

  const [agentProfilePDA] = deriveAgentProfilePDA(authorityKey);
  // ADR-088: typed via `Program<AgentRegistry>.account.agentProfile`.
  const profile = await program.account.agentProfile.fetch(agentProfilePDA);

  const { snapshot, pointer } = adaptRegistryProfile(agentProfilePDA, profile);

  // Row 4a analogue at the manifest layer: no CID means no manifest
  // published. Settlement / Vault still work because they only read Registry
  // state, so we return what we have.
  if (!pointer.cid) {
    return {
      registry: snapshot,
      manifest: null,
      sas: null,
      freshness: {
        manifestPresent: false,
        manifestValidated: false,
        sasAttested: false,
        sasStale: false,
        sasConfigured: Boolean(
          process.env.AEP_SAS_SCHEMA_PDA &&
            process.env.AEP_SAS_ALLOWED_CREDENTIALS,
        ),
      },
    };
  }

  // Manifest integrity check is a protocol invariant — if the pointer is
  // set but hash or signature is missing, that's a hard error (ADR-061 §4
  // steps 2-3).
  if (!pointer.hash || !pointer.signature) {
    throw new Error(
      "AgentProfile has manifest_cid but manifest_hash / manifest_signature " +
        "is missing — on-chain integrity commitment is incomplete.",
    );
  }

  // Step 3 — fetch the manifest body, then validate.
  const { json } = await fetchManifestFromIpfs(pointer.cid);

  const validatorMod = await import("@agenomics/capability-manifest-validator");

  const authorityBytes = new Uint8Array(authorityKey.toBytes());
  const result: ValidationResult = validatorMod.validateManifest({
    manifest: json,
    onChainHash: pointer.hash,
    onChainSignature: pointer.signature,
    authorityPubkey: authorityBytes,
  });

  if (!result.ok) {
    throw new Error(
      `manifest validation failed: ${result.error.code} — ${result.error.message}`,
    );
  }

  // ADR-103 / AUD-201: validator returns canonical Result<T, E> from
  // @agenomics/action-runtime — success branch field is `value` (was
  // `manifest` pre-2026-04-25).
  const manifest: CapabilityManifest = result.value;

  const manifestSummary = {
    cid: pointer.cid,
    version: pointer.version,
    name: manifest.agent.name,
    agentVersion: manifest.agent_version,
    publishedAt: manifest.published_at,
    ownerAttestation: manifest.agent.owner_attestation ?? null,
  };

  // Step 4 — optional SAS signal.
  const sasHandle = await getSasHandle();
  const sasResult = await sasHandle.resolve(
    { agent: manifest.agent },
    authorityKey.toBase58(),
  );

  let sasField: AgentReputationSnapshot["sas"];
  if (!sasResult.ok) {
    // Only SUBJECT_MISMATCH / INVALID_INPUT / INVALID_CONFIG / RPC_ERROR
    // reach this branch. SUBJECT_MISMATCH is a provenance violation; the
    // others indicate transport / configuration bugs. All are surfaced
    // verbatim so the UI can present them distinctly from "absent".
    throw new Error(
      `SAS resolution failed: ${sasResult.error.code} — ${sasResult.error.message}`,
    );
  }
  const sasValue = sasResult.value;
  if (!sasHandle.configured) {
    sasField = {
      absent: true,
      reason: sasHandle.reason ?? "sas-not-configured",
      subject: sasValue.subject,
    };
  } else {
    sasField = { ...sasValue, resolver: "configured" };
  }

  return {
    registry: snapshot,
    manifest: manifestSummary,
    sas: sasField,
    freshness: {
      manifestPresent: true,
      manifestValidated: true,
      sasAttested: Boolean(
        sasHandle.configured && sasValue.attestation !== undefined,
      ),
      sasStale: Boolean(sasValue.stale),
      sasConfigured: sasHandle.configured,
    },
  };
}

// Exported for tests — resets the lazy singleton.
export function __resetSasHandleForTests(): void {
  _sasHandle = null;
  _sasConfigWarned = false;
}

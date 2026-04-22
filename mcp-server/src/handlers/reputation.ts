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
 * Module loading note: the two `@agenomics/*` packages ship as ESM-only, but the
 * mcp-server transpiles to CommonJS. A static `import` would be
 * down-compiled to `require()` and fail at runtime. We therefore load both
 * packages through a `new Function(...)` dynamic-import shim that TypeScript
 * does not rewrite (the shim is the compiled form of `s => import(s)`).
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
  formatPricingModel,
} from "./formatters.js";

// --------------------------------------------------------------------------
// ESM dynamic-import shim (see module header note).
// --------------------------------------------------------------------------

type DynImport = <T = unknown>(specifier: string) => Promise<T>;
// Use `new Function` so tsc (module=commonjs) does not rewrite
// `import()` → `Promise.resolve().then(() => require(...))` at build time.
const dynImport = new Function(
  "s",
  "return import(s);",
) as unknown as DynImport;

// ESM type surface surfaced through `import type` — safe because type-only
// imports emit no JS, so they cost nothing at runtime even from a CJS file.
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
      console.error(
        "[get_agent_reputation] AEP_SAS_SCHEMA_PDA and/or " +
          "AEP_SAS_ALLOWED_CREDENTIALS is unset — running with SAS " +
          "resolution disabled. Every resolve() call returns " +
          "{ absent: true, reason: 'sas-not-configured' }.",
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

  // Dynamic ESM imports — see module header.
  const resolverMod = await dynImport<typeof import("@agenomics/sas-resolver")>(
    "@agenomics/sas-resolver",
  );
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
  const base = (
    process.env.AEP_IPFS_GATEWAY || DEFAULT_IPFS_GATEWAY_BASE
  ).replace(/\/+$/, "");
  const url = `${base}/ipfs/${encodeURIComponent(cid)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `IPFS gateway returned HTTP ${resp.status} for CID ${cid} (${url})`,
    );
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
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

interface RegistrySnapshot {
  agentProfileAddress: string;
  authority: string;
  name: string;
  status: string;
  reputationScore: number;
  totalTasksCompleted: number;
  avgRating: number;
  stakedAmountSol: number;
  slashCount: number;
}

interface ManifestPointer {
  cid: string | null;
  hash: Uint8Array | null;
  signature: Uint8Array | null;
  version: number | null;
}

/**
 * Extract the `AgentProfile` fields the reputation snapshot needs.
 *
 * Some fields (`reputation_stake`) are nested structs per the Anchor IDL;
 * others are optional forward-compat hooks (manifest_cid / manifest_hash /
 * manifest_signature / manifest_version — ADR-060) that may or may not be
 * present in the deployed Registry program. Missing manifest fields are
 * treated as "no manifest published" rather than a hard error (ADR-061 §4
 * row 4a semantics, lifted to the preceding manifest layer).
 */
function adaptRegistryProfile(
  pda: PublicKey,
  profile: any,
): { snapshot: RegistrySnapshot; pointer: ManifestPointer } {
  const stake = profile.reputationStake ?? {};
  const snapshot: RegistrySnapshot = {
    agentProfileAddress: pda.toBase58(),
    authority: (profile.authority as PublicKey).toBase58(),
    name: profile.name as string,
    status: formatAgentStatus(profile.status),
    reputationScore: numLike(profile.reputationScore),
    totalTasksCompleted: numLike(profile.totalTasksCompleted),
    avgRating: (profile.avgRating as number) ?? 0,
    stakedAmountSol: lamportsToSol(numLike(stake.stakedAmount)),
    slashCount: (stake.slashCount as number) ?? 0,
  };

  const pointer: ManifestPointer = {
    cid: stringLike(profile.manifestCid),
    hash: byteArrayLike(profile.manifestHash),
    signature: byteArrayLike(profile.manifestSignature),
    version:
      profile.manifestVersion !== undefined &&
      profile.manifestVersion !== null
        ? numLike(profile.manifestVersion)
        : null,
  };

  return { snapshot, pointer };
}

function numLike(v: unknown): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof (v as any).toNumber === "function") return (v as any).toNumber();
  return Number(v);
}

function stringLike(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.length > 0 ? v : null;
  // Some Anchor IDLs may surface byte-array CIDs. Best-effort decode.
  if (v instanceof Uint8Array) {
    const trimmed = trimZeros(v);
    if (trimmed.length === 0) return null;
    return new TextDecoder("utf-8").decode(trimmed);
  }
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
    const u = Uint8Array.from(v as number[]);
    const trimmed = trimZeros(u);
    if (trimmed.length === 0) return null;
    return new TextDecoder("utf-8").decode(trimmed);
  }
  return null;
}

function byteArrayLike(v: unknown): Uint8Array | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Uint8Array) {
    return isAllZero(v) ? null : v;
  }
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
    const u = Uint8Array.from(v as number[]);
    return isAllZero(u) ? null : u;
  }
  // Buffer (Node) — duck-typed
  if (v && typeof v === "object" && typeof (v as any).length === "number") {
    const u = Uint8Array.from(v as ArrayLike<number>);
    return isAllZero(u) ? null : u;
  }
  return null;
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
  const profile = await (program.account as any).agentProfile.fetch(
    agentProfilePDA,
  );

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

  const validatorMod = await dynImport<
    typeof import("@agenomics/capability-manifest-validator")
  >("@agenomics/capability-manifest-validator");

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

  const manifest: CapabilityManifest = result.manifest;

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

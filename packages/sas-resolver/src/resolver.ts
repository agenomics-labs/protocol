// ADR-064 — `@aeap/sas-resolver` main resolver class.
//
// Implements the ADR-061 §4 resolution flow end-to-end for off-chain
// consumers. Steps 1–3 (Registry fetch + manifest integrity check) are
// out of scope per ADR-061 §8 (those belong to the Registry indexer
// and `@aeap/capability-manifest-validator` respectively); the resolver
// assumes the caller has already validated the manifest.
//
// The §4 failure-mode table is implemented row-for-row in
// `#resolveSingle` below — comments mark each row.
//
// --------------------------------------------------------------------
// Error-handling contract
// --------------------------------------------------------------------
// Most SAS-layer failures degrade to `absent: true` because SAS is
// additive (ADR-061 §4). The one exception is row 4f (subject
// mismatch), which is a HARD error — either an agent mistake or an
// adversarial attempt to borrow another agent's reputation. That
// case returns `err({ code: 'SUBJECT_MISMATCH', ... })` and is
// surfaced to the caller as a `Result<_>` failure, distinct from
// `absent: true`.
//
// INVALID_INPUT / INVALID_CONFIG / RPC_ERROR are the only other
// hard-error shapes; everything else is absorbed into `ResolvedReputation`.

import { z } from "zod";
import type {
  ManifestLike,
  ResolvedReputation,
  ResolverConfig,
  ResolverRpc,
  Result,
  ResolverError,
  AttestationReputation,
} from "./types.js";
import {
  parseAttestationAccount,
  parseReputationData,
  toAttestationReputation,
} from "./schema.js";
import { isAllowed } from "./allowlist.js";

// --------------------------------------------------------------------
// Input validation — zod schemas at the boundary (AEAP project rule:
// "Ensure input validation at system boundaries").
// --------------------------------------------------------------------

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const ManifestInputSchema = z.object({
  agent: z.object({
    pubkey: z.string().regex(BASE58, "agent.pubkey must be base58"),
    owner_attestation: z
      .string()
      .regex(BASE58, "agent.owner_attestation must be base58")
      .optional(),
  }),
});

// --------------------------------------------------------------------
// Stale threshold — 90 days per ADR-061 §6.
// --------------------------------------------------------------------
const STALE_SECONDS = 90 * 86_400;

export class SasResolver {
  readonly #rpc: ResolverRpc;
  readonly #allowed: Set<string>;
  readonly #schemaPda: string;
  readonly #now: () => number;
  readonly #warn: (message: string, details?: unknown) => void;

  constructor(config: ResolverConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("SasResolver: config is required");
    }
    if (!config.rpc) {
      throw new Error("SasResolver: config.rpc is required");
    }
    if (!(config.allowedCredentials instanceof Set)) {
      throw new Error(
        "SasResolver: config.allowedCredentials must be a Set<string>",
      );
    }
    if (typeof config.schemaPda !== "string" || !BASE58.test(config.schemaPda)) {
      throw new Error(
        "SasResolver: config.schemaPda must be a base58 pubkey string",
      );
    }
    this.#rpc = config.rpc;
    this.#allowed = config.allowedCredentials;
    this.#schemaPda = config.schemaPda;
    this.#now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.#warn = config.warn ?? ((m, d) => (d !== undefined ? console.warn(m, d) : console.warn(m)));
  }

  /**
   * Resolve a single agent's SAS-referenced reputation.
   *
   * @param manifest - The caller's already-validated CapabilityManifest
   *   (or any object with an `agent.owner_attestation?` field).
   * @param subjectAuthority - The agent's on-chain authority pubkey,
   *   as fetched from `AgentProfile.authority`. The resolver verifies
   *   the attestation's `subject` matches this value (§4 row 4f).
   * @returns A `Result<ResolvedReputation>`. `ok: true` is the normal
   *   path — check `value.absent`, `value.stale`, `value.attestation`
   *   to interpret. `ok: false` only triggers for hard errors
   *   (SUBJECT_MISMATCH, INVALID_INPUT, INVALID_CONFIG, RPC_ERROR).
   */
  async resolve(
    manifest: ManifestLike,
    subjectAuthority: string,
  ): Promise<Result<ResolvedReputation>> {
    return this.#resolveSingle(manifest, subjectAuthority);
  }

  /**
   * Resolve multiple agents in parallel. Preserves input order in the
   * output array — callers can zip against their original list.
   *
   * Each entry is resolved independently; one entry's failure does not
   * affect the others (each gets its own `Result`).
   */
  async resolveBatch(
    entries: Array<{ manifest: ManifestLike; subjectAuthority: string }>,
  ): Promise<Result<ResolvedReputation>[]> {
    if (!Array.isArray(entries)) {
      throw new Error("resolveBatch: entries must be an array");
    }
    return Promise.all(
      entries.map((e) => this.#resolveSingle(e.manifest, e.subjectAuthority)),
    );
  }

  // ------------------------------------------------------------------
  // Per-entry resolution — ADR-061 §4 rows 4a..4g.
  // ------------------------------------------------------------------
  async #resolveSingle(
    manifest: ManifestLike,
    subjectAuthority: string,
  ): Promise<Result<ResolvedReputation>> {
    // Boundary validation.
    const manifestParsed = ManifestInputSchema.safeParse(manifest);
    if (!manifestParsed.success) {
      return err("INVALID_INPUT", "manifest failed boundary validation", {
        issues: manifestParsed.error.issues,
      });
    }
    if (typeof subjectAuthority !== "string" || !BASE58.test(subjectAuthority)) {
      return err(
        "INVALID_INPUT",
        "subjectAuthority must be a base58 pubkey string",
      );
    }

    const subject = subjectAuthority;
    const attestationPubkey = manifestParsed.data.agent.owner_attestation;

    // Row 4a — owner_attestation unset or empty. Not an error, just
    // "no signal".
    if (!attestationPubkey) {
      return ok({ subject, absent: true });
    }

    // Fetch the SAS attestation account via the RPC.
    // Row 4b — account missing / closed -> absent: true.
    let accountBytes: Uint8Array | null;
    try {
      accountBytes = await this.#fetchAccountData(attestationPubkey);
    } catch (e) {
      // RPC-layer failure — hard error. Distinct from "account not
      // found" (which resolves to null below).
      return err(
        "RPC_ERROR",
        `failed to fetch attestation account ${attestationPubkey}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (accountBytes === null) {
      return ok({ subject, absent: true });
    }

    // Parse the account. A decode failure here covers rows 4b
    // (malformed account) and 4g (data parse failure) — both route
    // to skip-with-warn.
    let raw: ReturnType<typeof parseAttestationAccount>;
    try {
      raw = parseAttestationAccount(accountBytes);
    } catch (e) {
      this.#warn(
        `[sas-resolver] attestation account ${attestationPubkey} is malformed — skipping`,
        { error: e instanceof Error ? e.message : String(e) },
      );
      return ok({ subject, absent: true });
    }

    const schema = encodeBase58(raw.schema);
    const credential = encodeBase58(raw.credential);
    const signer = encodeBase58(raw.signer);
    const accountSubject = encodeBase58(raw.subject);

    // Row 4c — schema mismatch -> skip + warn.
    if (schema !== this.#schemaPda) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} references unsupported schema — skipping`,
        { observed: schema, expected: this.#schemaPda },
      );
      return ok({ subject, absent: true });
    }

    // Row 4d — credential not allowlisted -> skip + warn.
    if (!isAllowed(this.#allowed, credential)) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} uses non-allowlisted credential — skipping`,
        { credential, allowlist_size: this.#allowed.size },
      );
      return ok({ subject, absent: true });
    }

    // Row 4f — subject mismatch. HARD ERROR. This check is before the
    // expiry check on purpose: an expired attestation about the wrong
    // subject is still a provenance violation worth surfacing.
    if (accountSubject !== subject) {
      return err(
        "SUBJECT_MISMATCH",
        `attestation subject does not match agent authority`,
        {
          attestation: attestationPubkey,
          expected: subject,
          observed: accountSubject,
        },
      );
    }

    // Row 4e — expired -> absent + stale. ADR-061 §6: treat expired as
    // absent (silent skip, not hard error) but tag `stale: true` for
    // UX differentiation.
    const now = this.#now();
    if (raw.expiry > 0 && raw.expiry <= now) {
      return ok({ subject, absent: true, stale: true });
    }

    // Row 4g — schema-data parse failure -> skip + warn.
    let data: ReturnType<typeof parseReputationData>;
    try {
      data = parseReputationData(raw.data);
    } catch (e) {
      this.#warn(
        `[sas-resolver] attestation ${attestationPubkey} data did not decode as AEAP_AGENT_REPUTATION_v1 — skipping`,
        { error: e instanceof Error ? e.message : String(e) },
      );
      return ok({ subject, absent: true });
    }

    const attestation: AttestationReputation = toAttestationReputation(data, {
      signer,
      credential,
      expiry: raw.expiry,
    });

    // Stale-by-age per §6 — `last_updated` older than 90 days. Still
    // returned; just flagged so the caller can weight it.
    const resolved: ResolvedReputation = {
      subject,
      attestation,
    };
    if (now - data.last_updated > STALE_SECONDS) {
      resolved.stale = true;
    }
    return ok(resolved);
  }

  /**
   * Fetch an account's raw bytes. Returns `null` if the account does
   * not exist (row 4b). Throws on RPC-layer failure so the caller can
   * distinguish transport errors from "no such account".
   */
  async #fetchAccountData(pubkey: string): Promise<Uint8Array | null> {
    // Duck-typed call into `@solana/kit`'s Rpc. We type `this.#rpc` as
    // `ResolverRpc` (a narrow subset) so the resolver works with
    // either the full Rpc<SolanaRpcApi> from createSolanaRpc() or a
    // test shim. The runtime shape is the same either way: call
    // `.getAccountInfo(addr, opts).send()` and inspect `.value`.
    const rpc = this.#rpc as {
      getAccountInfo: (addr: unknown, opts?: unknown) => { send(): Promise<unknown> };
    };

    // `@solana/kit` expects an Address branded type, but at runtime it
    // is just a base58 string. We accept the string form for mock
    // RPCs in tests; production consumers can wrap with `address()` if
    // they want the stronger type signature, but the resolver itself
    // never inspects the brand.
    const result = (await rpc.getAccountInfo(pubkey, { encoding: "base64" }).send()) as {
      value: AccountInfoResponse | null;
    } | null;

    if (!result || result.value === null || result.value === undefined) {
      return null;
    }

    return decodeAccountData(result.value.data);
  }
}

// --------------------------------------------------------------------
// RPC response shape — only what we inspect.
// --------------------------------------------------------------------
interface AccountInfoResponse {
  data:
    | readonly [string, "base64"]
    | readonly [string, "base58"]
    | string // jsonParsed / base58 direct
    | Uint8Array // tests may hand us bytes directly
    | Array<number>; // rare, but some mocks use number[]
  lamports?: number;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number;
}

function decodeAccountData(
  data: AccountInfoResponse["data"],
): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) {
    // `[b64string, 'base64']` or `[b58string, 'base58']` or number[]
    if (data.length === 2 && typeof data[0] === "string") {
      const [payload, encoding] = data as unknown as [string, string];
      if (encoding === "base64") {
        return base64Decode(payload);
      }
      if (encoding === "base58") {
        return base58Decode(payload);
      }
      throw new Error(`unsupported account data encoding: ${encoding}`);
    }
    if (data.every((n: unknown) => typeof n === "number")) {
      return Uint8Array.from(data as number[]);
    }
    throw new Error("malformed account data tuple");
  }
  if (typeof data === "string") {
    // Older RPC shape: a bare base58 string. Decode.
    return base58Decode(data);
  }
  throw new Error("unrecognized account data shape");
}

// --------------------------------------------------------------------
// Base58 / base64 codec helpers. Kept local (no extra dep) because
// these are the only two encodings the resolver touches.
// --------------------------------------------------------------------

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]!] = i;
  return m;
})();

export function encodeBase58(bytes: Uint8Array): string {
  // Count leading zero-bytes — base58 preserves them as '1' chars.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to big-int, then base58-encode by successive division.
  // For 32-byte pubkeys this is plenty fast; no native dep required.
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

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;

  let num = 0n;
  for (const ch of s) {
    const v = B58_MAP[ch];
    if (v === undefined) {
      throw new Error(`invalid base58 character: ${ch}`);
    }
    num = num * 58n + BigInt(v);
  }

  // Convert back to big-endian bytes.
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

export function base64Decode(s: string): Uint8Array {
  // Node's Buffer.from(s, 'base64') is available in every supported
  // runtime target for this package (Node 20+). Using it avoids
  // atob() inconsistencies across environments.
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(s, "base64"));
  }
  // Fallback for non-Node runtimes.
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --------------------------------------------------------------------
// Result helpers
// --------------------------------------------------------------------
function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}
function err(
  code: ResolverError["code"],
  message: string,
  details?: unknown,
): Result<never> {
  return { ok: false, error: { code, message, details } };
}

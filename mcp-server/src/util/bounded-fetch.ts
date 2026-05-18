// ADR-144 — Bounded external-fetch policy.
//
// Every outbound network fetch from the mcp-server MUST go through this
// helper. It enforces, in one audited choke-point:
//
//   - an `AbortSignal` timeout (default 10s) so a slow-loris response
//     cannot hang the call indefinitely;
//   - a hard response byte cap enforced *during streaming* (not after
//     buffering) so a multi-GB body cannot OOM the process before any
//     validation runs;
//   - a content-type pre-check (opt-in via `expectContentType`);
//   - an explicit redirect policy (default: follow, capped by the
//     platform; callers handling attacker-influenced URLs SHOULD pass
//     `redirect: "error"`).
//
// Ad-hoc `fetch(...).arrayBuffer()` / `.json()` on external input is
// prohibited (CC-4 / C4-MCPEVO-001). Cross-ref ADR-144.

export interface BoundedFetchOptions {
  /** Abort the request after this many ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Hard cap on the response body, enforced while streaming. Bytes read
   * past this bound abort the stream and throw. Default 256 KiB —
   * manifests and indexer JSON are KB-scale; raise explicitly for any
   * legitimately larger payload.
   */
  maxBytes?: number;
  /**
   * If set, the response `Content-Type` must start with one of these
   * (case-insensitive, parameters ignored). Mismatch throws before the
   * body is read.
   */
  expectContentType?: string[];
  /** Redirect policy. Default "follow". Pass "error" for attacker-influenced URLs. */
  redirect?: "follow" | "error" | "manual";
  /** Optional extra request headers. */
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class BoundedFetchError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "timeout"
      | "oversize"
      | "http"
      | "content-type"
      | "network",
    readonly status?: number,
  ) {
    super(message);
    this.name = "BoundedFetchError";
  }
}

/**
 * Fetch `url` under the ADR-144 bounded-fetch policy and return the body
 * as bytes. Throws `BoundedFetchError` on timeout, oversize, non-2xx, or
 * content-type mismatch.
 */
export async function boundedFetchBytes(
  url: string,
  opts: BoundedFetchOptions = {},
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: opts.redirect ?? "follow",
      headers: opts.headers,
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BoundedFetchError(
        `request to ${url} exceeded ${timeoutMs}ms timeout`,
        "timeout",
      );
    }
    throw new BoundedFetchError(
      `network error fetching ${url}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "network",
    );
  }

  if (!resp.ok) {
    throw new BoundedFetchError(
      `${url} returned HTTP ${resp.status} ${resp.statusText}`,
      "http",
      resp.status,
    );
  }

  const contentType = resp.headers.get("content-type");
  if (opts.expectContentType && opts.expectContentType.length > 0) {
    const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
    const allowed = opts.expectContentType.some(
      (t) => ct === t.toLowerCase(),
    );
    if (!allowed) {
      throw new BoundedFetchError(
        `${url} content-type '${contentType ?? "(none)"}' not in ` +
          `[${opts.expectContentType.join(", ")}]`,
        "content-type",
      );
    }
  }

  // Defense-in-depth: reject early if the server advertised an oversize
  // body via Content-Length. The streaming cap below is authoritative
  // (a lying/absent header cannot bypass it).
  const declaredLen = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    throw new BoundedFetchError(
      `${url} declared ${declaredLen} bytes, exceeds cap ${maxBytes}`,
      "oversize",
    );
  }

  const body = resp.body;
  if (!body) {
    // No stream (e.g. empty body) — fall back to a bounded arrayBuffer.
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new BoundedFetchError(
        `${url} body ${buf.byteLength} bytes exceeds cap ${maxBytes}`,
        "oversize",
      );
    }
    return { bytes: buf, contentType };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BoundedFetchError(
          `${url} body exceeded cap ${maxBytes} bytes (streamed)`,
          "oversize",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { bytes: out, contentType };
}

/**
 * Bounded JSON fetch. Applies the byte cap + timeout, then parses the
 * (capped) body as UTF-8 JSON. Use for all indexer / external JSON.
 */
export async function boundedFetchJson<T = unknown>(
  url: string,
  opts: BoundedFetchOptions = {},
): Promise<T> {
  const { bytes } = await boundedFetchBytes(url, opts);
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new BoundedFetchError(
      `body at ${url} is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }`,
      "network",
    );
  }
}

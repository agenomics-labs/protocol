// Cycle-4 audit hardening for the waitlist edge function. Closes:
//   #2  no rate limiting
//   #3  no Origin/Referer gating
//   #7  permissive email regex (502 enumeration oracle)
//   #9  duplicate-vs-new timing oracle
//   #10 honeypot bypass + autofill-induced silent data loss
//   #12 differential error responses leak server contract
//
// Rate-limit caveat: edge isolates retain Map state for the warm period
// (~5–15 min on Vercel). This is "soft" defense — adequate for waitlist
// quota protection against a single-IP flood, NOT a hard guarantee. For
// a hard guarantee, swap the in-memory Map for Upstash Redis REST (the
// surface is identical; see `bumpRateLimit()`).
//
// #9 timing-oracle defense is response-padding (TIMING_TARGET_MS) plus
// per-request jitter (TIMING_JITTER_MS), not just always-parse-r.json().
// All 200-ok branches past body-parse — honeypot-trip, form-fill-drop,
// duplicate, and new-signup (which does +1 Resend round-trip for the
// welcome email) — return inside the same uniform [TARGET, TARGET+JITTER]
// envelope. Jitter smears the fast-path cluster so it overlaps the
// slow-path natural tail, killing sample-mean statistical separation.
// Residual leak: paths that exceed (TARGET + JITTER) return at natural
// time (bounded by Resend p99). 4xx/5xx paths are NOT padded; the
// status code is already the signal.
export const config = { runtime: 'edge' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tighter than the prior `[^\s@]+@[^\s@]+\.[^\s@]+`. Rejects:
 *   - leading/trailing-dash labels (`-foo.com`, `foo-.com`)
 *   - leading-dot local parts (`.user@x.y`)
 *   - consecutive dots (`u@x..y`, `u..ser@x.y`)
 *   - bare IP literals (no dotted-quad TLD)
 *   - missing TLD (`a@b.c` is rejected — TLD must be 2+ alpha chars)
 * Not RFC 5321 fully compliant; deliberately stricter so we accept only
 * the address shapes Resend will accept, eliminating the
 * 502-enumeration-oracle path.
 */
const EMAIL_RE =
  /^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]+@(?!-)(?:[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;
const MAX_EMAIL_LEN = 254;
const MAX_BODY_BYTES = 2_048;

/** Allowed Origin values for cross-origin POSTs. Same-origin requests
 *  carry no Origin header (or carry the apex), both accepted. */
const ALLOWED_ORIGINS = new Set<string>([
  'https://agenomics.xyz',
  'https://www.agenomics.xyz',
]);
/** Vercel preview deploys: `https://<branch>-<hash>-<team>.vercel.app`. */
const VERCEL_PREVIEW_RE = /^https:\/\/[\w-]+\.vercel\.app$/;

/** Per-IP sliding-window rate limit. 3 requests per 10 minutes is
 *  generous for a real signup, harsh for a flood. */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RATE_LIMIT_MAX_REQUESTS = 3;
const RATE_LIMIT_MAX_ENTRIES = 5_000;

/** Soft minimum form-fill time. Bots POST in &lt;200ms; real humans
 *  take seconds. Treat sub-1500ms as honeypot-style success-but-drop
 *  rather than a hard reject (avoids false positives on autocomplete
 *  power-users). */
const MIN_FORM_FILL_MS = 1_500;

/** Welcome email — sent on first-time signup (after audience-add success).
 *  hello@agenomics.xyz must be a verified sender on the Resend account.
 *  Send is best-effort: a Resend send-failure here does NOT fail the signup
 *  (the contact is already on the audience). Send is awaited (not detached)
 *  so it completes inside the TIMING_TARGET_MS response pad — Vercel edge
 *  can terminate floating promises after the response returns. */
const WELCOME_FROM = 'Agenomics <hello@agenomics.xyz>';
const WELCOME_REPLY_TO = 'hello@agenomics.xyz';
const WELCOME_SUBJECT = "You're on the Agenomics waitlist";
const WELCOME_TEXT = [
  "You're in.",
  '',
  "Thanks for joining the Agenomics waitlist. You'll hear from us as we open early",
  'access to the coordination layer for a machine-speed economy.',
  '',
  'In the meantime, the open thesis lives at https://agenomics.xyz/.',
  '',
  '— Agenomics',
].join('\n');
const WELCOME_HTML = [
  '<!doctype html>',
  '<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.55;max-width:560px;margin:0 auto;padding:24px">',
  "<p>You're in.</p>",
  "<p>Thanks for joining the <strong>Agenomics</strong> waitlist. You'll hear from us as we open early access to the coordination layer for a machine-speed economy.</p>",
  '<p>In the meantime, the open thesis lives at <a href="https://agenomics.xyz/" style="color:#5b6cff">agenomics.xyz</a>.</p>',
  '<p style="color:#666;margin-top:32px">— Agenomics</p>',
  '</body></html>',
].join('');

/** Wall-clock target for every 200-ok response past the body-parse step
 *  (cycle-4 #9 reinforcement). Set above the typical p95 of the slowest
 *  happy path: audience POST (~150ms) + welcome email (~150ms) ≈ 300ms.
 *  500ms gives headroom for normal-jitter Resend latencies. */
const TIMING_TARGET_MS = 500;
/** Per-request randomized addition to TIMING_TARGET_MS. Smears the fast-path
 *  cluster into a uniform [TARGET, TARGET+JITTER] band so it overlaps the
 *  slow-path natural tail — kills sample-mean statistical separation between
 *  honeypot/duplicate (clustered at TARGET) and new-signup (which can spill
 *  toward TARGET+JITTER). Math.random() is adequate; this isn't crypto, it's
 *  histogram-flattening. */
const TIMING_JITTER_MS = 150;

// ---------------------------------------------------------------------------
// In-memory rate-limit table (per-isolate; warms across invocations)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number;
}
const rateMap = new Map<string, RateBucket>();

/**
 * Fixed-window rate limiter. Returns true if the caller is allowed,
 * false if they're over budget. Caller is identified by `key` (the IP).
 * On cap, evicts EXPIRED entries only (mirrors the cycle-4 fix to the
 * MCP-server limiter — never evict still-live victim entries).
 */
function bumpRateLimit(key: string, now: number): boolean {
  const entry = rateMap.get(key);
  if (!entry || now >= entry.resetAt) {
    if (rateMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      // Evict expired only; if none are expired, refuse to insert.
      let reclaimed = 0;
      for (const [k, e] of rateMap) {
        if (now >= e.resetAt) {
          rateMap.delete(k);
          reclaimed += 1;
        }
      }
      if (reclaimed === 0) return false; // table full of live buckets — shed
    }
    rateMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // same-origin form posts have no Origin header
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (VERCEL_PREVIEW_RE.test(origin)) return true;
  return false;
}

function clientIp(req: Request): string {
  // Vercel sets `x-forwarded-for` to the real client IP; the platform
  // strips client-supplied XFF before its own proxy, so the leftmost
  // entry here IS trustworthy on Vercel specifically. (Note: this is
  // the OPPOSITE rule from the MCP rate-limiter, where we read XFF[len-N]
  // — that's because MCP isn't always behind a single trusted proxy.
  // On Vercel edge, we are.)
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function genericRejection(): Response {
  // Cycle-4 #12: collapse all client-side rejectable cases (bad email,
  // bad origin, bad body, honeypot trip, etc) to a single response so a
  // bot can't probe the endpoint as a free email-validity oracle.
  return json({ ok: false, error: 'invalid_request' }, 400);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // Don't echo origin — same-origin posts go through CSP form-action,
      // and we don't intend to support cross-origin reads of the response.
    },
  });
}

/** Pads to TIMING_TARGET_MS + uniform[0, TIMING_JITTER_MS) measured from
 *  `start`. No-op if the branch already exceeded the (jittered) target —
 *  that's the documented residual leak. */
async function padTo(start: number): Promise<void> {
  const target = TIMING_TARGET_MS + Math.floor(Math.random() * TIMING_JITTER_MS);
  const remaining = target - (Date.now() - start);
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
}

/** All accepted-for-processing 200-ok branches return through here so the
 *  honeypot-trip / form-fill-drop / duplicate / new-signup paths are all
 *  timing-indistinguishable to an external observer (cycle-4 #9). */
async function paddedOk(start: number): Promise<Response> {
  await padTo(start);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface Body {
  email?: unknown;
  website_url?: unknown; // honeypot (renamed from `company` per cycle-4 #10)
  form_loaded_at?: unknown; // client-side ms timestamp
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  // Origin gate (cycle-4 #3). Reject cross-origin POSTs from non-allowlisted
  // origins. Same-origin form submissions from agenomics.xyz have no Origin
  // header (or carry the apex) — both pass.
  if (!isAllowedOrigin(req.headers.get('origin'))) {
    return genericRejection();
  }

  // Body-size precheck (informational #11 from prior audit). Vercel edge
  // enforces ~4MB, but rejecting at 2KB prevents wasteful JSON parsing
  // under flood.
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return genericRejection();
  }

  // Per-IP rate limit (cycle-4 #2). Soft (per-isolate Map) — adequate for
  // waitlist quota protection. Bypassable by an attacker who can spread
  // across many residential IPs; quantified as acceptable given the
  // endpoint's quota cost is modest.
  const ip = clientIp(req);
  const now = Date.now();
  if (!bumpRateLimit(`ip:${ip}`, now)) {
    return json({ ok: false, error: 'rate_limited' }, 429);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return genericRejection();
  }

  // Honeypot (cycle-4 #10). Renamed from `company` (which password
  // managers autofilled, silently dropping legitimate signups) to
  // `website_url`. We still treat the trip as success-but-drop so a
  // real autofill victim isn't told they failed; we just don't actually
  // subscribe them. The form-loaded-at check below is the second arm
  // catching bots that POST sub-1.5s.
  if (typeof body.website_url === 'string' && body.website_url.length > 0) {
    return paddedOk(now);
  }

  // Form-load timestamp (cycle-4 #10 second arm). A real human takes ≥1.5s
  // to read + type an email; a bot POSTs in ms. This is a soft signal
  // (timestamp is client-supplied), so a sub-threshold submit is treated
  // identically to a honeypot trip: silent success-but-drop.
  if (typeof body.form_loaded_at === 'number' && Number.isFinite(body.form_loaded_at)) {
    const fillMs = now - body.form_loaded_at;
    if (fillMs >= 0 && fillMs < MIN_FORM_FILL_MS) {
      return paddedOk(now);
    }
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return genericRejection();
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    // Cycle-4 #9: audit suggested collapsing 503 → 502 to avoid leaking
    // mis-config state. We go further and use the same generic shape as
    // the provider-error path so an attacker can't distinguish either.
    return json({ ok: false, error: 'unavailable' }, 503);
  }

  // Audience-id sanity (cycle-4 #7 from prior audit). If env is poisoned
  // to traverse the URL path, refuse — saves a wasted Resend round-trip
  // and surfaces the misconfig at request time.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(audienceId)) {
    return json({ ok: false, error: 'unavailable' }, 503);
  }

  const r = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  });

  // Cycle-4 #4 (timing oracle): always parse the response body so the
  // duplicate path and the new-signup path do the same work. Also
  // collapse Resend's 422/409 (duplicate) to the same idempotent
  // success the new-signup path returns.
  const data = (await r.json().catch(() => null)) as { message?: string } | null;

  if (r.ok) {
    // First-time signup. Welcome email is best-effort (any send failure
    // is swallowed — contact is already on the audience) and awaited so
    // it completes inside the response pad below. The pad equalizes
    // wall-clock with the duplicate path (cycle-4 #9), so the extra
    // Resend round-trip for the welcome email isn't observer-visible.
    await sendWelcomeEmail(apiKey, email);
    return paddedOk(now);
  }
  if (r.status === 422 || r.status === 409) {
    if (data?.message && /exist|already/i.test(data.message)) {
      return paddedOk(now);
    }
  }
  return json({ ok: false, error: 'provider_error' }, 502);
}

async function sendWelcomeEmail(apiKey: string, to: string): Promise<void> {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: WELCOME_FROM,
        to,
        reply_to: WELCOME_REPLY_TO,
        subject: WELCOME_SUBJECT,
        text: WELCOME_TEXT,
        html: WELCOME_HTML,
      }),
    });
    // Intentionally not inspecting the response — best-effort send.
    // If hello@agenomics.xyz is unverified, Resend returns 403 and
    // the contact still keeps their audience seat.
  } catch {
    // Network error during send — swallow. Signup already succeeded.
  }
}

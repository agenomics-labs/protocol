export const config = { runtime: 'edge' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

type Body = { email?: unknown; company?: unknown };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400);
  }

  // Honeypot — hidden field a real user never fills. Treat as success silently.
  if (typeof body.company === 'string' && body.company.length > 0) {
    return json({ ok: true });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    return json({ ok: false, error: 'service_unavailable' }, 503);
  }

  const r = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  });

  if (r.ok) return json({ ok: true });

  // Resend returns 422 / 409 on duplicate — idempotent success for the user.
  if (r.status === 422 || r.status === 409) {
    const data = (await r.json().catch(() => null)) as { message?: string } | null;
    if (data?.message && /exist|already/i.test(data.message)) {
      return json({ ok: true });
    }
  }

  return json({ ok: false, error: 'provider_error' }, 502);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

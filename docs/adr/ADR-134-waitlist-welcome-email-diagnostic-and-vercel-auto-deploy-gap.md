# ADR-134: Waitlist welcome-email diagnostic and Vercel auto-deploy gap

## Status

Accepted (with resolution log — see Revisions below)

## Date

2026-05-02

## Context

Commit `17dceb1` ("feat(site): waitlist welcome email + constant-time
response padding") shipped two changes to `site/api/waitlist.ts`:

1. A best-effort welcome email send on first-time signup (Resend
   transactional, `from: hello@agenomics.xyz`).
2. Constant-time response padding (`TIMING_TARGET_MS = 500` +
   `TIMING_JITTER_MS = 150`) across all 200-ok branches past
   body-parse, reinforcing the cycle-4 #9 timing-oracle defense
   (the prior fix only equalized the audience-POST-success
   sub-branch via always-parse-r.json()).

End-to-end verification surfaced **three open issues** which are NOT
fixed in this ADR; they are documented here so the next session
picks them up cleanly.

### Issue A — welcome email never arrives

After deploying `17dceb1` via `vercel --prod` (deployment
`dpl_Af5uv36Da3adGA9Z2HxBiuvzL5sY`), signup at https://agenomics.xyz
returns 200 ok and the form shows `'You're in →'` (`site/app.js:63`).
But the welcome email itself does not arrive at the recipient inbox
(spam folder also empty per user check on 2026-05-02).

The `sendWelcomeEmail` helper at `site/api/waitlist.ts:323-346` (as
shipped in `17dceb1`) deliberately does NOT inspect the Resend
response — failures are swallowed so a Resend send-failure does not
penalize the signup itself (the contact is already on the audience).
That swallowing now means we have **zero observability** into why
the send is failing.

Most likely root causes (in order of probability, none confirmed):

1. **`agenomics.xyz` is not a verified sender domain on the Resend
   account.** Resend returns 403 for sends from unverified domains;
   our catch swallows it. Fix: Resend dashboard → Domains → Add
   `agenomics.xyz` → publish SPF / DKIM / DMARC DNS records → wait
   for verification.
2. Domain verified but DNS records not yet propagated.
3. `from` field format issue — `Agenomics <hello@agenomics.xyz>`
   should be valid; fallback is plain `hello@agenomics.xyz`.

### Issue B — 503 `unavailable` after diagnostic redeploy

A temporary diagnostic patch was applied to `sendWelcomeEmail`
(uncommitted, in working tree) that captures the Resend response
status + body to Vercel runtime logs only on failure. After
redeploying via `vercel --prod` to capture the diagnostic, signup
began returning **HTTP 503 `{"ok":false,"error":"unavailable"}`** —
which means one of:

- `RESEND_API_KEY` env var missing on Vercel production scope, OR
- `RESEND_AUDIENCE_ID` env var missing on Vercel production scope, OR
- `RESEND_AUDIENCE_ID` value fails the `[A-Za-z0-9_-]{8,128}` regex
  at `site/api/waitlist.ts:287`.

This is suspicious because the **previous** deployment of `17dceb1`
returned 200 ok from the same code path. Vercel env vars are
project-wide and persist across deploys, so they should not have
vanished between deploys without explicit user action. Possible
explanations: env vars scoped to Preview only (not Production),
env vars set locally in `.vercel/.env.production.local` but never
pushed, or an out-of-band edit. Diagnostic step: `cd site && vercel
env ls production`.

**2026-05-02 update (sharpened diagnosis):** after reverting the
diagnostic patch (working tree clean, identical to deployed
`17dceb1`) and re-running `vercel --prod`, the new build STILL
returns 503. This rules out the diagnostic patch as the cause and
points strongly at **edge-runtime build-time env-var inlining**:
`waitlist.ts` declares `export const config = { runtime: 'edge' }`,
and edge functions inline `process.env.X` references at build time
rather than reading them per-request. So the first `17dceb1` build
captured env vars that were present at *that* build time; subsequent
builds inline `undefined`. Implication: the env vars were never
properly persisted on the Vercel project — likely uploaded build-
time-only on the original deploy (e.g. via `vercel --build-env` or
a since-deleted `.env.production.local`). The deployment
`dpl_Af5uv36Da3adGA9Z2HxBiuvzL5sY` retains a working bundle and can
be promoted via the Vercel dashboard for immediate recovery while
the persistent env vars are added via `vercel env add`.

### Issue C — Vercel project has no GitHub integration

Confirmed via two independent checks on 2026-05-02:

- `gh api repos/agenomics-labs/protocol/hooks` returns `[]` — zero
  webhooks installed.
- Vercel `get_project` returns no `link` field; only the `claude` and
  `claude-design-import` GitHub Apps are installed on the
  `agenomics-labs` org (not `vercel`).
- Past production deploys all show `gitDirty: "1"` in metadata,
  confirming they were created from CLI (`vercel --prod`) against a
  dirty working tree, not from a git push.

As a result, every push to `main` requires a manual `cd site &&
vercel --prod`. The 7 commits between `3b415a1` and `17dceb1` did not
auto-deploy. This is operational friction, not a bug — the project
was set up CLI-only by design — but it is a future-foot-gun (a push
that the author assumes will deploy will not).

## Decision

Defer all three issues to a follow-up session; document the
diagnostic plan inline so resumption is mechanical, not investigative.

Specifically:
1. **Revert** the uncommitted diagnostic patch on
   `site/api/waitlist.ts` (`git checkout site/api/waitlist.ts`)
   before stopping, so the working tree matches the deployed
   committed code (`17dceb1`) and cannot be partially-deployed by a
   different operator. The diagnostic is fully reproducible from
   this ADR if needed again.
2. Do **not** attempt to fix Issue B (503) without first running
   `vercel env ls production` to confirm whether env vars are
   actually missing — the diagnosis must precede the fix or we risk
   double-setting env vars and clobbering working state.
3. Do **not** wire up Vercel→GitHub auto-deploy until the welcome
   email is verified working — auto-deploy of a broken feature is
   worse than manual deploy of a known-good one.

## Consequences

- **Positive**: working tree returns to clean state matching the
  pushed commit, so any future `vercel --prod` (from any machine /
  operator) deploys exactly what is on `main`. The diagnostic plan
  is now version-controlled rather than living in chat history.
- **Negative**: production currently has a **partially-broken
  feature** — the form returns 503 (per Issue B, after the
  diagnostic redeploy) until either the env vars are restored OR
  another `vercel --prod` is run from a clean working tree (which
  would deploy `17dceb1` exactly, recovering the 200-ok path but
  still without the welcome email actually arriving). The user
  should decide whether to roll back the most-recent deploy via the
  Vercel dashboard before stopping.
- **Follow-ups** (next session, in order):
  1. **Fix Issue B first** (5 min): `cd site && vercel env ls
     production`. If `RESEND_API_KEY` or `RESEND_AUDIENCE_ID` are
     missing on production scope, `vercel env add ...`. Redeploy
     and confirm signups return to 200 ok.
  2. **Fix Issue A** (15 min, depends on DNS): re-apply the
     diagnostic patch (see "Diagnostic patch" section below),
     `vercel --prod`, sign up with a fresh email, read `vercel logs
     <url>` for the `[welcome-email]` line. Apply the fix indicated
     by the Resend status code (almost certainly: verify domain on
     Resend dashboard).
  3. **Verify timing pad behavior** on the live deployment with a
     warm-cache curl loop — was deferred earlier because the
     pre-fix smoke-test data was against stale code.
  4. **Revert the diagnostic patch** once Issue A is confirmed
     resolved; do NOT leave production logging recipient-adjacent
     metadata indefinitely.
  5. **Wire Issue C** (10 min, dashboard-only): install `vercel`
     GitHub App on `agenomics-labs` org
     (https://github.com/apps/vercel/installations/new), then in
     Vercel dashboard → site → Settings → Git → Connect Repository
     → `agenomics-labs/protocol`, production branch `main`. Verify
     by pushing a no-op commit and watching the Vercel dashboard
     for an in-flight build.

## Diagnostic patch (for re-application in step 2 above)

Replace `sendWelcomeEmail` in `site/api/waitlist.ts` with a version
that captures the Resend response status + body to `console.log` on
failure only. Recipient is NOT logged (PII); Resend's standard error
responses for from-address / domain issues echo the FROM address,
not the TO. Diff is +19/−6 lines; full body lives in working-tree
history at the time of this ADR (search `[welcome-email]` token).

After the patch:

```bash
cd site && vercel --prod
# sign up at https://agenomics.xyz with a fresh email
vercel logs https://agenomics.xyz --follow | grep -i welcome-email
```

Expected log line shapes:
- `[welcome-email] resend POST /emails -> 403 Forbidden:
  {"statusCode":403,"message":"The hello@agenomics.xyz domain is
  not verified...","name":"validation_error"}` → Issue A is domain
  verification.
- `[welcome-email] resend POST /emails -> 401 Unauthorized: ...` →
  API key wrong / lacks `emails:send` permission.
- `[welcome-email] resend POST /emails -> 429 ...` → Resend account
  rate limit.
- `[welcome-email] send threw: ...` → network/transport failure
  inside the edge isolate.

## References

- Commit `17dceb1` — feature commit (welcome email + padding).
- Commit `e6ba30f` — cycle-4 hardening (the prior #9 timing-oracle
  closure that this ADR's padding work reinforced).
- `site/api/waitlist.ts` header comment block — full enumeration of
  cycle-4 audit findings closed by the file.
- `site/.vercel/project.json` — project ID `prj_67FRSC0Yyill3zqFUX0z44593l3c`,
  team ID `team_nOESbCSr6hh3fTEXR6Zaoesz`.
- Vercel deployment `dpl_Af5uv36Da3adGA9Z2HxBiuvzL5sY` — last known
  200-ok deployment of `17dceb1` from clean working tree.

## Revisions

### 2026-05-02 (same-day): Issues A & B resolved; Issue C still open

The "defer all three" decision was lifted within the same session.
Final state of the waitlist after resolution:

- **Issue B (503 unavailable) — RESOLVED.** Root cause confirmed via
  Vercel runtime logs and `vercel env ls production` (returned "No
  Environment Variables found"): `RESEND_API_KEY` and
  `RESEND_AUDIENCE_ID` had never been set on the project's production
  scope. The earlier presumption that env vars "vanished between
  deploys" was wrong — they were never there. The misleading "200 ok"
  signals from my smoke tests were because the smoke tests used
  `website_url: "x"` to trigger the honeypot path, which returns
  `paddedOk(now)` BEFORE reaching the env-var check. So the smoke
  tests only proved rate-limiter and origin-check, not env-var
  presence. Fix: `vercel env add RESEND_API_KEY production` +
  `vercel env add RESEND_AUDIENCE_ID production` + `vercel --prod`.
  Verified via runtime logs (200 on real signup at 22:34:50 UTC).

- **Issue A (welcome email never arrives) — RESOLVED.** Root cause
  found via Resend dashboard `/emails` log: 403 from Resend because
  the FROM domain (`agenomics.xyz` apex) was not verified — only
  `mail.agenomics.xyz` (subdomain) was. Compounded by a Porkbun DNS
  publishing error: records were initially added on
  `send.agenomics.xyz` instead of `send.mail.agenomics.xyz` (Porkbun
  Host field is relative, the user dropped the `.mail` segment).
  Fix:
    1. Code change `bafb478`: `WELCOME_FROM` and `WELCOME_REPLY_TO`
       switched from `hello@agenomics.xyz` to
       `hello@mail.agenomics.xyz` to match the verified domain.
    2. Porkbun DNS records corrected: MX + SPF moved to
       `send.mail.agenomics.xyz`, DKIM TXT added at
       `resend._domainkey.mail.agenomics.xyz`, DMARC TXT at
       `_dmarc.agenomics.xyz`.
    3. Resend domain verification flipped to Verified.
  Verified end-to-end: signup → welcome email landed in inbox at
  19:10 local time with sender `Agenomics <hello@mail.agenomics.xyz>`
  and full body intact.

- **Issue C (Vercel auto-deploy gap) — STILL OPEN.** No code change;
  the `vercel` GitHub App still isn't installed on `agenomics-labs`
  org and the Vercel project still has no `link` to a Git repo.
  Every push to `main` continues to require a manual
  `cd site && vercel --prod`. Documented as a foot-gun; defer until
  a multi-author or CI-driven workflow makes manual deploys
  untenable.

### Future apex-verification follow-up

`bafb478` switched the FROM to the subdomain to unblock today.
Long-term cleaner branding wants `hello@agenomics.xyz` (apex). To
revert: verify the apex on Resend (separate domain entry,
publish-and-verify cycle on Porkbun for DKIM + SPF on the apex —
note: apex SPF already has `include:_spf.porkbun.com`, so the new
SPF needs a merged value like `v=spf1 include:_spf.porkbun.com
include:amazonses.com ~all` rather than a second TXT record), then
revert `bafb478` (one-line change to `WELCOME_FROM` /
`WELCOME_REPLY_TO`). No urgency — current setup is fully functional.

### Diagnostic hygiene note

Future smoke-tests against the waitlist endpoint should use a real
email shape (without `website_url`) to actually exercise the env-var
+ Resend path, or this kind of false-200 misdiagnosis will recur.
The honeypot bypass is a feature, not a bug — but it makes
honeypot-trip requests useless as health checks.

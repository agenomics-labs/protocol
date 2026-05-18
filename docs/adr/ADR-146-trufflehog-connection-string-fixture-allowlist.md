# ADR-146: TruffleHog connection-string fixture allowlist

## Status

Accepted

## Date

2026-05-18

## Context

The Secret Scan CI gate (`.github/workflows/ci.yml`) runs the vendored
TruffleHog composite action (`.github/actions/trufflehog/action.yml`)
with `--results=verified,unknown`. TruffleHog's Postgres detector emits
an `unknown`-class result for any connection-string-shaped token it
finds — and under `--results=verified,unknown` an `unknown` result is
blocking. The C4-OFF-04 audit fix (PG transport security; the ADR-128
addendum requiring fail-closed TLS in `src/indexer/postgres-store.ts`)
necessarily *handles* connection strings: the production code contains
`postgres://` / `postgresql://` / `sslmode=` substrings in error
messages and the transport-security doc block, and the unit tests
(`src/indexer/test/aud-128-postgres-store.test.ts`) build DSN fixtures
to exercise `resolvePoolSsl()`. The detector cannot distinguish "code
that parses DSNs as data" from "a leaked DSN secret", so the gate
produces an irreducible false positive on legitimate, secret-free code.
The repository had no allowlist mechanism for this — a real
security-tooling gap that previously forced fixture contortions
(credential-free `.invalid` hosts) which still risked re-flagging on
any future detector tightening. Disabling the scanner globally, or
dropping the `unknown` result class, would erase real coverage across
the whole repository.

## Decision

Connection-string-handling code is allowlisted from TruffleHog via a
minimally-scoped, path-anchored exclude file — never by weakening
detectors or dropping the `unknown` result class. `.github/trufflehog-exclude.txt`
holds one Go-RE2 regex per line, each anchored (`^...$`) to exactly one
file that genuinely handles connection strings as data and contains no
real credentials; the vendored action injects `--exclude-paths` only
when that file is present (the local patch is documented in
`.github/actions/trufflehog/UPSTREAM` so re-vendoring cannot silently
drop it). Adding a path requires an ADR-146-style rationale, proof the
file carries no real secret, and the narrowest possible anchored regex;
the initial entries are the two C4-OFF-04 files only.

## Consequences

- **Positive**: The Secret Scan gate stays a blocking, full-strength
  gate (`--results=verified,unknown`, all detectors) for the entire
  repository except two reviewed, secret-free, path-anchored files;
  the C4-OFF-04 PG-TLS hardening can land without scanner contortions
  and the tooling gap is closed with an auditable, versioned policy.
- **Negative**: A genuinely-leaked Postgres credential placed *inside*
  one of the excluded files would not be caught by TruffleHog; this is
  bounded by the per-file anchoring and the requirement that excluded
  files carry no credentials, but it shifts that residual risk onto
  code review for those two files.
- **Follow-ups**: Keep the exclude list ≤ the connection-string
  surface (re-justify on every addition); re-apply the ADR-146 local
  patch to `action.yml` on each TruffleHog re-vendor; revisit if
  TruffleHog ships first-class inline-suppression so the path
  exclusion can be narrowed to specific lines.

## References

- C4-OFF-04 — cycle-4 security re-audit finding (PG connection had no
  TLS enforcement); ADR-128 transport-security + DB role
  least-privilege addendum.
- ADR-128 — indexer storage-engine selection (the dual-write Postgres
  shadow stream this gate's false positive attaches to).
- `.github/actions/trufflehog/action.yml` — vendored composite action
  (`--exclude-paths` injection point); `.github/actions/trufflehog/UPSTREAM`
  — re-vendor procedure carrying the local-patch re-apply step.
- `.github/trufflehog-exclude.txt` — the scoped, path-anchored regex
  allowlist this ADR governs.

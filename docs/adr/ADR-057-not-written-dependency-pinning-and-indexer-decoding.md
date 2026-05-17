# ADR-057: Not Written — dependency-pinning and indexer-decoding proposals absorbed elsewhere

## Status
Not Written (proposals absorbed by existing ADRs)

## Date
2026-05-16 (backfill disposition)

## Context

ADR-057 was referenced under two **different and mutually unrelated**
titles across two audit documents, and `docs/audits/appendix-adr-governance.md`
explicitly records it as "the only true numbering gap (per ADR-045,
intentional)." This stub closes the gap with the same editorial
discipline applied to [[ADR-045]], [[ADR-055]], and [[ADR-056]].

The two contradictory references:

- `docs/ARCHITECTURE_REAUDIT_2026-04.md` §"Recommended next ADRs"
  (line 219): **"ADR-057: Dependency pinning and upgrade policy"** —
  npm version pinning, action-SHA pinning, automated upgrade cadence.
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md` (line 1099): **"ADR-057:
  Indexer IDL-Driven Event Decoding"** — replace the hand-pinned
  static decoders with IDL-driven decoding.

Neither proposal reached ADR status under the number 057, and the two
proposals describe entirely different subsystems, so no single
coherent decision was ever attached to this number.

**Dependency pinning and upgrade policy** is resolved by existing
ADRs: ADR-089 (`reproducible-installs` — npm workspaces + committed
lockfile, Accepted) governs the install-determinism half, and ADR-114
(`dependabot-dependency-hygiene` — automated dependency hygiene,
Accepted) governs the upgrade-cadence half. Action-SHA pinning and
self-hosted-runner hardening are operational, tracked under ADR-105
and ADR-123. No new architectural decision is needed at 057.

**Indexer IDL-driven event decoding** was effectively *decided
against*: the protocol deliberately retains hand-pinned, test-locked
wire decoders (ADR-082 `indexer-event-coverage` CI gate, Accepted;
reinforced by the AUD-004 / #163 `decoder.test.ts` wire-layout pins).
Pinned decoders with a coverage gate were chosen over IDL-driven
decoding precisely so a silent IDL/program drift fails CI rather than
silently mis-decoding on-chain events. The DEEP_CRITIQUE proposal is
therefore closed by ADR-082's approach, not by a separate ADR.

A related editorial defect surfaced during this backfill:
`docs/adr/ADR-120-offchain-service-test-mandate.md` cited "ADR-057"
three times for x402-relay trust-proxy / rate-limit-eviction / JWT
hardening. That scope belongs to ADR-056 (`x402-relay operational
hardening`, see its References), not ADR-057. The mis-citation is
corrected in the same change that adds this stub.

## Decision

**Do not write ADR-057.** Both originally-referenced proposals are
closed by existing ADRs (ADR-089 + ADR-114 for dependency policy;
ADR-082 for indexer decoding) or by operational work that does not
rise to architectural-decision status. The number remains vacant as
an editorial artifact, consistent with the [[ADR-045]] precedent.

## Consequences

- Closes the last remaining true numbering gap flagged by
  `docs/audits/appendix-adr-governance.md`; the ADR sequence now has
  zero unexplained holes (045/055/056/057 each carry a disposition
  stub; 140 is restored as a Proposed ADR in the same change).
- No open architectural question remains under ADR-057. A future
  runtime IDL-driven decoder, if ever proposed, gets a fresh number.
- Does not affect mainnet readiness or any in-flight work.

## References
- `docs/adr/ADR-045-numbering-gap.md` — precedent for gap-disposition stubs
- `docs/adr/ADR-089-reproducible-installs.md` — install determinism (Accepted)
- `docs/adr/ADR-114-dependabot-dependency-hygiene.md` — upgrade cadence (Accepted)
- `docs/adr/ADR-082-indexer-event-coverage.md` — pinned-decoder coverage gate (Accepted)
- `docs/audits/appendix-adr-governance.md` — records ADR-057 as the only true numbering gap
- `docs/ARCHITECTURE_REAUDIT_2026-04.md` line 219 — original "dependency pinning" reference
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md` line 1099 — original "IDL-driven decoding" reference
- `docs/adr/ADR-056-not-written-x402-hardening-and-globalconfig.md` — true owner of the x402-hardening scope mis-cited as ADR-057 in ADR-120

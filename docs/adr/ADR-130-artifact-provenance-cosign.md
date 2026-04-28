# ADR-130: Sigstore-style artifact provenance for the program `.so`

## Status

Reserved

## Date

2026-04-28

## Context

ADR-080 (`mainnet-deploy-safety-mandates`) is the existing supply-chain
gate. It enforces three things at deploy time:

- **Artifact integrity** — SHA-256 of `dist/program.so` must match the
  hash recorded in `config/AUDIT_REPORT_HASHES` for the corresponding
  program/version pair, refusing deploy on mismatch or placeholder.
- **Tag authenticity** — the `v*-mainnet` git tag must be GPG/SSH
  signed by a key listed in `.github/allowed-signers` (ADR-A4 / A5).
- **Rollback log** — `mainnet-deploy.sh` writes an append-only log
  capturing the deploy attempt for forensic reconstruction.

What is **not** in that stack: a signer-identity attestation bound to
the binary itself. ADR-080 binds *the audit firm's hash file* to the
artifact, and binds *a maintainer's signing key* to the tag — but it
does not produce a detached signature over `dist/program.so` that a
third party can verify out-of-band against a public-good transparency
log (Rekor) or a known signer cert chain (Fulcio). For the protocol's
current threat model — small set of named maintainers, single audit
firm engagement, on-chain BPFLoader as the ultimate authority of
record — the existing two-leg binding is sufficient.

### Why this might change

Three plausible triggers would force a Sigstore-style attestation on
the artifact:

1. **B2B / enterprise consumer requirement.** A counterparty (custody
   provider, integrator, regulated entity) demands SLSA Level 2+
   provenance — i.e., a third-party-verifiable signed statement that
   `dist/program.so` was built by `agenomics-labs/protocol`'s CI from
   commit `<sha>`, signed by a Fulcio-issued cert tied to GitHub OIDC
   identity, with a Rekor inclusion proof.
2. **Regulatory disclosure.** A jurisdiction's binary-attestation /
   software-bill-of-materials requirement (US EO 14028 derivatives,
   EU CRA conformance) becomes a contractual obligation for
   downstream consumers of the protocol.
3. **Multi-team ownership / signing-key fan-out.** The maintainer set
   grows past the point where a hand-curated `.github/allowed-signers`
   is operationally tractable, and short-lived OIDC-issued certs
   (Fulcio) become the better key-management substrate.

None of those triggers are live as of this ADR's date.

## Decision

This ADR is **reserved** — number 130 is held for a future
`cosign sign-blob` / Sigstore-bundle attestation step layered on top
of ADR-080's existing SHA-256 + signed-tag stack, to be ratified only
when one of the triggers in §Context above becomes a contractual or
regulatory obligation. The expected shape of the eventual decision
is: (a) `cosign sign-blob dist/program.so` runs in the
`mainnet-readiness` workflow using GitHub OIDC keyless signing, (b)
the resulting `.sig` + `.bundle` artifacts are uploaded alongside
`program.sha256` and pinned to the release tag, (c) `mainnet-deploy.sh`
gains a verification step that calls `cosign verify-blob` against the
expected GitHub workflow identity before invoking
`solana program deploy` — but the actual decision is **not made
here**, because adopting Sigstore tooling without a forcing function
is overhead the protocol does not currently need.

## Consequences

- **Positive**: The number is captured so the breadcrumb is
  discoverable from the ADR index — a future engineer picking up a
  B2B-driven SLSA ask does not have to re-derive whether the question
  was already considered. The ADR also records the explicit gating
  triggers so promotion from `Reserved` to `Proposed` has a clear
  precondition test rather than a vague "should we?".
- **Negative**: Carries a number in the corpus that does not
  correspond to in-force protocol behavior; readers scanning the ADR
  list have one more entry to skip. Mitigated by the `Reserved`
  status (parser-machine-readable per `ADR-TEMPLATE.md` §1) and by
  this section being explicit that no current code references it.
- **Follow-ups**: None until a §Context trigger fires. When it does,
  promote to `Proposed`, draft the actual decision (CI integration
  point, deploy-script verification hook, cert-identity policy file),
  and reference ADR-080 §Decision as the layer being extended rather
  than replaced.

## Alternatives considered

- **Write a `Proposed` ADR now and let it sit.** Rejected — `Proposed`
  implies the decision is drafted and awaiting ratification, which
  invites status-audit churn and reviewer attention on a non-blocking
  item. `Reserved` is the honest status until a trigger forces
  ratification.
- **Do not write an ADR at all; capture the idea in the roadmap.**
  Rejected — `docs/PRE_MAINNET_ROADMAP.md` is for in-flight
  pre-mainnet work; a deferred-pending-trigger supply-chain idea is
  not in-flight and would clutter the roadmap. ADR corpus is the
  right home for a numbered "considered, not adopted, here's why and
  here's the trigger" entry.
- **Adopt cosign now as belt-and-suspenders.** Rejected — adds a
  Sigstore tool dependency, a new key-management surface (OIDC issuer
  trust, Fulcio cert policy), and a new CI step, all to attest the
  same artifact that ADR-080's SHA-256 + audit-binding + signed-tag
  already binds. The marginal threat closed (third-party verifier
  with no access to `AUDIT_REPORT_HASHES`) is not present in the
  current consumer set.

## References

- `docs/adr/ADR-080-mainnet-deploy-safety-mandates.md` — the existing
  supply-chain gate this ADR would extend, not replace.
- `docs/adr/ADR-122-mainnet-readiness-ci-gate.md` — CI lane where a
  future `cosign sign-blob` step would attach.
- `docs/adr/ADR-123-self-hosted-runner-action-cache-hardening.md` —
  vendoring/provenance discipline for third-party GitHub Actions; a
  related but distinct supply-chain layer (covers the *build
  environment*, not the *artifact*).
- `.github/allowed-signers` — the current signed-tag identity policy
  that would, on promotion, be supplemented (not replaced) by Fulcio
  cert-identity rules for the artifact-signing leg.
- Sigstore project — `https://www.sigstore.dev/`, `cosign sign-blob`
  command reference (verify against the version live at promotion
  time; Sigstore is a moving target).

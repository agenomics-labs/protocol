# ADR-056: Not Written — x402-relay hardening is operational; GlobalConfig governance lives in ADR-053

## Status
Not Written (proposals absorbed by ADR-053 / operational hardening)

## Date
2026-04-22 (backfill disposition)

## Context

ADR-056 was referenced under two different titles across two audit documents:

- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"`: **"x402-relay operational hardening"** — rate-limiter semantics under proxies, JWT verification policy, memory-bounded state. Closes S-offchain-01, -02, -03.
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11.3`: **"Governance via `GlobalConfig` PDA"** — promotes the v2 sketch from ADR-053 into a concrete proposal, starting with the two safety-critical parameters (slash delta, slash threshold).

Neither reached ADR status under the number 056.

**GlobalConfig governance**: **ADR-053 (`compile-time-parameters`, Accepted 2026-04-17)** is the governing ADR. It documents the v1 decision (all protocol parameters as compile-time Rust constants, changes require program redeployment via multisig upgrade authority) and sketches the v2 direction (runtime-updatable `ProtocolConfig` account). The decision ADR-056 would have made — "promote the v2 sketch into a concrete proposal" — is either (a) already in ADR-053 or (b) a future follow-up ADR that would be ADR-075 in the current numbering. No new ADR is needed at 056.

**x402-relay operational hardening**: rate-limiter under proxies, JWT alg pinning, and memory-bounded rate-limit state are **operational/implementation items**, not architectural decisions. They were resolved in code hardening PRs on the mcp-server/x402 relay (trust-proxy config, `rateLimitMap` TTL/size cap, JWT algorithm pinning) per REAUDIT P0 item #1 ("One PR"). ADR-017 (`x402-http-payment-relay`, Accepted) governs the architectural design; operational hardening rides on top and does not require re-opening the architectural decision. Writing ADR-056 to document the hardening would conflate implementation fix PRs with architectural decisions — the ADR discipline reserves ADRs for durable design choices, not for patching-level security polish.

Audit 3 gap #12 flagged ADR-056 as "referenced but not present." Investigation confirms both proposals are closed by existing ADRs (ADR-053, ADR-017) or by operational hardening PRs that do not rise to architectural-decision status.

## Decision

**Do not write ADR-056.** Both original proposals are closed: GlobalConfig governance is ADR-053; x402 hardening is operational on top of ADR-017. The number remains vacant as an editorial artifact.

## Consequences

- No open architectural question remains under ADR-056.
- If a future v2 runtime-updatable `ProtocolConfig` decision is made, it gets a fresh ADR number (likely in the 080+ range) — not this slot.
- If future x402 architectural decisions emerge (e.g., signed-URL authentication, on-chain-nonce payment verification instead of JWT), they get a fresh ADR number — not this slot.
- Does not gate mainnet.

## References
- `docs/adr/ADR-053-compile-time-parameters.md` — GlobalConfig governance roadmap (Accepted, covers what DEEP_CRITIQUE §11.3 proposed as ADR-056)
- `docs/adr/ADR-017-x402-http-payment-relay.md` — x402 architectural design (Accepted)
- `docs/ARCHITECTURE_REAUDIT_2026-04.md "Recommended next ADRs"` — original x402-hardening proposal
- `docs/ARCHITECTURE_DEEP_CRITIQUE.md §11.3` — original GlobalConfig proposal
- `docs/adr/DEEP-AUDIT-2026-04-22.md` Audit 3 gap #12 — current audit trigger
- `docs/ARCHITECTURE_REAUDIT_2026-04.md` P0 item #1 — operational hardening PR that closed S-offchain-01/-02/-03

# ADR-144: Bounded external-fetch policy

## Status

Proposed

## Date

2026-05-17

## Context

Cycle-4 security re-audit (finding CC-4 / C4-MCPEVO-001, refining seed finding
#3 which overstated the risk) found that `mcp-server/src/handlers/reputation.ts:185-211`
fetches an external IPFS manifest with `await resp.arrayBuffer()` and no
timeout, no response size cap, and no content-type/CID-shape check. Manifest
*integrity* is in fact cryptographically bound — the validator verifies an
on-chain hash plus an Ed25519 signature (`validate.ts:125/146`), so field-
poisoning and classic SSRF (`encodeURIComponent(cid)`) are closed. The residual
risk is availability: the unbounded fetch is reachable by any caller via
`get_agent_reputation` against any registered agent, and the OOM/hang occurs
*before* validation. No project-wide policy governs outbound fetches.

## Decision

All outbound network fetches from the mcp-server (and equivalently the relay)
MUST apply a bounded-fetch policy: an `AbortSignal` timeout, a maximum response
byte cap enforced during streaming (not after buffering), a content-type/shape
pre-check, and an explicit redirect policy. A shared helper provides the policy;
ad-hoc `fetch().arrayBuffer()` on external input is prohibited.

## Consequences

- **Positive**: removes the pre-validation OOM/hang DoS primitive; one audited
  choke-point for all external fetches; future fetch sites inherit the bound.
- **Negative**: a shared helper must be introduced and existing fetch call
  sites migrated; very large legitimate manifests need an explicit higher cap.
- **Follow-ups**: implement the bounded-fetch helper; migrate
  `reputation.ts:185-211` and any sibling fetch sites; add a regression test for
  oversize/slow responses; cross-ref CC-4.

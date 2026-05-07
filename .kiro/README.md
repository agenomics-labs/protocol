# Kiro Specs

Per `docs/aep-reflex-tech-spec.md` line 530 (Days 1–2 Foundations), this directory holds one focused spec per surface so each surface owner has a stable, scoped reference document independent of the master spec.

## Layout

| Directory | Surface | Spec |
|---|---|---|
| `specs/surface-1-mobile/` | Seeker mobile UI (Kotlin/Compose, MWA, Seed Vault) | TBD |
| `specs/surface-2-x402-tool/` | `pay_x402_service` MCP tool | See `spec.md` |
| `specs/surface-3-cctp-hook/` | CCTP V2 Hook + relayer fallback | See `spec.md` |
| `specs/surface-4-agentcore/` | AgentCore Runtime agent (Strands + Bedrock) | See `spec.md` |

Each surface directory contains:

- `spec.md` — focused build spec scoped to that surface, extracted from the master.
- `acceptance-criteria.md` — checklist that gates surface-complete state.
- `open-questions.md` — items that need answers before implementation can start (per `docs/aep-reflex-tech-spec.md` §"Open questions").

The master spec (`docs/aep-reflex-tech-spec.md`) is authoritative for cross-surface concerns: interface contracts (IC-1..IC-4), build sequence, performance targets, risk register. Per-surface specs cite the master and stay focused on what their owner needs to ship.

## Authoring rules

- Interface contract changes go in `docs/aep-reflex-tech-spec.md`, not in surface specs. Per-surface specs *consume* contracts, never *redefine* them.
- Material changes to surface scope require an ADR (`docs/adr/`). Lightweight refinements to acceptance criteria can ship in the surface spec directly.
- Each surface spec carries its owner name in the `## Owner` section. `TBD` is acceptable until Day 1 kickoff but blocks any actual implementation work after that.

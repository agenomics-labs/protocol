# Contributing

Short guide for local setup and the checks CI enforces. If something
here disagrees with CI, CI wins — file a patch.

## One-time setup

```sh
# 1. Install the IDL-parity pre-commit hook.
#    Auto-runs `scripts/sync-idl.sh` when programs/**/*.rs|toml is staged
#    and blocks the commit if idl/*.json drifts from the staged baseline.
./scripts/install-hooks.sh

# 2. (Optional but recommended) install the full toolchain so the hook
#    can actually regenerate IDL locally:
rustup toolchain install stable
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.13/install)"   # Solana CLI
cargo install --git https://github.com/coral-xyz/anchor --tag v0.31.1 anchor-cli --locked
```

The hook skips cleanly when `anchor` isn't installed — CI still catches
the drift, you just don't get the local guard.

## Workspace layout

```
.
├── programs/              Anchor programs (Rust, on-chain)
│   ├── agent-vault/
│   ├── agent-registry/
│   └── settlement/
├── idl/                   Committed IDL baseline (ci gate vs. anchor build)
├── mcp-server/            MCP server exposing 27 AEP actions to AI agents
├── sdk/                   SDK packages (consumers + types + runtime)
│   ├── idl/                            ADR-099 — Anchor IDL re-export
│   ├── client/                         ADR-098 — Anchor client wrapper
│   └── action-runtime/                 ADR-088 — Result + defineAction
├── packages/              Publishable TS libraries
│   ├── capability-manifest-validator/   ADR-060
│   └── sas-resolver/                    ADR-061 + ADR-065
├── src/
│   ├── indexer/           Off-chain event indexer
│   └── x402-relay/        HTTP-402 payment relay
├── dashboard/             React + Vite + Tailwind browser UI
├── site/                  agenomics.xyz landing page (Vercel edge)
├── tests/                 Anchor integration tests (live validator)
├── scripts/               Sync / deploy / smoke-test helpers
└── docs/adr/              Architecture Decision Records
```

Inter-package graph:

```
mcp-server  ──(file:)──▶  @agenomics/capability-manifest-validator
                ─────▶    @agenomics/sas-resolver  ──▶  uses @agenomics/capability-manifest-validator types
```

## Common tasks

```sh
# Rust build + unit tests
cargo test --workspace

# Anchor build + IDL diff (matches the CI gate)
anchor build && ./scripts/check-idl.sh

# Anchor integration tests (local validator, 164 cases; 3 pendings per AUD-203)
anchor test

# mcp-server unit tests (node:test + tsx, 383 cases — root postinstall builds workspace deps; mcp-server pretest builds them again as defense-in-depth)
cd mcp-server && npm install && npm test

# Package-level tests
cd packages/capability-manifest-validator && npm install && npm test
cd packages/sas-resolver && npm install && npm test

# Refresh the IDL baseline after a program change
./scripts/sync-idl.sh
```

## CI jobs (what runs on every PR)

All blocking unless noted.

| Job | What it checks |
|---|---|
| Rust Check & Test | `cargo check` + `cargo test --workspace` |
| Security Audit | `cargo audit` (advisory) |
| Anchor Build & IDL Diff | `anchor build` + IDL matches `idl/*.json` |
| Anchor Integration | `anchor test` against local validator (164 cases; self-hosted runner, host-wide concurrency) |
| Secret Scan | TruffleHog (PR diff or full history on main) |
| TypeScript Check (mcp-server) | `tsc --noEmit` after building `@agenomics/*` packages first |
| mcp-server unit tests | `npm test` (node:test + tsx) |
| TypeScript Check (capability-manifest-validator) | `tsc --noEmit` + `npm test` |
| TypeScript Check (sas-resolver) | `tsc --noEmit` + `npm test` |
| TypeScript Check (sdk/idl) | `tsc --noEmit` + `npm test` |
| TypeScript Check (sdk/action-runtime) | `tsc --noEmit` + `npm test` |
| TypeScript Check (sdk/client) | builds `@agenomics/idl` first, then `tsc --noEmit` + `npm test` |
| TypeScript Check (indexer) | `tsc --noEmit` in `src/indexer/` |
| TypeScript Check (x402-relay) | `tsc --noEmit` in `src/x402-relay/` |
| Dashboard build (vite) | `vite build` in `dashboard/` (catches JSX import / wire errors) |
| Workspace build-order check | confirms upstream TS workspaces (`action-runtime`, `validator`, `sas-resolver`, `mcp-server`) build cleanly in dependency order (matches root `postinstall`) |
| Lockfile determinism check | confirms `package-lock.json` is in sync with `package.json` files; rejects PRs with un-regenerated lockfiles |
| Tool parity check | `scripts/check-tools-parity.sh` — confirms the 27 MCP tool names match across `mcp-server/src/tools/index.ts allTools[]`, `dashboard/src/data/programs.js MCP_TOOLS`, and `README.md ## MCP Tools`. Source of truth is `allTools[]`. |
| License parity check | `scripts/check-license-parity.sh` — confirms every workspace `package.json` and every `programs/*/Cargo.toml` declares `Apache-2.0`, matching the repo-root `LICENSE` file (ADR-136). |
| Doc-commands lint | `scripts/check-doc-commands.sh` — rejects user-facing docs (`README`, `SUBMISSION`, `JUDGE_RUNBOOK`, `CONTRIBUTING`, `RELEASE`, `docs/*.md`, `scripts/*.sh\|ts` headers) that contain known-broken executable instructions. Currently denylists: `npm install` / `npm i` / `npx` against the `@agenomics` scope (source-only release per ADR-136 deferred clause), and `npx ts-node` (not a workspace dep — `tsx` is). Patterns + reasons live in the script. Allowlist: `docs/audits/`, `docs/adr/` (history). |
| Program-ID parity check | `scripts/check-program-ids.sh` — confirms the 3 on-chain program IDs are consistent across `programs/*/src/lib.rs declare_id!()` (source of truth, baked into BPF binary), `Anchor.toml`, `README.md`, `SUBMISSION.md`, `SUMMARY.md`, `dashboard/src/data/programs.js`, `JUDGE_RUNBOOK.md`. Drift = published docs advertise a program the deployed binary doesn't match. |
| ADR cross-reference check | `scripts/check-adr-refs.sh` — every `ADR-NNN` reference in ADR docs and user-facing surfaces must point to an existing `docs/adr/ADR-NNN-*.md` file. Allowlists deliberately-skipped ADRs (e.g. `ADR-057`) and proposed-but-unmerged ADRs (PR #68 wave). Broken refs report `file:line` for mechanical fix. |
| Markdown link check | `scripts/check-md-links.sh` — every relative markdown link in user-facing docs must resolve to an existing file on disk. Skips http/https/mailto and bare `#anchor` links. Anchor validity within target files NOT enforced (renderer-specific). |
| Vercel Deploy (site) | runs `vercel pull && vercel build && vercel deploy --prebuilt --prod` from `site/` on push to `site/**`, authenticated via `VERCEL_TOKEN` secret (free-tier alternative to Vercel↔GitHub integration, which is Pro+; one-time setup in workflow header) |

## ADR conventions

- Numbered sequentially. ADR-001 through ADR-065 are taken. Next free: ADR-062, ADR-066, ADR-067 (062 is the MPP wire format placeholder; 066/067 are speculative follow-ups from ADR-061/063).
- `## Status` values: `Proposed` | `Accepted` | `Superseded by ADR-NNN`.
- Structure: Context → Decision (numbered sections) → Alternatives Considered → Consequences (Positive/Negative/Neutral) → Open items → References.
- Cross-reference with `docs/adr/ADR-NNN-*.md` (not web URLs).

## Commit message style

Conventional Commits. `feat(scope):`, `fix(scope):`, `docs(adr):`, `ci:`, `test:`, `infra:`, `chore:`. Scopes we use: `mcp-server`, `sas-resolver`, `agent-registry`, `settlement`, `preflight`, `pipeline`, `action`, `adr`. Keep the summary under 72 chars; wrap the body at 72.

## PRs

- Draft until tests pass locally.
- Body must include: scope, what's deferred, test plan checkboxes.
- Merge strategy: **squash**. Branches auto-delete on merge.
- Never force-push to `main`. Never bypass the pre-commit hook with `--no-verify` (CI will reject anyway).

## Publishing the TS packages

Not currently automated. When we're ready:

```sh
cd packages/capability-manifest-validator && npm version patch && npm publish --access public
cd packages/sas-resolver                  && npm version patch && npm publish --access public
```

Both are scoped under `@agenomics/`. Bump the `file:` dep in
`mcp-server/package.json` to the published version once published.

## Things worth flagging when opening a PR

- Program ADRs that touch `AgentProfile` account space — update `AgentProfile::SPACE` and the anchor tests that init profiles.
- New preflight gates — update ADR-058 §2.1 (single source of truth), `types/capability.ts`, `pipeline/preflight-types.ts` context, `pipeline/preflight.ts` dispatch, and the relevant action declarations.
- New MCP actions — update `src/actions/index.ts`, add a hand-written Tool descriptor in `src/tools/` if you want byte-identical `list_tools` wire output, and update the snapshot-count assertion in `test/action-shape.test.ts`.
- New `file:` workspace deps — update the `typescript-check-mcp` and `mcp-server-tests` jobs in `ci.yml` to build the referenced package first.
- Adding a Kit-native-only feature to `mcp-server/src/handlers-v2/` — see ADR-133 §"Triggers" for the wave-reopen criteria. The handlers-v2 migration is paused at ~4 % (1 / 27 actions) per ADR-133; a Kit-only feature is one of the five explicit triggers that should reopen the wave decision rather than ship under the deferral.

# Branch & Stash Triage — 2026-05-03

Decision log for the local-branch + stash cleanup done before
clone-out. Every local-only artifact got either (a) preserved as a
remote branch with a `stash/` or `snapshot` prefix, or (b) explicitly
dropped with reasoning.

Every dropped stash is recoverable for ~14 days via
`git fsck --lost-found` if anything turns out to have been wanted.

## Audit context

Pre-cleanup state:
- 1 local branch (`audit-project-state-gQC4Z`) with 1 unpushed
  commit `aac6eb7` and a force-pushed-divergent remote
- 19 local stashes accumulated over months of parallel-agent work
- main itself was clean and synced

Goal: leave the local checkout clean enough that `git clone` from
another machine produces an equivalent working state, with no silently-
lost work.

## Decision matrix

### Local commit

| Item | Decision | New location |
|---|---|---|
| `aac6eb7 docs(adr): propose DX overhaul wave (ADR-134..140)` (on `audit-project-state-gQC4Z`) | **KEEP** | Pushed as `origin/dx-overhaul-wave-snapshot` |

**Reasoning.** Substantive 7-ADR design proposal (Codama clients,
Zod-MCP unification, Apache-2.0 + npm public, llms.txt docs,
@agenomics/react, create-agenomics-app, ADR-140). The remote
`claude/audit-project-state-gQC4Z` branch was force-pushed to a
different SHA (`0173f5c`), so this commit's content was not on remote
in any form. Preserved as a clean snapshot branch.

**ADR number conflict to resolve when reviewed:** the proposed ADR-134
(Codama clients) collides with the already-shipped ADR-134
(waitlist welcome-email). When picking up the DX wave, renumber
proposals 134-140 → e.g. 141-147 to avoid the collision. The doc
content is good; only the numbering needs a re-key.

After preserving as snapshot, the local `audit-project-state-gQC4Z`
branch was deleted (commit reachable via `dx-overhaul-wave-snapshot`).

### Stashes — KEPT (preserved as remote branches)

| Stash | Original message | New branch | Why kept |
|---|---|---|---|
| `stash@{0}` | "AUD-206 wave-12 keep-index: peer indexer work parked while my commit lands" | `origin/stash/00-aud-206-peer-indexer` | 700+ line diff across `idl/`, `programs/agent-registry/`, `sdk/idl/`, `src/indexer/`. Word "parked" (vs "abandoned") + the wave-12 phase label suggested intentional pause, not write-off. AUD-206 is closed in main (commit `2a2520f`), but this stash captured a separate sub-stream. Lossy to drop — preserved for triage. |
| `stash@{15}` | "WIP: parallel agent stomped my branch" (on `refactor/anchor-types-mcp-server`) | `origin/stash/15-anchor-types-mainnet-deploy` | 1000+ line diff including a 729-line `scripts/mainnet-deploy.sh` rewrite. mainnet-deploy.sh in main is now 743 lines (likely landed via different commits), so this is *probably* superseded — but the size warranted preservation as recovery insurance. |

**Quirk to know:** the snapshot branches contain some files that are
gitignored on main (e.g., `site/.vercel/project.json`) because those
files were tracked at stash-creation time. Not a secrets leak — these
are public identifiers. If you later cherry-pick from these branches
into main, exclude the `.vercel/`, `dist/`, `node_modules/` paths.

### Stashes — DROPPED (verified superseded by main)

All 17 dropped stashes are recoverable for ~14 days via:

```bash
git fsck --lost-found
# Look for "dangling commit" lines; for each interesting one:
git stash store -m "recovered from fsck" <sha>
```

| Stash | Original message | Why dropped |
|---|---|---|
| `stash@{1}` | "On main: aud-203-attempt-3" | AUD-203 closed in main (commits `3e8a724`, `f0efc00`). Multiple `aud-203-*` stashes confirm parallel-attempt pattern; one attempt landed, the rest are exploration crash-saves. |
| `stash@{2}` | "On main: aud-203-keep-index-clean" | Same supersession as `{1}`. The 240-line `programs/settlement/src/contexts.rs` diff in this stash is identical to several others — common pattern of parallel attempts. |
| `stash@{3}` | "On main: aud-203-second-stash" | Same supersession as `{1}`. |
| `stash@{4}` | "On main: aud-203-peer-changes-stash" | Same supersession as `{1}`. Composite of peer changes during AUD-203 work; landed via the AUD-203 commits. |
| `stash@{5}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Architecture audit from 2026-04-25 produced concrete findings that landed as commits. The 8 stashes on this branch (5-12) are exploration crash-saves; if anything was load-bearing it landed. |
| `stash@{6}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. Tiny 16-line diff. |
| `stash@{7}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. Net-deletion-heavy — looks like reorganization in flight. |
| `stash@{8}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. 55-line deletion of contexts.rs — unfinished refactor. |
| `stash@{9}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. 51-line deletion of lib.rs. |
| `stash@{10}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. Most comprehensive of the 8 (all four files), but still WIP exploration. |
| `stash@{11}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. 18-line addition only. |
| `stash@{12}` | "WIP on chore/architecture-audit-2026-04-25: 6da715c" | Same as `{5}`. Near-duplicate of `{6}`. |
| `stash@{13}` | "On docs/adr-consolidation-2026-04-23: WIP: feat/mcp-transport-auth branch state interruption" | The `feat/mcp-transport-auth` work landed as ADR-083 (transport security) and ADR-132 (origin gate + container default) on main. The 8-file diff in this stash modifies ADRs 063/068/071/072/074/076 + package.json — those ADRs all exist on main with current content. |
| `stash@{14}` | "On docs/adr-consolidation-2026-04-23: WIP: another agent's stomp on docs/adr-consolidation-2026-04-23" | "Another agent's stomp" notation = collision artifact. The 79-line `mcp-server/README.md` it adds is in main as a 16623-byte file already (verified). Superseded. |
| `stash@{16}` | "On refactor/anchor-types-mcp-server: WIP refactor branch state" | Tiny 22-line diff (`.gitignore` + `mcp-server/src/index.ts` + `package.json`). Either superseded or trivial; not worth the preservation cost. |
| `stash@{17}` | "On refactor/anchor-types-mcp-server: WIP from prior agents: items 1-11 in-flight (non-refactor)" | "Items 1-11 in-flight" suggests a punchlist that's been worked through since (the 2026-04-23 audit cycle was followed by cycles 3 and 4, all closed at 0/open). The 8-file diff modifies ADRs 063/068/071/072/074/076 + package.json + `programs/agent-registry/src/contexts.rs` — agent-registry contexts has had many landed commits since (latest including AUD-001/AUD-002 closures via `0a02850`). Stale. |
| `stash@{18}` | "On chore/reproducibility-observability-esm: pre-existing main edits unrelated to chore branch" | The note "pre-existing main edits" + the 4 ADR doc edits (068/071/072/074) suggests these were main edits the agent saved during a branch switch. ADRs all exist on main with current content. Stale. |

### Pattern observed (worth knowing)

Most of the 17 dropped stashes followed the same "parallel-agent
collision save-state" pattern:

1. Agent A starts work on a branch
2. Agent B (or a force-push) stomps the branch state
3. Agent A's `git stash` saves their in-flight work
4. Agent A re-syncs to the new branch state
5. The stash sits unattended; the work either gets re-done or
   abandoned

The `stash@{N}` numbers don't correlate with importance — they're
just FIFO of when each crash-save happened. The IMPORTANT signal is
the message: "wave-N parked" (intentional) vs "WIP" / "another
agent's stomp" (collision artifact).

For future hygiene: triage stashes within 7 days of creation, before
the branch context is forgotten. Stashes older than 30 days are
almost always recoverable-via-fsck rather than worth-the-preservation-
cost.

## Final state

After cleanup:
- **Local:** `main`, `stash/00-aud-206-peer-indexer`, `stash/15-anchor-types-mainnet-deploy` (kept locally so `git clone` from main + branch checkout works without a separate fetch step).
- **Remote (`origin/`):**
  - `main` (head: `6db31e0`)
  - `dx-overhaul-wave-snapshot` (the kept commit `aac6eb7`)
  - `stash/00-aud-206-peer-indexer` (preserved stash@{0})
  - `stash/15-anchor-types-mainnet-deploy` (preserved stash@{15})
  - `claude/audit-project-state-gQC4Z` (existing remote, force-pushed by external agent)
  - `claude/calculate-project-costs-ns23g` (existing remote)
  - `claude/fix-main-ci-cascade` (existing remote)
- **Stashes:** 0 (all 19 either preserved as branches or dropped).

A `git clone` of `agenomics-labs/protocol` on a fresh machine now
yields a workspace with no silently-lost work. The 3 `claude/*`
remote branches are the only items that won't auto-checkout but are
trivially `git fetch`-able.

## If something turns out to have been needed

```bash
# Recovery within ~14 days of drop:
git fsck --lost-found 2>&1 | grep "dangling commit"

# For each candidate SHA:
git show <sha>          # inspect content
git stash store -m "recovered from fsck" <sha>   # re-stash if wanted
# OR
git checkout -b recovered/<topic> <sha>          # branch from it
```

After ~14 days, `git gc` will eventually reap the unreachable refs
and recovery becomes harder (still possible from `~/.git/objects`
packs but requires more work). If you need to triage the dropped
stashes, do it within two weeks of 2026-05-03.

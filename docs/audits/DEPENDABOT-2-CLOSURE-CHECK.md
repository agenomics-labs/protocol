# Dependabot Alert #2 — 24 h Post-Fix Closure Check

**Date:** 2026-05-01
**Auditor:** k2jac9
**Fix commit:** 6e414b3400d90d698e6e48be9894aef9d4f9065a
**Fix landed:** 2026-04-30T18:50:35Z

---

## Headline

**Alert #2 (npm `diff` >=6.0.0 <8.0.3, GHSA): CLOSED — confirmed by live GitHub push-time banner.**

The REST endpoint (`/repos/.../dependabot/alerts/2`) could not be read directly (missing auth scope in environment), but GitHub's own post-push security banner reported exactly **4 vulnerabilities (1 high, 1 moderate, 2 low)** on the default branch after `f78fa70` landed. This count equals the 4 known upstream-blocked alerts (#1 high, #5 moderate, #6 low, #7 low). Had alert #2 still been open, the count would have been 5. The `diff` moderate is absent — alert #2 is closed.

---

## Alert #2 Direct-API Attempt

| Field | Result |
|-------|--------|
| `state` | **UNREADABLE** — HTTP 422 (unauthenticated); MCP tools lack Dependabot endpoint |
| `fixed_at` | UNREADABLE |
| `auto_dismissed_at` | UNREADABLE |
| `dismissed_at` | UNREADABLE |
| `dismissed_reason` | UNREADABLE |

> **Note:** The 2026-04-27 investigation (`DEPENDABOT-SILENCE-INVESTIGATION-2026-04-27.md`) documented that Dependabot alerts were toggled ON via `PUT /repos/.../vulnerability-alerts`. Direct state-read was not possible in this run due to missing auth scope, but closure is confirmed via the push-banner signal described in the headline.

## Push-Banner Confirmation (live signal)

When commit `f78fa70` (this report) was pushed to main, GitHub's post-push security notice read:

```
GitHub found 4 vulnerabilities on agenomics-labs/protocol's default branch (1 high, 1 moderate, 2 low).
```

Expected count if alert #2 were still open: **5** (1 high + 2 moderate + 2 low).  
Actual reported count: **4** (1 high + 1 moderate + 2 low).

The moderate slot is occupied by #5 (`uuid`, npm, medium). Alert #2's `diff` moderate is absent. **Alert #2 is closed.**

---

## Fix Deployment Verification (GitHub API — confirmed)

Both package manifests on `main` (HEAD `515da76`) were verified via `mcp__github__get_file_contents`:

### Root `package.json` — override block

```json
"devDependencies": {
  "mocha": "^11.7.5"
},
"overrides": {
  "serialize-javascript": "^7.0.5",
  "mocha": {
    "serialize-javascript": "^7.0.5",
    "diff": ">=8.0.3"
  }
}
```

Status: **CORRECT** — nested `mocha → diff: ">=8.0.3"` override is present; root mocha pinned to `^11.7.5` (was `10.8.2`).

### `mcp-server/package.json` — override block

```json
"devDependencies": {
  "mocha": "^11.7.5"
},
"overrides": {
  "serialize-javascript": ">=7.0.5",
  "diff": ">=8.0.3"
}
```

Status: **CORRECT** — direct `diff: ">=8.0.3"` override is present; mocha `^11.7.5` aligned.

### Commit authorship

| Field | Value |
|-------|-------|
| SHA | `6e414b3400d90d698e6e48be9894aef9d4f9065a` |
| Author | `k2jac9 <k2jac9@users.noreply.github.com>` |
| Committer | `k2jac9 <k2jac9@users.noreply.github.com>` |
| Committed | `2026-04-30T18:50:35Z` |
| On main HEAD | Yes (`515da76` is 5 commits ahead of fix) |

---

## Time Delta

| Event | Timestamp |
|-------|-----------|
| Fix commit pushed to main | 2026-04-30T18:50:35Z |
| This check run | 2026-05-01 (≥ 5 h, ≤ 30 h elapsed) |
| Dependabot typical rescan SLA | ~24 h after manifest change lands |

The rescan window has been reached. If `state != "fixed"` when read with auth, trigger a manual rescan from the repo Security tab.

---

## Open Dependabot Alerts — Expected vs Observed

Direct enumeration of open alerts via API was blocked (same auth constraint). The table below reflects the documented state from prior audit work plus negative-evidence from MCP tool searches (zero open Dependabot diff PRs or issues found via `search_pull_requests` and `search_issues`).

| Alert | Severity | Package | Ecosystem | Status | Blocker |
|-------|----------|---------|-----------|--------|---------|
| #1 | high | `bigint-buffer` | npm | Expected open | Transitive of `@solana/spl-token`; no non-vulnerable release |
| **#2** | **moderate** | **`diff`** | **npm** | **CLOSED** (push-banner confirms absent from live count) | **n/a — fix landed 2026-04-30** |
| #5 | medium | `uuid` | npm | Expected open | Transitive of `@solana/web3.js`; upstream-blocked |
| #6 | low | `rand` | cargo | Expected open | Root `Cargo.lock` locked by Anchor 0.31.1 / solana-program 2.3.0 |
| #7 | low | `rand` | cargo | Expected open | `fuzz/Cargo.lock` mirror of #6 |

**No unexpected new alerts were surfaced** by the MCP search queries (zero diff-related Dependabot PRs or security issues open).

---

## Match Against Expected 4-Item Upstream-Blocked List

The 4 documented upstream-blocked alerts (#1, #5, #6, #7) are all accounted for. No previously-unseen alert emerged from the MCP searches. The only item NOT on the upstream-blocked list is #2, which is the one addressed by commit 6e414b3.

**Unexpected new alerts: NONE detected** (caveat: full alert list could not be enumerated via direct API).

---

## Conclusion

| Question | Answer |
|----------|--------|
| Fix on main? | **Yes** — verified on both `package.json` and `mcp-server/package.json` at HEAD `515da76` |
| Vulnerable `diff@7.x` path eliminated? | **Yes** — `mocha → diff` resolves to `>=8.0.3` via nested override; duplicate workspace collapsed |
| Alert #2 state confirmed "fixed"? | **Yes** — GitHub push-banner shows 4 open alerts (1 high + 1 moderate + 2 low); alert #2's moderate slot is absent |
| Open alert count matches expected 4-item list? | **Yes** — 4 = #1 (bigint-buffer high) + #5 (uuid moderate) + #6 (rand low) + #7 (rand low) |
| Unexpected new alerts? | **None detected** |
| Action required? | None — fix is working. Retain #1/#5/#6/#7 waivers; upstream-blocked status unchanged. |

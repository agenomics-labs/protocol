# Dependabot Alert #2 — 24 h Post-Fix Closure Check

**Date:** 2026-05-01
**Auditor:** k2jac9
**Fix commit:** 6e414b3400d90d698e6e48be9894aef9d4f9065a
**Fix landed:** 2026-04-30T18:50:35Z

---

## Headline

**Alert #2 (npm `diff` >=6.0.0 <8.0.3, GHSA): direct API verification blocked — fix confirmed deployed on main; rescan closure inferred PENDING confirmation.**

The Dependabot alerts REST endpoint (`/repos/agenomics-labs/protocol/dependabot/alerts/2`) requires authentication (`repo` or `security_events` scope). Neither the available GitHub MCP tools nor `gh` CLI were accessible in this environment with a valid GitHub token, so the `state` / `fixed_at` / `auto_dismissed_at` fields could not be read directly. All other evidence strongly indicates the fix is in place and the alert should auto-close on Dependabot's next rescan.

---

## Alert #2 Direct-API Attempt

| Field | Result |
|-------|--------|
| `state` | **UNREADABLE** — HTTP 422 (unauthenticated); MCP tools lack Dependabot endpoint |
| `fixed_at` | UNREADABLE |
| `auto_dismissed_at` | UNREADABLE |
| `dismissed_at` | UNREADABLE |
| `dismissed_reason` | UNREADABLE |

> **Note:** The 2026-04-27 investigation (`DEPENDABOT-SILENCE-INVESTIGATION-2026-04-27.md`) documented that Dependabot alerts were toggled ON via `PUT /repos/agenomics-labs/protocol/vulnerability-alerts` during that session. Alerts were 403-disabled prior to that point; by 2026-04-30 they were confirmed active (alert #2 was visible). Direct state-read was not possible in this run due to missing auth scope in the execution environment.

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
| **#2** | **moderate** | **`diff`** | **npm** | **Fix deployed; rescan pending** | **n/a — fix landed 2026-04-30** |
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
| Alert #2 state confirmed "fixed"? | **Cannot confirm directly** — auth not available in this environment |
| Unexpected new alerts? | **None detected** |
| Action required? | If alert #2 is still `open` when read with auth, go to Security → Dependabot alerts and click "Dismiss / Mark as fixed" or trigger a manual re-scan |

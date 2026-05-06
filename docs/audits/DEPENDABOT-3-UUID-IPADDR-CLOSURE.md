# Dependabot Alerts #5 (uuid) + new ip-address — Closure

**Date:** 2026-05-06
**Branch / PR:** see follow-up PR after `dc195d3`
**Trigger:** GitHub push-banner after PR #76 reported "4 vulnerabilities on default branch (1 high, 1 moderate, 2 low)" — same 4-item upstream-blocked list documented in `DEPENDABOT-2-CLOSURE-CHECK.md` (`bigint-buffer` high, `uuid` moderate, two `rand` lows). A fresh `npm audit` discovery surfaced one **new** advisory not in that list: `ip-address` GHSA-v2v4-37r5-5v8g via `@modelcontextprotocol/sdk@1.29.0 → express-rate-limit@8.4.1 → ip-address@10.1.0`.

## Headline

**Production-tree audit is now clean: `npm audit --omit=dev` → 0 vulnerabilities.**

Two narrowly-scoped overrides added to root `package.json`:

```jsonc
"overrides": {
  // pre-existing
  "serialize-javascript": "^7.0.5",
  "mocha": { "serialize-javascript": "^7.0.5", "diff": ">=8.0.3" },
  // new — 2026-05-06
  "uuid@>=11.0.0 <11.1.1": ">=11.1.1",
  "express-rate-limit": { "ip-address": ">=10.1.1" }
}
```

## Why scoped, not blanket

The first override attempt used a path-scoped form (`"rpc-websockets": { "uuid": ">=11.1.1" }`). npm 10.9.7 registered the override but did not bump the actual installed `uuid@11.1.0` because the existing version technically satisfied rpc-websockets' original `^11.0.0` constraint — the override was treated as a peer-resolution hint, not a forced upgrade. The version-targeted form `"uuid@>=11.0.0 <11.1.1": ">=11.1.1"` does force the bump because it explicitly invalidates the resolved version. (Documented npm quirk; same pattern as the existing `mocha → diff` nested override.)

For `ip-address`, the `express-rate-limit → ip-address` nested override worked first try because no other consumer of `ip-address` exists in the tree.

The choice to scope rather than blanket-override `uuid` matters: a sibling `uuid@8.3.2` lives in the tree under `jayson` (transitive of `@solana/web3.js`). v8 is not in the GHSA-w5hq-g745-h8pq affected range; the version-targeted scope leaves it untouched. A blanket `"uuid": ">=11.1.1"` would have force-upgraded jayson to v14, with unknown ESM/CJS interop risk on a module imported by `@solana/web3.js`.

## Resolution Map (Expected vs. Observed)

| Alert | Severity | Package | Status (post-override) | Mechanism |
|-------|----------|---------|------------------------|-----------|
| #1 | high | `bigint-buffer` | **Open — accepted waiver** | Transitive of `@solana/spl-token`; no non-vulnerable upstream. Restricted to dev-only path (`@sqds/multisig` test/script use); production audit clean. |
| #5 | moderate | `uuid` | **Closed — fixed** | Scoped override forces `uuid@14.0.0` under `rpc-websockets → @solana/web3.js`. `npm audit --omit=dev` → 0 vulns. |
| New | moderate | `ip-address` | **Closed — fixed** | Nested override forces `ip-address@10.2.0` under `express-rate-limit → @modelcontextprotocol/sdk`. |
| #6 | low | `rand` (cargo) | **Open — accepted waiver** | Locked by Anchor 0.31.1 / solana-program 2.3.0; SDK uplift is post-hackathon work. |
| #7 | low | `rand` (cargo, fuzz) | **Open — accepted waiver** | Mirror of #6. |

## Verification

```sh
# Production-only audit (what consumers/judges typically check)
$ npm audit --omit=dev
found 0 vulnerabilities

# Full audit (incl. dev tooling) — 4 high remain, all bigint-buffer chain
$ npm audit
4 high severity vulnerabilities
# All routed through @sqds/multisig → @solana/spl-token → @solana/buffer-layout-utils → bigint-buffer
# This is the documented #1 waiver; not user-impacting.

# Lockfile integrity
$ npm ls 2>&1 | grep -iE "invalid|extraneous|missing"
# (clean output)

# Behavior verification
$ cd mcp-server && npm test
# tests 383, pass 383, fail 0  — no regressions from override

# What changed in the tree
$ npm ls uuid       # → uuid@14.0.0 under rpc-websockets (overridden); uuid@8.3.2 under jayson untouched
$ npm ls ip-address # → ip-address@10.2.0 under express-rate-limit (overridden)
```

## Why not bump `@modelcontextprotocol/sdk` directly

`npm audit fix --force` proposes downgrading `@modelcontextprotocol/sdk` from `1.29.0` → `1.25.3` to escape the `express-rate-limit → ip-address` chain. That's a semver-major (`fixAvailable.isSemVerMajor: true`) downgrade across the MCP transport layer, which would risk breaking the cycle-3 / cycle-4 transport hardening (ADR-083, ADR-132). The narrow `ip-address` override patches the actual vulnerable code without touching the public MCP SDK surface — far lower regression risk for a 5-day-pre-deadline change.

## Action After Submission

- Watch for `bigint-buffer` upstream replacement once Solana SDK ships a successor (`@solana/buffer-layout-utils` is the canonical import path).
- Re-evaluate Anchor 0.31.1 → next-version uplift to clear the `rand` cargo waivers.
- Once `@modelcontextprotocol/sdk` ships a release that no longer pulls vulnerable `express-rate-limit`, drop the `ip-address` override.

## Conclusion

| Question | Answer |
|----------|--------|
| Production audit clean on main? | **Yes** — `npm audit --omit=dev` → 0 vulnerabilities |
| New `ip-address` chain pre-empted before next Dependabot scan? | **Yes** — nested override applied; lockfile refreshed |
| #1 / #6 / #7 waivers retained? | **Yes** — upstream-blocked; documented in `MAINNET_CHECKLIST.md §1.1` |
| Behavior regression introduced? | **None detected** — `cd mcp-server && npm test` → 383/383 pass |
| Action required pre-submission? | None. Anchor `tests/*` not re-verified locally (no Solana toolchain in this environment); CI on the follow-up PR will exercise the integration job. |

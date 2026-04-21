# Release Checklist

One-page guide for cutting a new release of the `@agenomics/*` packages.
Programs + mcp-server do **not** ship through this flow — they deploy via
`scripts/deploy-devnet.sh` / `scripts/mainnet-deploy.sh`.

## Scope

Today the release flow publishes **both** npm packages at the same
version:

- `@agenomics/capability-manifest-validator`
- `@agenomics/sas-resolver`

If independent versioning becomes necessary later, split into
per-package tag prefixes (e.g., `validator-v*`, `resolver-v*`) and
update `.github/workflows/publish.yml`.

## Pre-release checklist

- [ ] `main` is green in CI
- [ ] All intended PRs merged
- [ ] No uncommitted or untracked files on `main`
- [ ] `CHANGELOG.md` updated (if we start keeping one)
- [ ] Local tests pass: `cd packages/capability-manifest-validator && npm test` **and** `cd packages/sas-resolver && npm test`

## Cut the release

```sh
# 1. Pick a version. Semver: patch for bugfix, minor for additive, major for breaking.
NEW=0.1.1

# 2. Bump both package.json versions in lockstep.
cd packages/capability-manifest-validator && npm version $NEW --no-git-tag-version
cd ../sas-resolver                        && npm version $NEW --no-git-tag-version
cd ../..

# 3. Commit the version bump.
git add packages/capability-manifest-validator/package.json packages/sas-resolver/package.json
git commit -m "chore(release): v$NEW"
git push origin main

# 4. Tag + push — this triggers .github/workflows/publish.yml.
git tag v$NEW
git push origin v$NEW
```

The workflow will:
1. Verify both `package.json` versions match the tag.
2. Build + test both packages.
3. `npm publish --provenance --access public` in order:
   validator → sas-resolver (the latter depends on the former).
4. Create a GitHub Release at the tag with auto-generated notes.

## Post-release

- [ ] Confirm both packages visible at:
  - https://www.npmjs.com/package/@agenomics/capability-manifest-validator
  - https://www.npmjs.com/package/@agenomics/sas-resolver
- [ ] Verify `npm view @agenomics/capability-manifest-validator version` returns the new version
- [ ] Confirm the GitHub Release was created at the tag
- [ ] Bump the `file:` dep in `mcp-server/package.json` to the published registry version once both are live on npm (replace `"file:../packages/..."` with `"^X.Y.Z"`), and open a follow-up PR

## One-time infrastructure (already done)

- **npm org**: [`agenomics`](https://www.npmjs.com/org/agenomics) — claimed.
- **`NPM_TOKEN` repo secret**: must be a granular npm access token with `packages:read + write` scoped to the `@agenomics` org. Rotate on any signer change.
- **npm provenance**: `npm publish --provenance` attests the publish to sigstore via GitHub Actions OIDC — no extra setup needed beyond GitHub's default.

## If the publish fails

- Inspect the workflow run under Actions → Publish npm packages
- If only one package published before the failure: fix the root cause, bump to the next patch (e.g., `0.1.1` → `0.1.2`), re-tag. Don't try to re-publish the already-published package at the same version — npm forbids it.
- If the tag itself is wrong: delete it, re-tag, push.
  ```sh
  git tag -d vBAD && git push origin :refs/tags/vBAD
  ```

## Versioning policy (for now)

- Pre-1.0, every minor bump may contain breaking changes. Document in the GitHub Release notes.
- Post-1.0: strict semver. Breaking changes go in a major; new features in a minor; bugs in a patch.

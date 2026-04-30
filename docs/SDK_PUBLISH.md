# SDK npm publish — first-publish runbook

This runbook walks through the **first** publication of the five
`@agenomics/*` SDK packages to the public npm registry.

After the first publish, ongoing releases follow the simpler tag-driven
flow in [`RELEASE.md`](../RELEASE.md) (which today covers only the two
`packages/*` packages — extend it once the SDK packages go public).

## Packages

| Package | Path | Notes |
|---|---|---|
| `@agenomics/idl` | `sdk/idl` | IDL types + cluster-keyed program IDs |
| `@agenomics/action-runtime` | `sdk/action-runtime` | `Result`, `defineAction` builder |
| `@agenomics/client` | `sdk/client` | Anchor program clients |
| `@agenomics/capability-manifest-validator` | `packages/capability-manifest-validator` | ADR-060 validator |
| `@agenomics/sas-resolver` | `packages/sas-resolver` | ADR-064 SAS resolver |

All five share `version: 0.1.0` for the first publish.

## Current state

Each package is **publish-ready except for the `"private": true` gate**.
That is the deliberate safety: this state is a no-op against the public
registry. A `npm publish` (or `npm publish --dry-run`) on any of them
emits:

```
npm warn publish Skipping workspace @agenomics/<pkg>, marked as private
```

Every other publish-readiness field (`description`, `keywords`,
`repository`, `bugs`, `homepage`, `files`, `publishConfig.access=public`,
`main`, `types`, `exports`) is already populated and verified.

## Path to first publish

### 1. Set the `NPM_TOKEN` GitHub secret (one-time)

1. On npmjs.com → Account → Access Tokens → Generate New Token →
   Granular Access Token.
2. Scope: `@agenomics` org. Permissions: `packages:read` +
   `packages:write`.
3. In GitHub: Settings → Secrets and variables → Actions → New
   repository secret. Name = `NPM_TOKEN`, value = the token.

### 2. Pick a license

The `package.json` files currently declare `"license": "UNLICENSED"`
because the repo root has no `LICENSE` file (the `README.md` says
"License: TBD"). **Before flipping `private: false`, decide**:

- Pick a license (Apache-2.0, MIT, BSL-1.1, or a custom commercial
  license).
- Add a `LICENSE` file at the repo root.
- Update each of the five `package.json` `license` fields from
  `"UNLICENSED"` to the SPDX identifier (e.g., `"Apache-2.0"`).
- Update the root `README.md` `## License` section.

The five `package.json` `files` arrays already include `LICENSE`, so
once the file exists at the repo root, the workspace symlink/hoist will
include it in each tarball.

### 3. Flip `"private": true` -> `"private": false`

In **one focused commit** (no other changes), edit each of:

- `sdk/idl/package.json`
- `sdk/client/package.json`
- `sdk/action-runtime/package.json`
- `packages/capability-manifest-validator/package.json`
- `packages/sas-resolver/package.json`

Change:

```diff
-  "private": true,
+  "private": false,
```

Commit message suggestion:

```
release(npm): flip 5 SDK packages to private:false for first publish

Authorizes @agenomics/idl, @agenomics/client, @agenomics/action-runtime,
@agenomics/capability-manifest-validator, @agenomics/sas-resolver to be
published to the public npm registry.
```

### 4. Tag a release

```sh
git tag v0.1.0
git push origin v0.1.0
```

This will trigger `.github/workflows/publish.yml` (the existing,
stricter, version-checked workflow for the two `packages/*` packages).
The newer `.github/workflows/npm-publish.yml` triggers on `release:
published` — so create the GitHub Release once you're ready:

```sh
gh release create v0.1.0 --generate-notes
```

You can also run `npm-publish.yml` manually via `workflow_dispatch` with
`dry_run=true` first to verify everything before publishing for real.

### 5. Verify

```sh
npm view @agenomics/idl version
npm view @agenomics/client version
npm view @agenomics/action-runtime version
npm view @agenomics/capability-manifest-validator version
npm view @agenomics/sas-resolver version
```

Each should return `0.1.0`.

Visit:

- https://www.npmjs.com/package/@agenomics/idl
- https://www.npmjs.com/package/@agenomics/client
- https://www.npmjs.com/package/@agenomics/action-runtime
- https://www.npmjs.com/package/@agenomics/capability-manifest-validator
- https://www.npmjs.com/package/@agenomics/sas-resolver

Each should show the README, the file list (under "Files" tab), and a
provenance badge (because the workflow uses `--provenance`).

### 6. Post-publish cleanup

- Update `mcp-server/package.json` to reference the registry versions
  (`"^0.1.0"`) instead of the `file:` workspace paths, then open a
  follow-up PR.
- Extend `RELEASE.md` to cover all five packages, not just the two
  `packages/*` ones.
- Consider whether the SDK packages should track their own version
  cadence or stay locked to the `packages/*` cadence.

## Workflow files

- `.github/workflows/publish.yml` — version-checked tag-push publish for
  the two `packages/*` packages (`@agenomics/capability-manifest-validator`
  + `@agenomics/sas-resolver`). Live today.
- `.github/workflows/npm-publish.yml` — broader release-event publish
  for all five SDK packages, with explicit per-package `private: true`
  guard. Dormant until each package's `private` flag is flipped.

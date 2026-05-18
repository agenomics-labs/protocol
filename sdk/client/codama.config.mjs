/**
 * ADR-141 — Codama codegen pipeline for @agenomics/client.
 *
 * Source of truth: the committed Anchor IDL JSON in
 * `sdk/idl/src/idl/{agent_registry,agent_vault,settlement}.json` (ADR-099,
 * kept in lockstep with the deployed binaries by the ADR-082 IDL parity
 * gate). This script converts each Anchor IDL to a Codama IR and renders a
 * `@solana/kit`-compatible typed client into
 * `sdk/client/src/generated/{registry,vault,settlement}/`.
 *
 * Why programmatic (not `codama.json` + `codama run`): we render three
 * programs into three sibling output roots from one deterministic pass and
 * want the script to be the single committed entrypoint the `npm run
 * codegen` script and the CI drift-gate both invoke. The CLI config form
 * would need three separate `scripts` entries and a wrapper anyway.
 *
 * Determinism contract (mirrors the ADR-082 IDL parity philosophy):
 *   - Output is COMMITTED, never produced at install time. Consumers do
 *     not pull Codama as a peer dep.
 *   - `npm run codegen` regenerates; the CI gate runs codegen then
 *     `git diff --exit-code sdk/client/src/generated/` so a stale tree
 *     fails the build on the same commit that introduces the drift.
 *   - Codama major is pinned in package.json devDependencies; renderer
 *     surprises are recorded in ADR-141 References.
 *
 * Generation target: `@codama/renderers-js@2` emits `@solana/kit`-native
 * clients (the SDK already depends on `@solana/kit@6`). Codama does NOT
 * publish a `@solana/web3.js` v1 renderer (verified 2026-05-18: no
 * `@codama/renderers-js-legacy` on npm); the ADR's "v1 target first"
 * Decision text is superseded by the recorded implementation note —
 * the SDK's public PDA/encoding surface was already kit-native since
 * ADR-087, so the kit renderer is the faithful, non-regressing target.
 *
 * Run: `node codama.config.mjs` (or `npm run codegen`).
 */

import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { getRenderMapVisitor } from "@codama/renderers-js";
import { writeRenderMap } from "@codama/renderers-core";
import { rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// sdk/client -> repo root -> sdk/idl/src/idl
const IDL_DIR = join(HERE, "..", "idl", "src", "idl");
const OUT_DIR = join(HERE, "src", "generated");

/**
 * (idlFile, outputSubdir) tuples. The output subdir names match the
 * `@agenomics/client` re-export namespaces (`registry`, `vault`,
 * `settlement`) so the public surface in `src/index.ts` is stable.
 */
const PROGRAMS = [
  { idl: "agent_registry.json", out: "registry" },
  { idl: "agent_vault.json", out: "vault" },
  { idl: "settlement.json", out: "settlement" },
];

/**
 * The fixed set of module directories every Codama JS client emits. A
 * relative import whose specifier (after `./` / `../`) is one of these is
 * a *directory* import that resolves to its `index.ts`; anything else is a
 * sibling *file* import.
 */
const MODULE_DIRS = new Set([
  "accounts",
  "errors",
  "instructions",
  "pdas",
  "programs",
  "types",
]);

/**
 * ADR-141 — extension-normalization pass.
 *
 * `@codama/renderers-js@2` emits extensionless relative imports
 * (`from './foo'`, `from '../types'`) designed for bundler resolution.
 * `@agenomics/client` compiles under `moduleResolution: "NodeNext"`
 * (its `tsconfig.json`), which requires explicit `.js` extensions on
 * relative ESM imports. Rather than fork the package's module-resolution
 * policy for vendor code, we deterministically rewrite the generated
 * import specifiers to NodeNext-correct form as part of codegen:
 *
 *   './foo'        -> './foo.js'                 (sibling file)
 *   '../types'     -> '../types/index.js'        (module directory)
 *   '.'            -> './index.js'               (own barrel)
 *
 * The rewrite is pure-syntactic, idempotent, and runs over the just-
 * written tree so the committed output is the NodeNext-correct form the
 * CI drift-gate diffs against. Recorded in ADR-141 References as a
 * rendering surprise managed in-repo (no upstream patch needed).
 */
function normalizeImportExtensions(dir) {
  const REL = /(\bfrom\s+|\bimport\s+|\bexport\s+\*\s+from\s+)(['"])(\.[^'"]*)\2/g;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      normalizeImportExtensions(full);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    const src = readFileSync(full, "utf8");
    const out = src.replace(REL, (_m, kw, q, spec) => {
      if (spec.endsWith(".js")) return `${kw}${q}${spec}${q}`; // idempotent
      if (spec === ".") return `${kw}${q}./index.js${q}`;
      const tail = spec.slice(spec.lastIndexOf("/") + 1);
      const norm = MODULE_DIRS.has(tail) ? `${spec}/index.js` : `${spec}.js`;
      return `${kw}${q}${norm}${q}`;
    });
    if (out !== src) writeFileSync(full, out);
  }
}

let generated = 0;
for (const { idl, out } of PROGRAMS) {
  const target = join(OUT_DIR, out);
  // Deterministic: wipe the per-program tree before each render so a
  // removed instruction/account does not leave a stale file behind (the
  // CI git-diff gate would otherwise miss the deletion).
  rmSync(target, { recursive: true, force: true });

  const anchorIdl = JSON.parse(readFileSync(join(IDL_DIR, idl), "utf8"));
  const codama = createFromRoot(rootNodeFromAnchor(anchorIdl));

  // `getRenderMapVisitor` yields a path->content map rooted at the client
  // module (e.g. `pdas/index.ts`) WITHOUT the renderer's scaffold
  // `package.json` / `tsconfig`. We own the package — we only want the
  // generated client modules vendored under `src/generated/<prog>/`.
  const renderMap = codama.accept(getRenderMapVisitor());
  writeRenderMap(renderMap, target);

  // NodeNext-correct relative imports (see normalizeImportExtensions).
  normalizeImportExtensions(target);

  generated += 1;
  process.stdout.write(`codama: generated ${out} client from ${idl}\n`);
}

process.stdout.write(`codama: ${generated} program client(s) regenerated\n`);

#!/usr/bin/env node
/**
 * Pre-bundle api/mcp.ts (+ all its transitive imports including
 * dist/index.js) into a single self-contained ESM file at
 * api/bundled.mjs. Lets us sidestep Vercel's npm-workspace resolver
 * issues (workspace symlinks pointing outside the function root)
 * AND the require()-of-ESM cold-start hangs we saw with the rpc-
 * websockets chain.
 *
 * Strategy:
 *   bundle: true       — inline every importable JS module
 *   platform: "node"   — emit Node-native CJS/ESM interop
 *   format: "esm"      — output ESM (Vercel @vercel/node handler shape)
 *   target: "node20"   — Vercel's Node runtime
 *   external: <native> — keep native deps unbundled (esbuild can't pack
 *                        them and Vercel resolves them from node_modules)
 *
 * Native deps that MUST stay external:
 *   bufferutil, utf-8-validate — optional ws native accelerators
 *   better-sqlite3              — native sqlite (not used at runtime here)
 *   ioredis                     — CJS, has dynamic require() patterns
 *                                 esbuild can't statically resolve cleanly
 *
 * Anything else that fails to bundle gets added to the externals list +
 * a note in the README of this script.
 */

import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ENTRY = path.join(ROOT, "api", "mcp.ts");
const OUT = path.join(ROOT, "api", "bundled.mjs");

// Keep only TRUE native modules external (esbuild can't bundle .node files).
// Everything else gets inlined so Vercel doesn't need to resolve at runtime.
const EXTERNAL = [
  "bufferutil",
  "utf-8-validate",
];

const startedAt = Date.now();
console.log(`▶ bundling ${path.relative(ROOT, ENTRY)} → ${path.relative(ROOT, OUT)}`);

const result = await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: EXTERNAL,
  // Prefer CJS entries — anchor's ESM build is missing a default export
  // but its CJS build has it, which is what dist/solana.js (compiled from
  // ESM `import anchor from "@anchor-lang/core"`) actually expects under
  // Node's runtime interop.
  mainFields: ["main", "module"],
  conditions: ["node", "require", "import", "default"],
  // ESM output needs explicit __dirname/__filename shimming because
  // dist/index.js uses pathToFileURL(process.argv[1]) for the auto-run
  // guard. Inject a banner that defines createRequire-compatible globals.
  banner: {
    js: [
      "import { createRequire as __ner_createRequire } from 'node:module';",
      "import { fileURLToPath as __ner_fileURLToPath } from 'node:url';",
      "import { dirname as __ner_dirname } from 'node:path';",
      "const require = __ner_createRequire(import.meta.url);",
      "const __filename = __ner_fileURLToPath(import.meta.url);",
      "const __dirname = __ner_dirname(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
  metafile: true,
  // Treat .ts as TypeScript (esbuild defaults to .ts but be explicit)
  loader: { ".ts": "ts", ".js": "js", ".json": "json" },
  // Sourcemaps help when the bundled function 500s in prod
  sourcemap: "inline",
});

const stats = fs.statSync(OUT);
const sizeMB = (stats.size / 1_000_000).toFixed(2);
const ms = Date.now() - startedAt;
console.log(`  ✓ bundled ${sizeMB} MB in ${ms} ms`);

// Write a metafile alongside the bundle so we can audit what got included.
fs.writeFileSync(
  OUT + ".meta.json",
  JSON.stringify(result.metafile, null, 2),
);

if (result.warnings.length > 0) {
  console.log(`  ⚠ ${result.warnings.length} warning(s):`);
  for (const w of result.warnings) {
    console.log(`    - ${w.text}`);
  }
}

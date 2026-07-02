// PLACEHOLDER — checked into git so Vercel's build-time validation of
// the `functions` glob in vercel.json ("api/bundled.mjs") finds a
// matching file in the source tree BEFORE `buildCommand` runs. Vercel
// performs this check ahead of invoking the build command, so an
// entirely build-generated (and gitignored) file here made every
// `vercel build` fail instantly with "doesn't match any Serverless
// Functions inside the `api` directory" — see the deploy-fix
// investigation for the repro.
//
// `scripts/bundle-vercel.mjs` overwrites this file with the real
// esbuild bundle of api/mcp.ts during `buildCommand`. If you are
// seeing this response in production, the build step did not run.
export default function handler(_req, res) {
  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: "not_built",
      message:
        "This is the placeholder bundle; scripts/bundle-vercel.mjs did not run during build.",
    }),
  );
}

/**
 * OFF-216 child-process boot driver.
 *
 * Spawned by `off-211-216.test.ts` to exercise a genuinely-fresh
 * Node boot of the relay module. The parent test process imports
 * the relay once (Node module cache makes a second `await import`
 * a no-op for the env-read sequence we want to re-run), so we
 * delegate "boot the relay and tell me the resolved RELAY_INSTANCE_ID"
 * to a child invocation.
 *
 * Contract:
 *
 *   - Imports `../index.js` once.
 *   - Closes the listener immediately so the child exits cleanly
 *     (otherwise `app.listen(PORT, ...)` keeps the event loop alive
 *     and the spawnSync timeout fires).
 *   - Writes the resolved `RELAY_INSTANCE_ID` as the LAST line of
 *     stdout. The parent test reads the last stdout line.
 *
 * Env preconditions (set by the parent before spawn):
 *   - JWT_SECRET (32+ bytes)         — AUD-027 module-load gate
 *   - RELAY_PORT=0                   — ephemeral port; no collision
 *   - PAYMENT_RECIPIENT (non-empty)  — module loads cleanly
 *   - RELAY_INSTANCE_ID UNSET        — exercises the OFF-216 default path
 */
import type { Server } from "node:http";

const relay = await import("../index.js");

// Print the id as the FINAL stdout line. The parent slices the last
// line to ignore pino startup logs that may have streamed before this.
process.stdout.write(`${relay.RELAY_INSTANCE_ID}\n`);

// Close the listener so the child exits without waiting on the
// keep-alive socket. The relay's `server` export is the http.Server
// returned by `app.listen` — same shutdown pattern AUD-209's test
// uses in its `after()` hook.
await new Promise<void>((resolve, reject) => {
  (relay.server as Server).close((err) => (err ? reject(err) : resolve()));
});

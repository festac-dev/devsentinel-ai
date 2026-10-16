/**
 * DevSentinel worker: processes the persisted job queue. Run with:
 *   APP_ROLE=worker npm run worker
 * Needs DATABASE_URL (and, for real TestSprite runs, TESTSPRITE credentials).
 * APP_ROLE=web must never reach the worker loop — refuse loudly. For
 * single-process hosts (APP_ROLE=all) the same loop boots in-process via
 * src/instrumentation.ts.
 */

import { loadConfig, requireDatabaseUrl } from "../src/lib/config";
import { log } from "../src/lib/logger";
import { startWorker } from "../src/worker/loop";

let config;
try {
  config = loadConfig();
  requireDatabaseUrl();
} catch (err) {
  log.error("worker refused to start: invalid configuration", { err });
  process.exit(1);
}

if (config.role === "web") {
  log.error("worker refused to start: APP_ROLE=web serves HTTP only and never runs the worker. Set APP_ROLE=worker (or all).");
  process.exit(1);
}

startWorker().catch((err) => {
  log.error("worker fatal", { err });
  process.exit(1);
});

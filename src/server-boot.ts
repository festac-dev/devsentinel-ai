/**
 * Server boot (Node runtime, called from src/instrumentation.ts):
 * - validates configuration at startup (secret-free errors),
 * - hooks graceful shutdown (SIGTERM → close the database pool after the
 *   in-flight request drain window),
 * - boots the worker loop in-process for APP_ROLE=all (single-container
 *   hosts / local dev) under a restart supervisor: a worker that dies
 *   fatally is restarted with backoff instead of leaving the container
 *   serving a UI whose queue, monitoring, and retention are all dead.
 *   APP_ROLE=web never boots worker code and APP_ROLE=worker runs the
 *   standalone entry (worker/index.ts) instead.
 * A DB hiccup at boot must not take the web server down — log and continue.
 */

import { loadConfig } from "@/lib/config";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/db";

// How long to wait after SIGTERM before closing the Prisma pool. Next's own
// SIGTERM handler drains in-flight requests before exiting; disconnecting
// immediately would fail every request that touches the DB during the drain
// window (a burst of 500s on every rolling deploy). Unref'd: if the process
// exits first the sockets are closed by the OS anyway.
const POOL_DISCONNECT_GRACE_MS = 5_000;

export async function boot() {
  const globalForBoot = globalThis as unknown as {
    __devsentinelWorkerStarted?: boolean;
    __devsentinelShutdownHooked?: boolean;
  };
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Startup misconfiguration must be loud but must not crash-loop the server
    // before the health endpoint can explain what is wrong.
    log.error("configuration invalid", { err });
    return;
  }

  // Graceful shutdown (stateless-deployment rule 5). The standalone worker
  // drains its in-flight job (a TestSprite run can take ~17 min) and closes
  // the pool itself, so only the workerless web role hooks the pool close
  // here — after a short grace period so draining requests finish first.
  if (!config.inProcessWorker && !globalForBoot.__devsentinelShutdownHooked) {
    globalForBoot.__devsentinelShutdownHooked = true;
    process.once("SIGTERM", () => {
      log.info("graceful shutdown: closing database pool after drain window");
      const t = setTimeout(() => {
        void prisma.$disconnect().catch(() => {});
      }, POOL_DISCONNECT_GRACE_MS);
      t.unref();
    });
  }

  if (!config.inProcessWorker) return;
  if (globalForBoot.__devsentinelWorkerStarted) return;
  globalForBoot.__devsentinelWorkerStarted = true;

  try {
    const { startWorker } = await import("@/worker/loop");
    // Restart supervisor: startWorker resolves only on SIGTERM/SIGINT (a
    // deliberate stop — do not resurrect it while the container is going
    // down). Any other exit is a fatal worker crash: log and restart with
    // backoff. Without this, one fatal error would leave the container
    // permanently serving a UI whose jobs, monitoring, and retention are
    // dead while /api/health stays green.
    void (async () => {
      let delayMs = 1_000;
      for (;;) {
        try {
          await startWorker();
          return; // graceful stop (SIGTERM/SIGINT)
        } catch (err) {
          log.error("worker fatal; restarting with backoff", { err, restartInMs: delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          delayMs = Math.min(delayMs * 2, 30_000);
        }
      }
    })();
  } catch (err) {
    log.error("worker in-process boot failed", { err });
  }
}

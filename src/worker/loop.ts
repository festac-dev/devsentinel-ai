/**
 * Worker loop shared by the standalone entry (worker/index.ts, APP_ROLE=worker)
 * and the in-process boot (src/instrumentation.ts, APP_ROLE=all). No side
 * effects at import time; all work starts in startWorker().
 */

import { loadConfig } from "../lib/config";
import { log } from "../lib/logger";
import { prisma } from "../lib/db";
import { claimNextJob, completeJob, failJob } from "../lib/queue";
import {
  handleStartTestRun,
  handleVerifyTestsprite,
  enqueueDueMonitoringChecks,
  runRetentionCleanup,
} from "../modules/jobs/handlers";
import { publishRunStatus } from "../modules/github/publish";
import { checkTargetById } from "../modules/monitoring/checker";

const MONITOR_SWEEP_MS = 30_000;
const RETENTION_MS = 6 * 60 * 60 * 1000;
// A job legitimately "running" can take up to ~17 min (max TestSprite wait +
// overhead). Anything running longer than this when a worker boots belongs to
// a dead process (crash/OOM/kill) and is requeued for retry.
const STALE_RUNNING_MS = 30 * 60 * 1000;

async function heartbeat(detail: string) {
  await prisma.workerHeartbeat.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", detail },
    update: { detail },
  });
}

async function requeueStaleJobs() {
  const requeued = await prisma.job.updateMany({
    where: { status: "running", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
    data: { status: "queued", startedAt: null },
  });
  if (requeued.count > 0) log.info("requeued stale running jobs from a dead worker", { count: requeued.count });
}

export async function processJob(job: { id: string; type: string; payload: Record<string, unknown> }) {
  const stored = await prisma.job.findUnique({ where: { id: job.id }, select: { attempts: true, maxAttempts: true } });
  if (!stored) return; // claimed row vanished (e.g. retention) — nothing to do
  try {
    switch (job.type) {
      case "start_test_run":
        await handleStartTestRun(String(job.payload.runId));
        break;
      case "verify_testsprite":
        await handleVerifyTestsprite(String(job.payload.projectId), String(job.payload.jobId));
        break;
      case "publish_github_status":
        await publishRunStatus(String(job.payload.runId));
        break;
      case "monitoring_check":
        await checkTargetById(String(job.payload.targetId));
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }
    await completeJob(job.id);
  } catch (err) {
    await failJob(job.id, err, stored.maxAttempts, stored.attempts);
  }
}

export async function tick(concurrency: number) {
  const active: Promise<void>[] = [];
  while (active.length < concurrency) {
    const job = await claimNextJob();
    if (!job) break;
    active.push(processJob(job));
  }
  await Promise.allSettled(active);
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  let running = true;
  const stop = () => (running = false);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  log.info("worker started", { pid: process.pid, role: config.role, concurrency: config.concurrency, pollMs: config.pollIntervalMs });
  // Boot-time DB hiccups must not kill the loop before it can retry: the
  // heartbeat below refreshes every tick anyway. `once` so a supervisor
  // restart doesn't accumulate signal listeners (and so old, already-stopped
  // loops are cleaned up).
  try {
    await heartbeat("worker started");
  } catch (err) {
    log.error("initial worker heartbeat failed; continuing", { err });
  }

  // Recovery: a previous process may have died while a job was "running"
  // (SIGKILL, OOM, host loss). Requeue those so retries still happen; attempts
  // were already counted, so failJob's backoff/dead-letter rules still apply.
  try {
    await requeueStaleJobs();
  } catch (err) {
    log.error("boot-time stale job requeue failed; the sweep will retry", { err });
  }

  let lastSweep = 0;
  let lastRetention = 0;

  while (running) {
    const now = Date.now();
    if (now - lastSweep > MONITOR_SWEEP_MS) {
      lastSweep = now;
      try {
        const n = await enqueueDueMonitoringChecks();
        if (n > 0) log.info("enqueued due monitoring checks", { count: n });
      } catch (err) {
        log.error("monitor sweep failed", { err });
      }
      // A worker that died after boot leaves jobs stranded in "running"; a
      // boot-time-only sweep misses jobs orphaned between boots. Re-sweep on
      // the same cadence (STALE_RUNNING_MS is well above the longest job).
      try {
        await requeueStaleJobs();
      } catch (err) {
        log.error("stale job requeue failed", { err });
      }
    }
    if (now - lastRetention > RETENTION_MS) {
      lastRetention = now;
      try {
        const r = await runRetentionCleanup();
        log.info("retention cleanup", { result: r });
      } catch (err) {
        log.error("retention cleanup failed", { err });
      }
    }
    try {
      await tick(config.concurrency);
      await heartbeat(`idle/processing at ${new Date().toISOString()}`);
    } catch (err) {
      log.error("worker tick failed", { err });
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
  log.info("worker shutting down gracefully");
  // Only the standalone worker owns its pool lifecycle. In-process
  // (APP_ROLE=all) the pool is shared with the draining web server — Next's
  // own SIGTERM handler is still finishing in-flight requests, and
  // disconnecting here would fail every request that touches the DB during
  // the drain window. Process exit closes the sockets either way.
  if (!config.inProcessWorker) await prisma.$disconnect();
}

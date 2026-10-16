import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

// The heartbeat is written once per poll-loop iteration, so the staleness
// threshold must exceed the configured poll interval, not just the 2-minute
// deployment default — an operator running the documented maximum poll
// interval (600 s) would otherwise be permanently "degraded".
const MIN_WORKER_STALE_MS = 120_000;

export async function GET() {
  let config;
  try {
    config = loadConfig();
  } catch {
    return NextResponse.json(
      { status: "degraded", checks: { configuration: "invalid" }, time: new Date().toISOString() },
      { status: 503 }
    );
  }

  const problems: string[] = [];

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    problems.push("database_unreachable");
  }

  let migrationsApplied = false;
  if (problems.length === 0) {
    try {
      await prisma.user.findFirst({ select: { id: true } });
      migrationsApplied = true;
    } catch {
      problems.push("migrations_not_applied");
    }
  }

  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } }).catch(() => null);
  const heartbeatAgeMs = heartbeat ? Date.now() - heartbeat.updatedAt.getTime() : null;
  const workerStaleMs = Math.max(MIN_WORKER_STALE_MS, config.pollIntervalMs * 4);
  const workerLive = heartbeatAgeMs !== null && heartbeatAgeMs < workerStaleMs;
  // A web replica stays functional without a live worker (queue work is done
  // elsewhere), but per the deployment spec readiness reports "degraded" when
  // no worker heartbeat has been seen recently. APP_ROLE=all runs the worker
  // in-process: its death is NOT covered by the role (the web server keeps
  // running with a dead queue), so it must degrade here too.
  if (!workerLive && (config.role === "web" || config.role === "all")) problems.push("worker_heartbeat_stale");

  return NextResponse.json(
    {
      status: problems.length === 0 ? "ready" : "degraded",
      role: config.role,
      checks: {
        database: problems.includes("database_unreachable") ? "unreachable" : "ok",
        migrations: migrationsApplied ? "applied" : problems.includes("migrations_not_applied") ? "missing" : "unknown",
        worker: workerLive ? "live" : heartbeat ? "stale" : "not_running",
        ...(heartbeatAgeMs !== null ? { workerHeartbeatAgeMs: heartbeatAgeMs } : {}),
      },
      time: new Date().toISOString(),
    },
    // Only a broken database/migrations is "not ready" (503). A stale worker
    // heartbeat degrades the report without failing platform health probes —
    // restarting the web container could not fix the worker anyway.
    { status: problems.some((p) => p !== "worker_heartbeat_stale") ? 503 : 200 }
  );
}

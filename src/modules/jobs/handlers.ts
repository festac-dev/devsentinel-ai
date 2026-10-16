import { prisma } from "@/lib/db";
import { testspriteProvider } from "@/modules/testsprite/provider";
import { notifyRunFinished } from "@/modules/github/pipeline";
import { notify } from "@/modules/notifications/send";
import { redact } from "@/lib/redact";
import { log } from "@/lib/logger";

export async function handleStartTestRun(runId: string) {
  const run = await prisma.testRun.findUnique({ where: { id: runId }, include: { pr: true, project: true } });
  if (!run) throw new Error(`Run ${runId} not found.`);
  if (run.status !== "queued") return; // idempotent: already started/finished

  const config = await testspriteProvider.checkConfiguration(run.projectId);
  if (config.state === "unconfigured") {
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: "error",
        statusReason: `TestSprite not configured: ${config.message}`,
        errorMessage: config.message,
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    await notify({
      projectId: run.projectId,
      type: "testsprite_start_failed",
      title: "TestSprite execution could not start",
      body: config.message,
      entityRef: `run:${runId}`,
      dedupKey: `start_failed:${runId}`,
    });
    return;
  }

  await prisma.testRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } });

  const testName = run.pr
    ? `PR #${run.pr.number} check — ${run.pr.title}`.slice(0, 110)
    : `Manual check — ${run.commitSha.slice(0, 7)}`;

  const rawTimeout = Number(process.env.TESTSPRITE_WAIT_TIMEOUT_SECONDS);
  try {
    const result = await testspriteProvider.startRun({
      projectId: run.projectId,
      testName,
      timeoutSeconds: Number.isFinite(rawTimeout) ? rawTimeout : undefined,
    });
    // Defensive boundary: a finished provider invocation must be terminal. A
    // queued/running result would strand the run (completedAt null, and no
    // mechanism rechecks it), so record it honestly as an error instead.
    const nonTerminal = result.status === "queued" || result.status === "running";
    const status = nonTerminal ? "error" : result.status;
    const statusReason = nonTerminal && !result.statusReason
      ? `Provider wait ended with a non-terminal status (${result.status}).`
      : result.statusReason ?? null;
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status,
        statusReason,
        errorMessage: statusReason,
        externalTestId: result.externalTestId ?? null,
        externalRunId: result.externalRunId ?? null,
        summary: result.summary ? JSON.stringify(result.summary) : null,
        summaryText: result.summaryText ?? null,
        output: result.output || null,
        outputTruncated: result.outputTruncated,
        completedAt: ["passed", "failed", "cancelled", "error", "unknown"].includes(status) ? new Date() : null,
      },
    });
    // The run's real status is committed above; post-processing (incidents,
    // notifications, GitHub status) must never overwrite it with "error".
    try {
      await notifyRunFinished(runId);
      await import("@/lib/queue").then(({ enqueue }) =>
        enqueue({ type: "publish_github_status", payload: { runId }, idempotencyKey: `publish:${runId}` })
      );
    } catch (err) {
      log.error("run finished but post-processing failed", { runId, err });
    }
  } catch (err) {
    const message = redact(String(err instanceof Error ? err.message : err)).slice(0, 500);
    await prisma.testRun.update({
      where: { id: runId },
      data: {
        status: "error",
        statusReason: `provider exception: ${message}`,
        errorMessage: message,
        completedAt: new Date(),
      },
    });
    await notifyRunFinished(runId);
  }
}

export async function handleVerifyTestsprite(projectId: string, jobId: string) {
  // Queued by the web role's "Verify" action (web never spawns the CLI);
  // the result reaches the requesting owner as a notification.
  const result = await testspriteProvider.verifyCredentials(projectId);
  let message = result.message;
  // Saves the user the CLI step of looking the id up: with exactly one TestSprite project and no id
  // set yet, use it. Anything else is left for the user to choose (the ids are listed in the message).
  if (result.ok && result.projects?.length === 1) {
    const only = result.projects[0]!;
    const current = await prisma.project.findUnique({ where: { id: projectId }, select: { testspriteProjectId: true } });
    if (current && !current.testspriteProjectId) {
      await prisma.project.update({ where: { id: projectId }, data: { testspriteProjectId: only.id } });
      message += ` Project ID ${only.id} was filled in for you.`;
    }
  }
  await notify({
    projectId,
    type: "testsprite_verify_result",
    title: result.ok ? "TestSprite credential verified" : "TestSprite credential verification failed",
    body: message,
    entityRef: `project:${projectId}`,
    dedupKey: `ts_verify:${jobId}`,
  });
}

export async function enqueueDueMonitoringChecks(): Promise<number> {
  const targets = await prisma.monitoringTarget.findMany({ where: { enabled: true } });
  const now = Date.now();
  let enqueued = 0;
  for (const target of targets) {
    const dueAt = (target.lastCheckedAt?.getTime() ?? 0) + target.intervalMinutes * 60_000;
    if (dueAt <= now) {
      await import("@/lib/queue").then(({ enqueue }) =>
        enqueue({
          type: "monitoring_check",
          payload: { targetId: target.id },
          idempotencyKey: `monitor:${target.id}:${Math.floor(now / (target.intervalMinutes * 60_000))}`,
          maxAttempts: 3,
        })
      );
      enqueued++;
    }
  }
  return enqueued;
}

export async function runRetentionCleanup() {
  const rawDays = Number(process.env.RETENTION_DAYS);
  // Mirror loadConfig's validation: an unparseable env value must fall back to
  // the documented default instead of producing a NaN cutoff that fails every
  // delete.
  const retentionDays = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 90;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  const checks = await prisma.monitoringCheck.deleteMany({ where: { checkedAt: { lt: cutoff } } });
  const runs = await prisma.testRun.updateMany({
    where: { queuedAt: { lt: cutoff }, output: { not: null } },
    data: { output: null, outputTruncated: false },
  });
  const rateLimitWindows = await prisma.rateLimitWindow.deleteMany({ where: { expiresAt: { lt: now } } });
  // Finished jobs, audit trail, webhook deliveries, notifications, expired
  // sessions, and used or expired reset tokens otherwise grow without bound
  // (ADR-010 retention). Notifications also pin their unique dedupKey forever,
  // which would suppress re-alerts for a recurring problem after the horizon.
  const jobs = await prisma.job.deleteMany({
    where: { status: { in: ["done", "dead"] }, finishedAt: { lt: cutoff } },
  });
  const auditEvents = await prisma.auditEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const webhookDeliveries = await prisma.webhookDelivery.deleteMany({ where: { receivedAt: { lt: cutoff } } });
  const notifications = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  const resetTokens = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } });
  return {
    checksDeleted: checks.count,
    runOutputsCleared: runs.count,
    rateLimitWindowsDeleted: rateLimitWindows.count,
    jobsDeleted: jobs.count,
    auditEventsDeleted: auditEvents.count,
    webhookDeliveriesDeleted: webhookDeliveries.count,
    notificationsDeleted: notifications.count,
    sessionsDeleted: sessions.count,
    resetTokensDeleted: resetTokens.count,
  };
}

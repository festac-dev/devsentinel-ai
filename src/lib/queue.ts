import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { redact } from "@/lib/redact";

/**
 * Persistent queue backed by the PostgreSQL jobs table (ADR-004/ADR-010). Jobs
 * survive restarts; retries use exponential backoff with jitter; exhausted jobs
 * land in a visible dead state. Web instances only enqueue; workers claim.
 * These are the only job types a worker knows how to run — incident rules,
 * notifications, and retention run on worker timers, not the queue.
 */
export type JobType =
  | "start_test_run"
  | "verify_testsprite"
  | "publish_github_status"
  | "monitoring_check";

export async function enqueue(input: {
  type: JobType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}) {
  if (input.idempotencyKey) {
    const existing = await prisma.job.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
  }
  try {
    return await prisma.job.create({
      data: {
        type: input.type,
        payload: JSON.stringify(input.payload),
        idempotencyKey: input.idempotencyKey ?? null,
        maxAttempts: input.maxAttempts ?? 5,
        runAfter: input.runAfter ?? new Date(),
      },
    });
  } catch (err) {
    // Concurrent enqueues with the same idempotency key can both pass the
    // pre-check above; the loser hits the unique constraint and must resolve
    // to the winner's row so the caller still gets the one true job.
    if (
      input.idempotencyKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return prisma.job.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
    }
    throw err;
  }
}

export async function claimNextJob(): Promise<{ id: string; type: string; payload: Record<string, unknown> } | null> {
  // PostgreSQL (ADR-010): claim atomically with FOR UPDATE SKIP LOCKED so any
  // number of worker replicas can drain the same queue without double-running
  // a job. The UPDATE claims and marks the job in a single statement.
  const claimed = await prisma.$queryRaw<Array<{ id: string; type: string; payload: string }>>`
    UPDATE "Job"
    SET "status" = 'running', "startedAt" = NOW(), "attempts" = "attempts" + 1
    WHERE "id" = (
      SELECT "id" FROM "Job"
      WHERE "status" = 'queued' AND "runAfter" <= NOW()
      ORDER BY "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id", "type", "payload"`;
  const row = claimed[0];
  if (!row) return null;
  return { id: row.id, type: row.type, payload: JSON.parse(row.payload) };
}

export async function completeJob(id: string) {
  await prisma.job.update({
    where: { id },
    data: { status: "done", finishedAt: new Date(), lastError: null },
  });
}

export async function failJob(id: string, error: unknown, maxAttempts: number, attempts: number) {
  const message = redact(String(error instanceof Error ? error.message : error)).slice(0, 1000);
  const dead = attempts >= maxAttempts;
  const backoffMs = Math.min(60_000, 1000 * 2 ** attempts) + Math.floor(Math.random() * 1000);
  await prisma.job.update({
    where: { id },
    data: {
      status: dead ? "dead" : "queued",
      lastError: message,
      runAfter: dead ? undefined : new Date(Date.now() + backoffMs),
      finishedAt: dead ? new Date() : null,
    },
  });
}

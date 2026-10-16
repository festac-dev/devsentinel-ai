/**
 * Retention cleanup and queue idempotency against the real schema (ADR-010).
 * Verifies that:
 *   - retention deletes finished jobs, audit events, webhook deliveries, and
 *     expired sessions/reset tokens while leaving live rows alone, and
 *   - enqueue with the same idempotency key returns the one true job even when
 *     two concurrent creates race the pre-insert check (unique-violation path).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "./helpers/testdb";

type Db = typeof import("@/lib/db");
type Queue = typeof import("@/lib/queue");
type Handlers = typeof import("@/modules/jobs/handlers");

let db: Db;
let queue: Queue;
let handlers: Handlers;

beforeAll(async () => {
  prepareTestDatabase();
  db = await import("@/lib/db");
  queue = await import("@/lib/queue");
  handlers = await import("@/modules/jobs/handlers");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

describe("runRetentionCleanup", () => {
  it("deletes finished jobs, audit events, webhook deliveries, and expired sessions/reset tokens", async () => {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days ago
    const user = await db.prisma.user.create({
      data: { email: `retention-${Date.now()}@example.com`, passwordHash: "x", name: "retention" },
    });
    const expiredSession = await db.prisma.session.create({
      data: { id: `ret-expired-${Date.now()}`, userId: user.id, expiresAt: new Date(Date.now() - 1000) },
    });
    const liveSession = await db.prisma.session.create({
      data: { id: `ret-live-${Date.now()}`, userId: user.id, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
    });
    await db.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `ret-expired-${Date.now()}`, expiresAt: new Date(Date.now() - 1000) },
    });
    await db.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `ret-live-${Date.now()}`, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    await db.prisma.job.create({
      data: { type: "start_test_run", payload: "{}", status: "done", finishedAt: old },
    });
    const pendingJob = await db.prisma.job.create({
      data: { type: "start_test_run", payload: "{}" },
    });
    await db.prisma.auditEvent.create({
      data: { userId: user.id, action: "old_event", createdAt: old },
    });
    await db.prisma.webhookDelivery.create({
      data: { deliveryId: `ret-old-${Date.now()}`, event: "pull_request", receivedAt: old },
    });
    await db.prisma.notification.create({
      data: { userId: user.id, type: "monitoring_down", title: "old", body: "old", dedupKey: `ret-old-${Date.now()}`, createdAt: old },
    });
    await db.prisma.notification.create({
      data: { userId: user.id, type: "monitoring_down", title: "new", body: "new", dedupKey: `ret-live-${Date.now()}` },
    });

    const result = await handlers.runRetentionCleanup();

    expect(result.jobsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.auditEventsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.webhookDeliveriesDeleted).toBeGreaterThanOrEqual(1);
    expect(result.notificationsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.resetTokensDeleted).toBeGreaterThanOrEqual(1);

    // Survivors: pending jobs, live sessions, unexpired reset tokens, and
    // notifications inside the retention window.
    expect(await db.prisma.job.findUnique({ where: { id: pendingJob.id } })).not.toBeNull();
    expect(await db.prisma.session.findUnique({ where: { id: liveSession.id } })).not.toBeNull();
    expect(await db.prisma.session.findUnique({ where: { id: expiredSession.id } })).toBeNull();
    expect(await db.prisma.passwordResetToken.findFirst({ where: { tokenHash: { startsWith: "ret-live" } } })).not.toBeNull();
    expect(await db.prisma.notification.findFirst({ where: { title: "new" } })).not.toBeNull();
  });

  it("falls back to the default window when RETENTION_DAYS is unparseable", async () => {
    const previous = process.env.RETENTION_DAYS;
    process.env.RETENTION_DAYS = "not-a-number";
    try {
      // An unparseable value must not produce a NaN cutoff (which would make
      // every delete throw); the documented default (90 days) applies instead.
      const result = await handlers.runRetentionCleanup();
      expect(result).toHaveProperty("checksDeleted");
    } finally {
      if (previous === undefined) delete process.env.RETENTION_DAYS;
      else process.env.RETENTION_DAYS = previous;
    }
  });
});

describe("enqueue idempotency", () => {
  it("returns the same job for repeated enqueues with one idempotency key", async () => {
    const key = `idem-test:${Date.now()}-${Math.random()}`;
    const first = await queue.enqueue({ type: "publish_github_status", payload: { runId: "r1" }, idempotencyKey: key });
    const second = await queue.enqueue({ type: "publish_github_status", payload: { runId: "r1" }, idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect(await db.prisma.job.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("resolves to a single job when two concurrent creates race the same key", async () => {
    // Both calls may pass the pre-insert check before either insert lands; the
    // loser must hit the unique constraint and resolve to the winner's row
    // instead of surfacing a Prisma P2002 error.
    const key = `idem-race:${Date.now()}-${Math.random()}`;
    const [a, b] = await Promise.all([
      queue.enqueue({ type: "monitoring_check", payload: { targetId: "t" }, idempotencyKey: key }),
      queue.enqueue({ type: "monitoring_check", payload: { targetId: "t" }, idempotencyKey: key }),
    ]);
    expect(b!.id).toBe(a!.id);
    expect(await db.prisma.job.count({ where: { idempotencyKey: key } })).toBe(1);
  });
});

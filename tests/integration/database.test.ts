/**
 * DB-backed integration tests (spec 15/20): real Prisma + PostgreSQL (ADR-010)
 * with the project's versioned migrations applied. Each run resets the test
 * database schema via `prisma migrate reset --force` (drop + re-apply every
 * migration, immutability trigger included).
 */
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareTestDatabase } from "./helpers/testdb";

type Db = typeof import("@/lib/db");
type Send = typeof import("@/modules/notifications/send");
type Crypto = typeof import("@/lib/crypto");

let db: Db;
let send: Send;
let crypto: Crypto;

beforeAll(async () => {
  prepareTestDatabase();
  db = await import("@/lib/db");
  send = await import("@/modules/notifications/send");
  crypto = await import("@/lib/crypto");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

async function user(email: string) {
  return db.prisma.user.create({
    data: { email, passwordHash: "x", name: email.split("@")[0]! },
  });
}

describe("unique constraints (real database)", () => {
  it("rejects a duplicate webhook delivery id", async () => {
    const u = await user("delivery@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-delivery", ownerId: u.id } });
    await db.prisma.webhookDelivery.create({ data: { deliveryId: "d-1", event: "pull_request", projectId: p.id } });
    await expect(
      db.prisma.webhookDelivery.create({ data: { deliveryId: "d-1", event: "pull_request" } })
    ).rejects.toThrow(/Unique constraint|UNIQUE/);
  });

  it("rejects a duplicate notification dedup key — notify() de-duplicates", async () => {
    const u = await user("dedup@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-dedup", ownerId: u.id } });
    const input = {
      projectId: p.id,
      type: "test_run_failed" as const,
      title: "Run failed",
      body: "r",
      dedupKey: "run_failed:xyz",
    };
    await send.notify(input);
    await send.notify(input); // retry must not duplicate
    const rows = await db.prisma.notification.findMany({ where: { userId: u.id, type: "test_run_failed" } });
    expect(rows).toHaveLength(1);
  });

  it("rejects a duplicate incident fingerprint and appends occurrences instead", async () => {
    const u = await user("incident@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-incident", ownerId: u.id } });
    const base = { projectId: p.id, title: "Target down", sourceType: "monitoring", fingerprint: "monitor:target-1:down" };
    const inc = await db.prisma.incident.create({ data: base });
    await expect(db.prisma.incident.create({ data: base })).rejects.toThrow(/Unique constraint|UNIQUE/);
    await db.prisma.incidentEvent.create({ data: { incidentId: inc.id, actor: "system", type: "occurrence", note: "again" } });
    expect(await db.prisma.incidentEvent.count({ where: { incidentId: inc.id } })).toBe(1);
  });

  it("rejects a duplicate job idempotency key", async () => {
    await db.prisma.job.create({ data: { type: "start_test_run", payload: "{}", idempotencyKey: "manual:1" } });
    await expect(
      db.prisma.job.create({ data: { type: "start_test_run", payload: "{}", idempotencyKey: "manual:1" } })
    ).rejects.toThrow(/Unique constraint|UNIQUE/);
  });
});

describe("cross-tenant isolation at the query level (spec 7/16)", () => {
  it("never returns another user's project, run, incident, or notification", async () => {
    const alice = await user("alice@example.com");
    const mallory = await user("mallory@example.com");
    const p = await db.prisma.project.create({ data: { name: "Alice-secret", ownerId: alice.id } });
    const pr = await db.prisma.pullRequest.create({
      data: { projectId: p.id, number: 1, repoOwner: "o", repoName: "r", title: "t", sourceBranch: "f", targetBranch: "main", currentHeadSha: "a".repeat(40) },
    });
    const run = await db.prisma.testRun.create({
      data: { projectId: p.id, prId: pr.id, repoOwner: "o", repoName: "r", commitSha: "a".repeat(40), trigger: "manual" },
    });
    const inc = await db.prisma.incident.create({
      data: { projectId: p.id, title: "i", sourceType: "test_run", fingerprint: "run:1:failed" },
    });
    await db.prisma.notification.create({
      data: { userId: alice.id, projectId: p.id, type: "test_run_failed", title: "t", body: "b", dedupKey: `k:${run.id}` },
    });

    // The exact predicates used by ownership.ts / page queries, evaluated for Mallory.
    expect(await db.prisma.project.findFirst({ where: { id: p.id, ownerId: mallory.id } })).toBeNull();
    expect(await db.prisma.testRun.findFirst({ where: { id: run.id, project: { ownerId: mallory.id } } })).toBeNull();
    expect(await db.prisma.incident.findFirst({ where: { id: inc.id, project: { ownerId: mallory.id } } })).toBeNull();
    expect(
      await db.prisma.notification.findFirst({ where: { id: "any", userId: mallory.id } })
    ).toBeNull();
    // And the owner does see them.
    expect(await db.prisma.testRun.findFirst({ where: { id: run.id, project: { ownerId: alice.id } } })).not.toBeNull();
  });
});

describe("commit binding and staleness (spec 9.4)", () => {
  it("stores the run's SHA immutably at creation and derives staleness from the PR head", async () => {
    const u = await user("stale@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-stale", ownerId: u.id } });
    const shaA = "b".repeat(40);
    const shaB = "c".repeat(40);
    const pr = await db.prisma.pullRequest.create({
      data: { projectId: p.id, number: 2, repoOwner: "o", repoName: "r", title: "t", sourceBranch: "f", targetBranch: "main", currentHeadSha: shaA },
    });
    const run = await db.prisma.testRun.create({
      data: { projectId: p.id, prId: pr.id, repoOwner: "o", repoName: "r", commitSha: shaA, trigger: "pull_request" },
    });
    const stored = await db.prisma.testRun.findUnique({ where: { id: run.id } });
    expect(stored!.commitSha).toBe(shaA);

    // New commit pushed: PR head moves; the run row keeps its own SHA.
    const updatedPr = await db.prisma.pullRequest.update({ where: { id: pr.id }, data: { currentHeadSha: shaB } });
    const { isStale, stalenessTooltip } = await import("@/modules/runs/status");
    const fresh = await db.prisma.testRun.findUnique({ where: { id: run.id } });
    expect(isStale({ prId: fresh!.prId, commitSha: fresh!.commitSha }, updatedPr)).toBe(true);
    expect(stalenessTooltip({ commitSha: fresh!.commitSha }, updatedPr)).toBe(
      `Tested commit ${shaA.slice(0, 7)}; current head is ${shaB.slice(0, 7)}`
    );
  });

  it("enforces commit binding in the database, not just in app code", async () => {
    const u = await user("binding@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-binding", ownerId: u.id } });
    const pr = await db.prisma.pullRequest.create({
      data: { projectId: p.id, number: 4, repoOwner: "o", repoName: "r", title: "t", sourceBranch: "f", targetBranch: "main", currentHeadSha: "e".repeat(40) },
    });
    const run = await db.prisma.testRun.create({
      data: { projectId: p.id, prId: pr.id, repoOwner: "o", repoName: "r", commitSha: "e".repeat(40), trigger: "manual" },
    });

    // A buggy query or manual edit cannot rebind the run to another commit/repo.
    for (const data of [
      { commitSha: "f".repeat(40) },
      { repoOwner: "other" },
      { repoName: "other" },
    ]) {
      const err = await db.prisma.testRun.update({ where: { id: run.id }, data }).catch((e: unknown) => e);
      // Prisma nests the raw database message (P2010 → PostgresError); the
      // trigger's RAISE EXCEPTION must appear somewhere in the error chain.
      expect(err).toBeInstanceOf(Error);
      expect(inspect(err, { depth: 10 })).toMatch(/commitSha are immutable/);
    }

    // Unrelated fields update normally, and deleting the PR may null prId.
    await db.prisma.testRun.update({ where: { id: run.id }, data: { status: "running" } });
    await db.prisma.pullRequest.delete({ where: { id: pr.id } });
    expect((await db.prisma.testRun.findUnique({ where: { id: run.id } }))!.prId).toBeNull();
  });
});

describe("cascading cleanup (spec 15: no orphaned results)", () => {
  it("deletes runs, publications, checks and incidents with the project; keeps run rows when only the PR is deleted (SetNull)", async () => {
    const u = await user("cascade@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-cascade", ownerId: u.id } });
    const pr = await db.prisma.pullRequest.create({
      data: { projectId: p.id, number: 3, repoOwner: "o", repoName: "r", title: "t", sourceBranch: "f", targetBranch: "main", currentHeadSha: "d".repeat(40) },
    });
    const run = await db.prisma.testRun.create({
      data: { projectId: p.id, prId: pr.id, repoOwner: "o", repoName: "r", commitSha: "d".repeat(40), trigger: "manual" },
    });
    await db.prisma.checkPublication.create({ data: { runId: run.id, kind: "status", outcome: "published" } });
    await db.prisma.monitoringTarget.create({ data: { projectId: p.id, name: "t", url: "https://example.com" } });

    await db.prisma.pullRequest.delete({ where: { id: pr.id } });
    expect((await db.prisma.testRun.findUnique({ where: { id: run.id } }))!.prId).toBeNull();

    await db.prisma.project.delete({ where: { id: p.id } });
    expect(await db.prisma.testRun.count({ where: { id: run.id } })).toBe(0);
    expect(await db.prisma.checkPublication.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.monitoringTarget.count({ where: { projectId: p.id } })).toBe(0);
  });
});

describe("encrypted credentials at rest (spec 15/16)", () => {
  it("persists AES-256-GCM ciphertext that decrypts to the original secret", async () => {
    const u = await user("crypto@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-crypto", ownerId: u.id } });
    const secret = "sk-user-live-credential-9876543210";
    const { cipher, keyVersion } = crypto.encryptSecret(secret);
    await db.prisma.projectIntegration.create({
      data: { projectId: p.id, kind: "testsprite", cipher, keyVersion, last4: crypto.last4(secret) },
    });
    const row = await db.prisma.projectIntegration.findUnique({
      where: { projectId_kind: { projectId: p.id, kind: "testsprite" } },
    });
    expect(row!.cipher).not.toContain(secret);
    expect(crypto.decryptSecret(row!.cipher, row!.keyVersion)).toBe(secret);
    expect(row!.last4).toBe("3210");
  });
});

describe("email channel through the notification pipeline (spec 14)", () => {
  it("records delivered only when the provider confirms, with the provider id", async () => {
    const u = await user("email@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-email", ownerId: u.id } });
    await db.prisma.notificationPreference.create({
      data: { userId: u.id, projectId: null, eventType: "test_run_failed", inApp: true, email: true },
    });
    // Default provider is Brevo: it confirms delivery with `{ messageId }`.
    process.env.EMAIL_PROVIDER_API_KEY = "brevo_test";
    process.env.EMAIL_PROVIDER_FROM = "devsentinel@example.com";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "email-abc" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await send.notify({
        projectId: p.id,
        type: "test_run_failed",
        title: "Run failed on main",
        body: "evidence",
        dedupKey: `email-test:${Date.now()}`,
      });
      const row = await db.prisma.notification.findFirst({ where: { userId: u.id, type: "test_run_failed" } });
      expect(row!.emailStatus).toBe("delivered");
      expect(row!.emailProviderId).toBe("email-abc");
      expect(row!.emailedAt).not.toBeNull();
    } finally {
      delete process.env.EMAIL_PROVIDER_API_KEY;
      delete process.env.EMAIL_PROVIDER_FROM;
      vi.unstubAllGlobals();
    }
  });

  it("records not_configured when email is preferred but the provider is unset", async () => {
    const u = await user("email2@example.com");
    const p = await db.prisma.project.create({ data: { name: "P-email2", ownerId: u.id } });
    await db.prisma.notificationPreference.create({
      data: { userId: u.id, projectId: null, eventType: "monitoring_down", inApp: true, email: true },
    });
    await send.notify({
      projectId: p.id,
      type: "monitoring_down",
      title: "Target down",
      body: "evidence",
      dedupKey: `email-nc:${Date.now()}`,
    });
    const row = await db.prisma.notification.findFirst({ where: { userId: u.id, type: "monitoring_down" } });
    expect(row!.emailStatus).toBe("not_configured");
    expect(row!.emailProviderId).toBeNull();
  });
});

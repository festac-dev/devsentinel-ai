/**
 * Delivery tracker integration tests against real PostgreSQL with every
 * versioned migration applied. These exercise ownership isolation, the task
 * state machine, evidence policy enforcement, verification invalidation, and
 * the report snapshot — not just the pure model functions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "./helpers/testdb";

type Db = typeof import("@/lib/db");
type Delivery = typeof import("@/modules/delivery/service");
type Model = typeof import("@/modules/delivery/model");
type InitialData = typeof import("@/modules/delivery/initial-data");

let db: Db;
let delivery: Delivery;
let model: Model;
let initialData: InitialData;

const PASSED_SHA = "a".repeat(40);
const FAILED_SHA = "b".repeat(40);

beforeAll(async () => {
  prepareTestDatabase();
  db = await import("@/lib/db");
  delivery = await import("@/modules/delivery/service");
  model = await import("@/modules/delivery/model");
  initialData = await import("@/modules/delivery/initial-data");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

async function createUser(email: string) {
  return db.prisma.user.create({
    data: { email, passwordHash: "x", name: email.split("@")[0]! },
  });
}

async function createProject(ownerId: string, name: string) {
  return db.prisma.project.create({ data: { name, ownerId } });
}

async function seedTracker(ownerId: string) {
  await delivery.ensureDeliveryTracker(ownerId);
  return db.prisma.deliveryTracker.findUniqueOrThrow({
    where: { ownerId },
    include: {
      phases: {
        orderBy: { phaseOrder: "asc" },
        include: { tasks: { orderBy: { taskOrder: "asc" }, include: { auditEvents: true } } },
      },
    },
  });
}

async function taskByKey(ownerId: string, stableKey: string) {
  const snapshot = await delivery.getDeliverySnapshot(ownerId);
  for (const phase of snapshot.tracker.phases) {
    const task = phase.tasks.find((candidate) => candidate.stableKey === stableKey);
    if (task) return task;
  }
  throw new Error(`Task ${stableKey} not found`);
}

async function createRun(projectId: string, overrides: Partial<{ source: string; status: string; commitSha: string; externalRunId: string }> = {}) {
  return db.prisma.testRun.create({
    data: {
      projectId,
      repoOwner: "owner",
      repoName: "repo",
      commitSha: overrides.commitSha ?? PASSED_SHA,
      trigger: "manual",
      source: overrides.source ?? "testsprite",
      status: overrides.status ?? "passed",
      externalRunId: overrides.externalRunId ?? null,
    },
  });
}

describe("delivery tracker seed {integration}", () => {
  it("creates four phases and sixteen tasks exactly once, preserving reported-not-verified state", async () => {
    const user = await createUser("seed@example.com");
    await delivery.ensureDeliveryTracker(user.id);
    const first = await seedTracker(user.id);
    const second = await delivery.ensureDeliveryTracker(user.id);
    expect(second.id).toBe(first.id);

    const tracker = await db.prisma.deliveryTracker.findUniqueOrThrow({
      where: { ownerId: user.id },
      include: {
        phases: { include: { tasks: { include: { auditEvents: true } } } },
      },
    });
    const tasks = tracker.phases.flatMap((phase) => phase.tasks);
    expect(tracker.phases).toHaveLength(4);
    expect(tasks).toHaveLength(16);
    expect(tracker.seedVersion).toBe(initialData.DELIVERY_SEED_VERSION);
    for (const task of tasks) {
      expect(task.status).toBe("completed");
      expect(task.verificationStatus).toBe("unverified");
      expect(task.completedAt).toBeNull();
      expect(task.verifiedAt).toBeNull();
      expect(task.auditEvents).toHaveLength(1);
      expect(task.auditEvents[0]!.action).toBe("initial_state_recorded");
      expect(task.auditEvents[0]!.actorId).toBeNull();
      expect(task.auditEvents[0]!.reason).toMatch(/not independently verified/i);
    }
    expect(await db.prisma.deliveryPhase.count({ where: { trackerId: tracker.id } })).toBe(4);
    expect(await db.prisma.deliveryTask.count({ where: { phase: { trackerId: tracker.id } } })).toBe(16);
  });
});

describe("delivery tracker ownership {integration}", () => {
  it("never lets another account read or mutate a task, evidence, or tracker it does not own", async () => {
    const alice = await createUser("owner-alice@example.com");
    const mallory = await createUser("owner-mallory@example.com");
    await seedTracker(alice.id);
    await seedTracker(mallory.id);
    const aliceTask = await taskByKey(alice.id, "p1-run-quality-gates");
    const malloryTask = await taskByKey(mallory.id, "p1-run-quality-gates");
    expect(aliceTask.id).not.toBe(malloryTask.id);

    expect(
      await delivery.updateDeliveryTaskStatus({ userId: mallory.id, taskId: aliceTask.id, status: "in_progress" })
    ).toMatchObject({ ok: false, error: "Task not found." });
    expect(
      await delivery.updateDeliveryTaskNotes({ userId: mallory.id, taskId: aliceTask.id, notes: "hijack" })
    ).toMatchObject({ ok: false, error: "Task not found." });
    expect(
      await delivery.addDeliveryEvidence({
        userId: mallory.id,
        taskId: aliceTask.id,
        evidenceType: "review_note",
        title: "hijack",
        notes: "A sufficiently long review note for the policy.",
      })
    ).toMatchObject({ ok: false, error: "Task not found." });
    expect(
      await delivery.reviewDeliveryEvidence({
        userId: mallory.id,
        evidenceId: "nonexistent",
        decision: "verify",
      })
    ).toMatchObject({ ok: false, error: "Evidence not found." });

    const aliceTaskAfter = await taskByKey(alice.id, "p1-run-quality-gates");
    expect(aliceTaskAfter.status).toBe("completed");
    expect(aliceTaskAfter.completionNotes).toBeNull();

    const aliceSnapshot = await delivery.getDeliverySnapshot(alice.id);
    const mallorySnapshot = await delivery.getDeliverySnapshot(mallory.id);
    expect(aliceSnapshot.tracker.id).not.toBe(mallorySnapshot.tracker.id);
    expect(aliceSnapshot.tracker.phases.flatMap((phase) => phase.tasks).map((task) => task.id)).not.toContain(
      malloryTask.id
    );
  });
});

describe("delivery task state machine {integration}", () => {
  it("rejects invalid transitions, persists timestamps, and audits status and note changes", async () => {
    const user = await createUser("states@example.com");
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p1-inspect-code-schema-routes-worker");

    const blockedDirectly = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "blocked",
      reason: "Cannot jump",
    });
    expect(blockedDirectly.ok).toBe(false);

    const started = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "in_progress",
      reason: "Reopening for evidence work.",
    });
    expect(started.ok).toBe(true);

    const completed = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "completed",
      reason: "Evidence work complete.",
    });
    expect(completed.ok).toBe(true);

    const after = await db.prisma.deliveryTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("completed");
    expect(after.completedAt).toBeInstanceOf(Date);
    expect(after.verificationStatus).toBe("unverified");

    const notes = await delivery.updateDeliveryTaskNotes({
      userId: user.id,
      taskId: task.id,
      notes: "Inspected the code and recorded the file paths.",
    });
    expect(notes.ok).toBe(true);

    const events = await db.prisma.deliveryAuditEvent.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["initial_state_recorded", "status_changed", "notes_updated"])
    );
    expect(events.filter((event) => event.action === "status_changed")).toHaveLength(2);
    expect(events.every((event) => event.actorId === user.id || event.actorId === null)).toBe(true);
  });
});

describe("delivery evidence lifecycle {integration}", () => {
  it("attaches evidence as pending, verifies only by explicit review, and feeds the report truthfully", async () => {
    const user = await createUser("evidence@example.com");
    const project = await createProject(user.id, "Evidence project");
    const run = await createRun(project.id);
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p1-run-quality-gates");

    const missingSource = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Quality gates",
    });
    expect(missingSource.ok).toBe(false);
    if (!missingSource.ok) expect(missingSource.error).toMatch(/requires a linked test run/i);

    const added = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Quality gates passed",
      sourceRecordRef: `test_run:${run.id}`,
      sourceCommitSha: PASSED_SHA,
    });
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.message).toMatch(/does not verify/i);

    const pending = await taskByKey(user.id, "p1-run-quality-gates");
    expect(pending.verificationStatus).toBe("pending_review");
    expect(pending.verifiedAt).toBeNull();
    const evidence = pending.evidence[0]!;
    expect(evidence.verificationStatus).toBe("pending_review");
    expect(evidence.sourceRecordType).toBe("test_run");
    expect(evidence.sourceRecordId).toBe(run.id);

    const other = await createUser("evidence-other@example.com");
    const crossOwnerReview = await delivery.reviewDeliveryEvidence({
      userId: other.id,
      evidenceId: evidence.id,
      decision: "verify",
    });
    expect(crossOwnerReview.ok).toBe(false);

    const verified = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "verify",
      note: "Reviewed the linked final test run at the exact tested commit.",
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.message).toMatch(/internal record/i);

    const after = await taskByKey(user.id, "p1-run-quality-gates");
    expect(after.verificationStatus).toBe("verified");
    expect(after.verifiedAt).toBeInstanceOf(Date);
    expect(after.verifiedBy).toBe(user.id);
    expect(after.evidence[0]!.verificationStatus).toBe("verified");
    expect(after.evidence[0]!.verificationBasis).toBe("internal_record");

    const snapshot = await delivery.getDeliverySnapshot(user.id);
    const readiness = model.evaluateSubmissionReadiness(snapshot);
    expect(readiness.ready).toBe(false);
    expect(readiness.criteria.find((criterion) => criterion.key === "evidence_verified")!.detail).toContain("1 of 16");
    const report = model.buildDeliveryReport(snapshot, {
      generatedAt: new Date("2026-03-03T00:00:00Z"),
      sourceRevision: PASSED_SHA,
    });
    expect(report).toContain("Quality gates passed");
    expect(report).toContain("1 of 16 tasks verified");

    const audit = await db.prisma.deliveryAuditEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(["evidence_added", "evidence_verified"])
    );
  });

  it("refuses a result-bearing evidence type without the required linked record", async () => {
    const user = await createUser("evidence-guard@example.com");
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p1-audit-security-boundaries");

    const withoutRun = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "testsprite_execution",
      title: "Provider execution",
    });
    expect(withoutRun.ok).toBe(false);

    const fakeHealth = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "deployment_health",
      title: "Healthy",
      referenceUrl: "https://devsentinel-ai-festac.vercel.app",
    });
    expect(fakeHealth.ok).toBe(false);
    if (!fakeHealth.ok) expect(fakeHealth.error).toMatch(/linked monitoring check/i);
  });

  it("invalidates prior verification when the completion claim changes", async () => {
    const user = await createUser("invalidate@example.com");
    const project = await createProject(user.id, "Invalidate project");
    const run = await createRun(project.id);
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p2-improve-onboarding-diagnostics");

    await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Run",
      sourceRecordRef: `test_run:${run.id}`,
    });
    const evidence = (await taskByKey(user.id, task.stableKey)).evidence[0]!;
    const verified = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "verify",
      note: "Reviewed the linked run.",
    });
    expect(verified.ok).toBe(true);

    const reopen = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "in_progress",
      reason: "The claim changed and needs a new run.",
    });
    expect(reopen.ok).toBe(true);
    if (reopen.ok) expect(reopen.message).toMatch(/invalidated/i);

    const invalidated = await db.prisma.deliveryTask.findUniqueOrThrow({
      where: { id: task.id },
      include: { evidence: true },
    });
    expect(invalidated.verificationStatus).toBe("unverified");
    expect(invalidated.verifiedAt).toBeNull();
    expect(invalidated.verifiedBy).toBeNull();
    expect(invalidated.evidence[0]!.verificationStatus).toBe("pending_review");
    expect(invalidated.evidence[0]!.verificationBasis).toBeNull();

    const reviewWhileOpen = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "verify",
    });
    expect(reviewWhileOpen.ok).toBe(false);
    if (!reviewWhileOpen.ok) expect(reviewWhileOpen.error).toMatch(/completed task/i);

    const events = await db.prisma.deliveryAuditEvent.findMany({ where: { taskId: task.id } });
    expect(events.some((event) => event.action === "verification_invalidated")).toBe(true);
  });

  it("preserves pending evidence state across a reopen and re-complete", async () => {
    const user = await createUser("pending-roundtrip@example.com");
    const project = await createProject(user.id, "Pending roundtrip project");
    const run = await createRun(project.id);
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p2-build-evidence-timelines");

    await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Pending run",
      sourceRecordRef: `test_run:${run.id}`,
    });
    expect((await taskByKey(user.id, task.stableKey)).verificationStatus).toBe("pending_review");

    const reopened = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "in_progress",
      reason: "Checking a follow-up before final review.",
    });
    expect(reopened.ok).toBe(true);
    expect((await taskByKey(user.id, task.stableKey)).verificationStatus).toBe("unverified");

    const recompleted = await delivery.updateDeliveryTaskStatus({
      userId: user.id,
      taskId: task.id,
      status: "completed",
      reason: "Follow-up checked.",
    });
    expect(recompleted.ok).toBe(true);
    const after = await taskByKey(user.id, task.stableKey);
    expect(after.verificationStatus).toBe("pending_review");
    expect(after.evidence[0]!.verificationStatus).toBe("pending_review");
  });

  it("supports explicit rejection and does not mark the task verified", async () => {
    const user = await createUser("reject@example.com");
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p3-harden-queue-lifecycle");

    const added = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "review_note",
      title: "Insufficient note",
      notes: "too short",
    });
    expect(added.ok).toBe(true);
    const evidence = (await taskByKey(user.id, task.stableKey)).evidence[0]!;

    const refused = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "verify",
      note: "short",
    });
    expect(refused.ok).toBe(false);

    const rejected = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "reject",
      note: "The note does not establish what was reviewed.",
    });
    expect(rejected.ok).toBe(true);

    const after = await taskByKey(user.id, task.stableKey);
    expect(after.verificationStatus).toBe("rejected");
    expect(after.evidence[0]!.verificationStatus).toBe("rejected");
    expect(after.verifiedAt).toBeNull();
    const failedAudit = await db.prisma.deliveryAuditEvent.findMany({ where: { taskId: task.id } });
    expect(failedAudit.some((event) => event.action === "evidence_verification_failed")).toBe(true);
    expect(failedAudit.some((event) => event.action === "evidence_rejected")).toBe(true);
  });
});

describe("delivery evidence source ownership and health policy {integration}", () => {
  it("rejects a linked record owned by another account", async () => {
    const alice = await createUser("source-alice@example.com");
    const mallory = await createUser("source-mallory@example.com");
    const aliceProject = await createProject(alice.id, "Alice project");
    const aliceRun = await createRun(aliceProject.id);
    await seedTracker(mallory.id);
    const malloryTask = await taskByKey(mallory.id, "p4-connect-real-providers");

    const result = await delivery.addDeliveryEvidence({
      userId: mallory.id,
      taskId: malloryTask.id,
      evidenceType: "test_run",
      title: "Borrowed run",
      sourceRecordRef: `test_run:${aliceRun.id}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found in your account/i);
    expect(await db.prisma.taskEvidence.count({ where: { taskId: malloryTask.id } })).toBe(0);
  });

  it("requires a successful monitoring check for deployment-health evidence", async () => {
    const user = await createUser("health@example.com");
    const project = await createProject(user.id, "Health project");
    const target = await db.prisma.monitoringTarget.create({
      data: { projectId: project.id, name: "Production", url: "https://example.com" },
    });
    const failing = await db.prisma.monitoringCheck.create({
      data: { targetId: target.id, outcome: "failure", statusCode: 503 },
    });
    const passing = await db.prisma.monitoringCheck.create({
      data: { targetId: target.id, outcome: "success", statusCode: 200 },
    });
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p1-verify-deployment-health");

    const refused = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "deployment_health",
      title: "Failed check",
      sourceRecordRef: `monitoring_check:${failing.id}`,
    });
    expect(refused.ok).toBe(false);

    const accepted = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "deployment_health",
      title: "Successful production check",
      sourceRecordRef: `monitoring_check:${passing.id}`,
    });
    expect(accepted.ok).toBe(true);
    const evidence = (await taskByKey(user.id, task.stableKey)).evidence[0]!;
    const verified = await delivery.reviewDeliveryEvidence({
      userId: user.id,
      evidenceId: evidence.id,
      decision: "verify",
    });
    expect(verified.ok).toBe(true);
    expect((await taskByKey(user.id, task.stableKey)).verificationStatus).toBe("verified");
  });

  it("rejects a simulated demonstration run as verification evidence", async () => {
    const user = await createUser("demo-run@example.com");
    const project = await createProject(user.id, "Demo project");
    const demo = await createRun(project.id, { source: "demo" });
    await seedTracker(user.id);
    const task = await taskByKey(user.id, "p4-publish-reproducible-evidence");

    const result = await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Demo",
      sourceRecordRef: `test_run:${demo.id}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/simulated demonstration/i);
  });
});

describe("delivery tracker cascade {integration}", () => {
  it("deletes the tracker, tasks, evidence, and audit events with the owner", async () => {
    const user = await createUser("cascade-delivery@example.com");
    const project = await createProject(user.id, "Cascade project");
    const run = await createRun(project.id);
    const tracker = await seedTracker(user.id);
    const task = await taskByKey(user.id, "p2-build-evidence-timelines");
    await delivery.addDeliveryEvidence({
      userId: user.id,
      taskId: task.id,
      evidenceType: "test_run",
      title: "Run",
      sourceRecordRef: `test_run:${run.id}`,
    });
    const evidenceId = (await taskByKey(user.id, task.stableKey)).evidence[0]!.id;

    await db.prisma.user.delete({ where: { id: user.id } });
    expect(await db.prisma.deliveryTracker.count({ where: { id: tracker.id } })).toBe(0);
    expect(await db.prisma.deliveryPhase.count({ where: { trackerId: tracker.id } })).toBe(0);
    expect(await db.prisma.taskEvidence.count({ where: { id: evidenceId } })).toBe(0);
    expect(await db.prisma.deliveryAuditEvent.count({ where: { taskId: task.id } })).toBe(0);
  });

  it("keeps the failed SHA constant distinct from the passing one", () => {
    expect(FAILED_SHA).not.toBe(PASSED_SHA);
    expect(model.normalizeCommitSha(FAILED_SHA)).toBe(FAILED_SHA);
  });
});

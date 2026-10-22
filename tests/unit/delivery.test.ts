import { describe, expect, it } from "vitest";
import { INITIAL_DELIVERY_PHASES, DELIVERY_METADATA, DELIVERY_SEED_VERSION } from "@/modules/delivery/initial-data";
import {
  buildDeliveryReport,
  canTransitionTask,
  deriveTaskVerificationStatus,
  deriveVerificationStatus,
  evaluateEvidencePolicy,
  evaluateSubmissionReadiness,
  isSafeArtifactReference,
  normalizeCommitSha,
  overallStats,
  phaseStats,
  sourceRevisionFromEnv,
  type DeliveryEvidenceView,
  type DeliverySnapshot,
  type DeliveryTaskView,
} from "@/modules/delivery/model";

const SHA = "a".repeat(40);

function evidence(overrides: Partial<DeliveryEvidenceView> = {}): DeliveryEvidenceView {
  return {
    id: "evidence-1",
    evidenceType: "test_run",
    title: "Real run",
    referenceUrl: null,
    artifactReference: null,
    sourceCommitSha: SHA,
    sourceRecordType: "test_run",
    sourceRecordId: "run-1",
    notes: null,
    verificationStatus: "verified",
    verificationBasis: "internal_record",
    submittedBy: "user-1",
    verifiedAt: new Date("2026-01-01T00:00:00Z"),
    verifiedBy: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    submitter: { name: "Owner" },
    verifier: { name: "Owner" },
    ...overrides,
  };
}

function task(overrides: Partial<DeliveryTaskView> = {}): DeliveryTaskView {
  return {
    id: "task-1",
    stableKey: "task-1",
    title: "Task",
    description: "Task description",
    status: "completed",
    verificationStatus: "unverified",
    completionNotes: null,
    taskOrder: 1,
    completedAt: null,
    verifiedAt: null,
    verifiedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    evidence: [],
    auditEvents: [],
    verifier: null,
    ...overrides,
  };
}

function initialSnapshot(): DeliverySnapshot {
  const phases = INITIAL_DELIVERY_PHASES.map((phase) => ({
    id: `phase-${phase.phaseOrder}`,
    stableKey: phase.stableKey,
    title: phase.title,
    description: phase.description,
    phaseOrder: phase.phaseOrder,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    tasks: phase.tasks.map((item) => ({
      ...task({
        id: item.stableKey,
        stableKey: item.stableKey,
        title: item.title,
        description: item.description,
        taskOrder: item.taskOrder,
      }),
    })),
  }));
  return {
    tracker: {
      id: "tracker-1",
      title: DELIVERY_METADATA.title,
      description: DELIVERY_METADATA.description,
      liveUrl: DELIVERY_METADATA.liveUrl,
      repositoryUrl: DELIVERY_METADATA.repositoryUrl,
      seedVersion: DELIVERY_SEED_VERSION,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      phases,
    },
    lastUpdated: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("delivery progress {unit}", () => {
  it("derives completion and verification independently from actual tasks", () => {
    const snapshot = initialSnapshot();
    const stats = overallStats(snapshot);
    expect(stats.total).toBe(16);
    expect(stats.completed).toBe(16);
    expect(stats.completionPercent).toBe(100);
    expect(stats.verified).toBe(0);
    expect(stats.verificationPercent).toBe(0);
    expect(stats.completedUnverified).toBe(16);
  });

  it("calculates phase completion and verification from task records", () => {
    const phase = initialSnapshot().tracker.phases[0]!;
    const allComplete = phaseStats(phase.tasks);
    expect(allComplete.fullyCompleted).toBe(true);
    expect(allComplete.fullyVerified).toBe(false);

    const mixed = phaseStats([
      task({ status: "completed", verificationStatus: "verified" }),
      task({ id: "t2", status: "completed" }),
      task({ id: "t3", status: "in_progress" }),
      task({ id: "t4", status: "blocked" }),
    ]);
    expect(mixed.completed).toBe(2);
    expect(mixed.inProgress).toBe(1);
    expect(mixed.blocked).toBe(1);
    expect(mixed.completionPercent).toBe(50);
    expect(mixed.verificationPercent).toBe(25);
    expect(mixed.fullyCompleted).toBe(false);
    expect(mixed.fullyVerified).toBe(false);
  });

  it("treats an empty phase as neither complete nor verified", () => {
    const stats = phaseStats([]);
    expect(stats.completionPercent).toBe(0);
    expect(stats.fullyCompleted).toBe(false);
    expect(stats.fullyVerified).toBe(false);
  });
});

describe("delivery status model {unit}", () => {
  it("accepts only listed transitions and rejects same-state writes", () => {
    expect(canTransitionTask("pending", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "completed")).toBe(true);
    expect(canTransitionTask("blocked", "in_progress")).toBe(true);
    expect(canTransitionTask("completed", "in_progress")).toBe(true);
    expect(canTransitionTask("completed", "completed")).toBe(false);
    expect(canTransitionTask("blocked", "completed")).toBe(false);
    expect(canTransitionTask("completed", "blocked")).toBe(false);
  });

  it("derives verification from evidence only for completed tasks", () => {
    expect(deriveVerificationStatus([])).toBe("unverified");
    expect(deriveVerificationStatus(["pending_review"])).toBe("pending_review");
    expect(deriveVerificationStatus(["rejected"])).toBe("rejected");
    expect(deriveVerificationStatus(["pending_review", "verified"])).toBe("verified");
    expect(deriveTaskVerificationStatus("completed", ["verified"])).toBe("verified");
    expect(deriveTaskVerificationStatus("in_progress", ["verified"])).toBe("unverified");
  });

  it("requires evidence and verification before readiness, not just 100% completion", () => {
    const snapshot = initialSnapshot();
    const initial = evaluateSubmissionReadiness(snapshot);
    expect(initial.ready).toBe(false);
    expect(initial.criteria.find((c) => c.key === "all_tasks_completed")!.met).toBe(true);
    expect(initial.criteria.find((c) => c.key === "evidence_verified")!.met).toBe(false);

    for (const phase of snapshot.tracker.phases) {
      for (const item of phase.tasks) {
        item.evidence = [evidence({ id: `evidence-${item.id}`, sourceRecordId: `run-${item.id}` })];
        item.verificationStatus = "verified";
      }
    }
    const ready = evaluateSubmissionReadiness(snapshot);
    expect(ready.ready).toBe(true);
    expect(ready.metCount).toBe(ready.criteria.length);

    snapshot.tracker.phases[0]!.tasks[0]!.evidence.push(
      evidence({ id: "pending", verificationStatus: "pending_review" })
    );
    expect(evaluateSubmissionReadiness(snapshot).ready).toBe(false);
  });
});

describe("evidence verification policy {unit}", () => {
  const base = {
    referenceUrl: null,
    artifactReference: null,
    sourceCommitSha: SHA,
    notes: null,
    sourceRecord: null,
  };

  it("accepts a final, non-demo test run bound to the evidence commit", () => {
    const result = evaluateEvidencePolicy({
      ...base,
      evidenceType: "test_run",
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "testsprite", status: "passed", commitSha: SHA, externalRunId: "ts-1" },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basis).toBe("internal_record");
  });

  it("rejects demo runs, unfinished runs, and commit mismatches", () => {
    const demo = evaluateEvidencePolicy({
      ...base,
      evidenceType: "test_run",
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "demo", status: "passed", commitSha: SHA, externalRunId: null },
      },
    });
    expect(demo.ok).toBe(false);

    const running = evaluateEvidencePolicy({
      ...base,
      evidenceType: "test_run",
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "testsprite", status: "running", commitSha: SHA, externalRunId: null },
      },
    });
    expect(running.ok).toBe(false);

    const mismatch = evaluateEvidencePolicy({
      ...base,
      evidenceType: "test_run",
      sourceCommitSha: "b".repeat(40),
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "testsprite", status: "passed", commitSha: SHA, externalRunId: null },
      },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.reason).toMatch(/does not match/);
  });

  it("distinguishes a genuine TestSprite execution from other runs", () => {
    const result = evaluateEvidencePolicy({
      ...base,
      evidenceType: "testsprite_execution",
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "local", status: "passed", commitSha: SHA, externalRunId: null },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/TestSprite/);

    const noProviderId = evaluateEvidencePolicy({
      ...base,
      evidenceType: "testsprite_execution",
      sourceRecord: {
        type: "test_run",
        id: "run-1",
        label: "run",
        testRun: { source: "testsprite", status: "passed", commitSha: SHA, externalRunId: null },
      },
    });
    expect(noProviderId.ok).toBe(false);
  });

  it("requires an actual successful monitoring check for deployment health", () => {
    const unlinked = evaluateEvidencePolicy({ ...base, evidenceType: "deployment_health" });
    expect(unlinked.ok).toBe(false);

    const failed = evaluateEvidencePolicy({
      ...base,
      evidenceType: "deployment_health",
      sourceRecord: {
        type: "monitoring_check",
        id: "check-1",
        label: "check",
        monitoringCheck: { outcome: "failure" },
      },
    });
    expect(failed.ok).toBe(false);

    const success = evaluateEvidencePolicy({
      ...base,
      evidenceType: "deployment_health",
      sourceRecord: {
        type: "monitoring_check",
        id: "check-1",
        label: "check",
        monitoringCheck: { outcome: "success" },
      },
    });
    expect(success.ok).toBe(true);
  });

  it("requires a GitHub reference, tested SHA, and observed conclusion for checks", () => {
    const missingSha = evaluateEvidencePolicy({
      ...base,
      evidenceType: "github_check",
      sourceCommitSha: null,
      referenceUrl: "https://github.com/owner/repo/commit/" + SHA,
      notes: "Check observed as successful at 2026-01-01.",
    });
    expect(missingSha.ok).toBe(false);

    const missingNote = evaluateEvidencePolicy({
      ...base,
      evidenceType: "github_check",
      referenceUrl: "https://github.com/owner/repo/commit/" + SHA,
    });
    expect(missingNote.ok).toBe(false);

    const valid = evaluateEvidencePolicy({
      ...base,
      evidenceType: "github_check",
      referenceUrl: "https://github.com/owner/repo/commit/" + SHA,
      notes: "Observed check conclusion: success. Reviewed 2026-01-01.",
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.basis).toBe("reference_review");
  });

  it("does not represent a self-recorded security review as an audit", () => {
    const short = evaluateEvidencePolicy({
      ...base,
      evidenceType: "security_review",
      referenceUrl: "https://example.com/review",
      notes: "Reviewed.",
    });
    expect(short.ok).toBe(false);

    const valid = evaluateEvidencePolicy({
      ...base,
      evidenceType: "security_review",
      referenceUrl: "https://example.com/review",
      notes: "Scope: auth and SSRF. Method: code review. Date: 2026-01-01. Result: no critical findings. Reviewer: owner.",
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.summary).toMatch(/not an independent/);
  });

  it("rejects unsafe artifact references and malformed commit SHAs", () => {
    expect(isSafeArtifactReference("docs/evidence/report.txt")).toBe(true);
    expect(isSafeArtifactReference("/etc/passwd")).toBe(false);
    expect(isSafeArtifactReference("../secrets.txt")).toBe(false);
    expect(isSafeArtifactReference("https://example.com/file")).toBe(false);
    expect(normalizeCommitSha(SHA)).toBe(SHA);
    expect(normalizeCommitSha("abc123")).toBeNull();
  });
});

describe("delivery report {unit}", () => {
  it("reflects reported completion honestly and marks verification absent", () => {
    const report = buildDeliveryReport(initialSnapshot(), {
      generatedAt: new Date("2026-02-02T03:04:05Z"),
      sourceRevision: null,
    });
    expect(report).toContain("# DevSentinel AI — Delivery and Verification Report");
    expect(report).toContain("## 1. Executive summary");
    expect(report).toContain("## 6. Phase 4 — Real Integrations");
    expect(report).toContain("## 11. Conclusion");
    expect(report).toContain("Source revision: **not recorded**");
    expect(report).toContain("Reported status: **completed**");
    expect(report).toContain("Evidence verification: **unverified**");
    expect(report).toContain("No test-execution evidence is recorded in this tracker");
    expect(report).toContain("not submission-ready");
    expect(report).toContain("no recorded completion timestamp");
    expect(report).not.toMatch(/all tests pass/i);
    expect(report).not.toMatch(/real integration verified/i);
  });

  it("includes only the actual recorded evidence and its verification basis", () => {
    const snapshot = initialSnapshot();
    const first = snapshot.tracker.phases[0]!.tasks[0]!;
    first.verificationStatus = "verified";
    first.verifiedAt = new Date("2026-01-02T00:00:00Z");
    first.verifier = { name: "Owner" };
    first.evidence = [evidence()];
    const report = buildDeliveryReport(snapshot, {
      generatedAt: new Date("2026-02-02T03:04:05Z"),
      sourceRevision: "b".repeat(40),
    });
    expect(report).toContain("**Real run**");
    expect(report).toContain("Source revision: **" + "b".repeat(40) + "**");
    expect(report).toContain("1 of 16 tasks verified");
    expect(report).toContain("basis: internal\\_record");
  });

  it("reads a source revision only from recognized platform environment variables", () => {
    expect(sourceRevisionFromEnv({ VERCEL_GIT_COMMIT_SHA: SHA } as unknown as NodeJS.ProcessEnv)).toBe(SHA);
    expect(sourceRevisionFromEnv({ GIT_COMMIT_SHA: "not-a-sha" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(sourceRevisionFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
});

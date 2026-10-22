import { Prisma } from "@prisma/client";
import { prisma, withAdvisoryLock } from "@/lib/db";
import { redact } from "@/lib/redact";
import { validateMonitorUrl } from "@/modules/monitoring/ssrf";
import {
  DELIVERY_METADATA,
  DELIVERY_SEED_VERSION,
  INITIAL_DELIVERY_PHASES,
} from "./initial-data";
import {
  allowedTaskTransitions,
  canTransitionTask,
  deriveTaskVerificationStatus,
  evaluateEvidencePolicy,
  isEvidenceType,
  isSafeArtifactReference,
  isTaskStatus,
  latestTrackerTimestamp,
  normalizeCommitSha,
  type DeliveryAuditView,
  type DeliveryEvidenceView,
  type DeliveryPhaseView,
  type DeliverySnapshot,
  type DeliveryTaskView,
  type DeliveryTrackerView,
  type EvidenceSourceRecord,
  type EvidenceType,
  type TaskStatus,
} from "./model";

export type DeliveryMutationResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

const INITIAL_AUDIT_REASON =
  "Initial reported state supplied by the implementation checklist. It was not independently verified; evidence and an authorized review are still required.";

/**
 * Idempotently create the versioned four-phase tracker for an owner.
 *
 * Safe to call on every page load: the advisory lock serializes concurrent
 * initialization, existing phases/tasks are never updated, and only missing
 * records are inserted. Seed audit events are created only with the task.
 */
export async function ensureDeliveryTracker(ownerId: string): Promise<{ id: string }> {
  return withAdvisoryLock(`delivery-init:${ownerId}`, async (tx) => {
    let tracker = await tx.deliveryTracker.findUnique({ where: { ownerId } });
    if (!tracker) {
      tracker = await tx.deliveryTracker.create({
        data: {
          ownerId,
          seedVersion: DELIVERY_SEED_VERSION,
          title: DELIVERY_METADATA.title,
          description: DELIVERY_METADATA.description,
          liveUrl: DELIVERY_METADATA.liveUrl,
          repositoryUrl: DELIVERY_METADATA.repositoryUrl,
        },
      });
    }

    for (const phase of INITIAL_DELIVERY_PHASES) {
      let phaseRow = await tx.deliveryPhase.findUnique({
        where: { trackerId_stableKey: { trackerId: tracker.id, stableKey: phase.stableKey } },
      });
      if (!phaseRow) {
        phaseRow = await tx.deliveryPhase.create({
          data: {
            trackerId: tracker.id,
            stableKey: phase.stableKey,
            title: phase.title,
            description: phase.description,
            phaseOrder: phase.phaseOrder,
          },
        });
      }

      for (const task of phase.tasks) {
        const existing = await tx.deliveryTask.findUnique({
          where: { phaseId_stableKey: { phaseId: phaseRow.id, stableKey: task.stableKey } },
        });
        if (existing) continue;

        const created = await tx.deliveryTask.create({
          data: {
            phaseId: phaseRow.id,
            stableKey: task.stableKey,
            title: task.title,
            description: task.description,
            taskOrder: task.taskOrder,
            status: "completed",
            verificationStatus: "unverified",
            completedAt: null,
          },
        });
        await tx.deliveryAuditEvent.create({
          data: {
            taskId: created.id,
            actorId: null,
            previousStatus: null,
            newStatus: "completed",
            action: "initial_state_recorded",
            reason: INITIAL_AUDIT_REASON,
            metadata: redact(
              JSON.stringify({ seedVersion: DELIVERY_SEED_VERSION, source: "supplied_checklist" })
            ),
          },
        });
      }
    }

    if (tracker.seedVersion < DELIVERY_SEED_VERSION) {
      tracker = await tx.deliveryTracker.update({
        where: { id: tracker.id },
        data: { seedVersion: DELIVERY_SEED_VERSION },
      });
    }
    return { id: tracker.id };
  });
}

function mapEvidence(evidence: {
  id: string;
  evidenceType: string;
  title: string;
  referenceUrl: string | null;
  artifactReference: string | null;
  sourceCommitSha: string | null;
  sourceRecordType: string | null;
  sourceRecordId: string | null;
  notes: string | null;
  verificationStatus: string;
  verificationBasis: string | null;
  submittedBy: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  submitter: { name: string } | null;
  verifier: { name: string } | null;
}): DeliveryEvidenceView {
  return {
    id: evidence.id,
    evidenceType: evidence.evidenceType,
    title: evidence.title,
    referenceUrl: evidence.referenceUrl,
    artifactReference: evidence.artifactReference,
    sourceCommitSha: evidence.sourceCommitSha,
    sourceRecordType: evidence.sourceRecordType,
    sourceRecordId: evidence.sourceRecordId,
    notes: evidence.notes,
    verificationStatus: evidence.verificationStatus,
    verificationBasis: evidence.verificationBasis,
    submittedBy: evidence.submittedBy,
    verifiedAt: evidence.verifiedAt,
    verifiedBy: evidence.verifiedBy,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
    submitter: evidence.submitter,
    verifier: evidence.verifier,
  };
}

function mapAudit(event: {
  id: string;
  actorId: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  action: string;
  reason: string | null;
  metadata: string | null;
  createdAt: Date;
  actor: { name: string } | null;
}): DeliveryAuditView {
  return {
    id: event.id,
    actorId: event.actorId,
    previousStatus: event.previousStatus,
    newStatus: event.newStatus,
    action: event.action,
    reason: event.reason,
    metadata: event.metadata,
    createdAt: event.createdAt,
    actor: event.actor,
  };
}

function mapTask(task: {
  id: string;
  stableKey: string;
  title: string;
  description: string;
  status: string;
  verificationStatus: string;
  completionNotes: string | null;
  taskOrder: number;
  completedAt: Date | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  verifier: { name: string } | null;
  evidence: Parameters<typeof mapEvidence>[0][];
  auditEvents: Parameters<typeof mapAudit>[0][];
}): DeliveryTaskView {
  return {
    id: task.id,
    stableKey: task.stableKey,
    title: task.title,
    description: task.description,
    status: task.status,
    verificationStatus: task.verificationStatus,
    completionNotes: task.completionNotes,
    taskOrder: task.taskOrder,
    completedAt: task.completedAt,
    verifiedAt: task.verifiedAt,
    verifiedBy: task.verifiedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    verifier: task.verifier,
    evidence: task.evidence.map(mapEvidence),
    auditEvents: task.auditEvents.map(mapAudit),
  };
}

/** Load the owner's tracker snapshot; initializes it when absent. */
export async function getDeliverySnapshot(ownerId: string): Promise<DeliverySnapshot> {
  await ensureDeliveryTracker(ownerId);

  const tracker = await prisma.deliveryTracker.findUnique({
    where: { ownerId },
    include: {
      phases: {
        orderBy: { phaseOrder: "asc" },
        include: {
          tasks: {
            orderBy: { taskOrder: "asc" },
            include: {
              verifier: { select: { name: true } },
              evidence: {
                orderBy: { createdAt: "desc" },
                include: {
                  submitter: { select: { name: true } },
                  verifier: { select: { name: true } },
                },
              },
              auditEvents: {
                orderBy: { createdAt: "desc" },
                include: { actor: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!tracker) throw new Error("Delivery tracker could not be initialized.");

  const trackerView: DeliveryTrackerView = {
    id: tracker.id,
    title: tracker.title,
    description: tracker.description,
    liveUrl: tracker.liveUrl,
    repositoryUrl: tracker.repositoryUrl,
    seedVersion: tracker.seedVersion,
    createdAt: tracker.createdAt,
    updatedAt: tracker.updatedAt,
    phases: tracker.phases.map(
      (phase): DeliveryPhaseView => ({
        id: phase.id,
        stableKey: phase.stableKey,
        title: phase.title,
        description: phase.description,
        phaseOrder: phase.phaseOrder,
        createdAt: phase.createdAt,
        updatedAt: phase.updatedAt,
        tasks: phase.tasks.map(mapTask),
      })
    ),
  };

  const snapshot: DeliverySnapshot = {
    tracker: trackerView,
    lastUpdated: tracker.updatedAt,
  };
  snapshot.lastUpdated = latestTrackerTimestamp(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Evidence sources
// ---------------------------------------------------------------------------

export type EvidenceLinkOption = {
  value: string;
  label: string;
  type: EvidenceSourceRecord["type"];
};

export async function getEvidenceLinkOptions(ownerId: string): Promise<EvidenceLinkOption[]> {
  const [runs, checks, incidents, pullRequests] = await Promise.all([
    prisma.testRun.findMany({
      where: { project: { ownerId } },
      orderBy: { queuedAt: "desc" },
      take: 25,
      select: {
        id: true,
        status: true,
        source: true,
        commitSha: true,
        repoOwner: true,
        repoName: true,
        externalRunId: true,
      },
    }),
    prisma.monitoringCheck.findMany({
      where: { target: { project: { ownerId } } },
      orderBy: { checkedAt: "desc" },
      take: 25,
      select: {
        id: true,
        outcome: true,
        checkedAt: true,
        target: { select: { name: true } },
      },
    }),
    prisma.incident.findMany({
      where: { project: { ownerId } },
      orderBy: { openedAt: "desc" },
      take: 25,
      select: { id: true, title: true, status: true, openedAt: true },
    }),
    prisma.pullRequest.findMany({
      where: { project: { ownerId } },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        number: true,
        repoOwner: true,
        repoName: true,
        title: true,
        currentHeadSha: true,
      },
    }),
  ]);

  return [
    ...runs.map((run) => ({
      value: `test_run:${run.id}`,
      type: "test_run" as const,
      label: `Test run · ${run.repoOwner}/${run.repoName} · ${run.commitSha.slice(0, 7)} · ${run.status} · ${run.source}${run.externalRunId ? ` · provider ${run.externalRunId}` : ""}`,
    })),
    ...checks.map((check) => ({
      value: `monitoring_check:${check.id}`,
      type: "monitoring_check" as const,
      label: `Monitoring · ${check.target.name} · ${check.outcome} · ${check.checkedAt.toISOString().slice(0, 16)}`,
    })),
    ...incidents.map((incident) => ({
      value: `incident:${incident.id}`,
      type: "incident" as const,
      label: `Incident · ${incident.title} · ${incident.status}`,
    })),
    ...pullRequests.map((pr) => ({
      value: `pull_request:${pr.id}`,
      type: "pull_request" as const,
      label: `Pull request · ${pr.repoOwner}/${pr.repoName} #${pr.number} · ${pr.title} · head ${pr.currentHeadSha.slice(0, 7)}`,
    })),
  ];
}

type Tx = Prisma.TransactionClient;

type ResolveSourceResult =
  | { ok: true; record: EvidenceSourceRecord }
  | { ok: false; error: string };

async function resolveOwnedSourceRecord(
  tx: Tx,
  ownerId: string,
  ref: { type: string; id: string }
): Promise<ResolveSourceResult> {
  switch (ref.type) {
    case "test_run": {
      const run = await tx.testRun.findFirst({
        where: { id: ref.id, project: { ownerId } },
        select: {
          id: true,
          status: true,
          source: true,
          commitSha: true,
          externalRunId: true,
          repoOwner: true,
          repoName: true,
        },
      });
      if (!run) return { ok: false, error: "Linked test-run record was not found in your account." };
      return {
        ok: true,
        record: {
          type: "test_run",
          id: run.id,
          label: `${run.repoOwner}/${run.repoName} ${run.commitSha.slice(0, 7)} ${run.status}`,
          testRun: {
            source: run.source,
            status: run.status,
            commitSha: run.commitSha,
            externalRunId: run.externalRunId,
          },
        },
      };
    }
    case "monitoring_check": {
      const check = await tx.monitoringCheck.findFirst({
        where: { id: ref.id, target: { project: { ownerId } } },
        select: { id: true, outcome: true, target: { select: { name: true } } },
      });
      if (!check) return { ok: false, error: "Linked monitoring check was not found in your account." };
      return {
        ok: true,
        record: {
          type: "monitoring_check",
          id: check.id,
          label: `${check.target.name} ${check.outcome}`,
          monitoringCheck: { outcome: check.outcome },
        },
      };
    }
    case "incident": {
      const incident = await tx.incident.findFirst({
        where: { id: ref.id, project: { ownerId } },
        select: { id: true, status: true, title: true },
      });
      if (!incident) return { ok: false, error: "Linked incident was not found in your account." };
      return {
        ok: true,
        record: {
          type: "incident",
          id: incident.id,
          label: incident.title,
          incident: { status: incident.status },
        },
      };
    }
    case "pull_request": {
      const pr = await tx.pullRequest.findFirst({
        where: { id: ref.id, project: { ownerId } },
        select: {
          id: true,
          number: true,
          repoOwner: true,
          repoName: true,
          currentHeadSha: true,
        },
      });
      if (!pr) return { ok: false, error: "Linked pull request was not found in your account." };
      return {
        ok: true,
        record: {
          type: "pull_request",
          id: pr.id,
          label: `${pr.repoOwner}/${pr.repoName} #${pr.number}`,
          pullRequest: { currentHeadSha: pr.currentHeadSha },
        },
      };
    }
    default:
      return { ok: false, error: "Unknown linked-record type." };
  }
}

export function parseSourceRecordRef(value: string | null | undefined): { type: string; id: string } | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  return { type: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}

const REQUIRED_SOURCE_TYPE: Record<string, EvidenceSourceRecord["type"]> = {
  test_run: "test_run",
  testsprite_execution: "test_run",
  monitoring_check: "monitoring_check",
  deployment_health: "monitoring_check",
  incident: "incident",
};

async function touchTracker(tx: Tx, trackerId: string): Promise<void> {
  await tx.deliveryTracker.update({ where: { id: trackerId }, data: { updatedAt: new Date() } });
}

async function writeAudit(
  tx: Tx,
  data: {
    taskId: string;
    actorId: string;
    previousStatus: string | null;
    newStatus: string | null;
    action: string;
    reason: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await tx.deliveryAuditEvent.create({
    data: {
      taskId: data.taskId,
      actorId: data.actorId,
      previousStatus: data.previousStatus,
      newStatus: data.newStatus,
      action: data.action,
      reason: data.reason ? redact(data.reason) : null,
      metadata: data.metadata ? redact(JSON.stringify(data.metadata)) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function updateDeliveryTaskStatus(input: {
  userId: string;
  taskId: string;
  status: string;
  reason?: string | null;
}): Promise<DeliveryMutationResult> {
  if (!isTaskStatus(input.status)) return { ok: false, error: "Unknown task status." };
  const next = input.status;
  const reason = (input.reason ?? "").trim().slice(0, 1000);

  return withAdvisoryLock(`delivery-task:${input.taskId}`, async (tx) => {
    const task = await tx.deliveryTask.findFirst({
      where: { id: input.taskId, phase: { tracker: { ownerId: input.userId } } },
      include: {
        phase: { select: { id: true, trackerId: true } },
        evidence: { select: { id: true, verificationStatus: true } },
      },
    });
    if (!task) return { ok: false, error: "Task not found." };
    if (!isTaskStatus(task.status)) return { ok: false, error: "Stored task status is invalid." };
    if (task.status === next) return { ok: false, error: `Task is already ${next.replace(/_/g, " ")}.` };
    if (!canTransitionTask(task.status, next)) {
      return {
        ok: false,
        error: `Transition ${task.status} → ${next} is not allowed. Allowed: ${allowedTaskTransitions(task.status).join(", ")}.`,
      };
    }
    if (next === "blocked" && reason.length < 3) {
      return { ok: false, error: "Blocked tasks require a short blocker reason." };
    }

    const hasVerifiedEvidence = task.evidence.some((evidence) => evidence.verificationStatus === "verified");
    const invalidatesVerification =
      task.verificationStatus === "verified" || hasVerifiedEvidence;

    if (invalidatesVerification) {
      await tx.taskEvidence.updateMany({
        where: { taskId: task.id, verificationStatus: "verified" },
        data: { verificationStatus: "pending_review", verificationBasis: null },
      });
      await writeAudit(tx, {
        taskId: task.id,
        actorId: input.userId,
        previousStatus: task.status,
        newStatus: next,
        action: "verification_invalidated",
        reason:
          "The substantive completion claim changed, so prior evidence verification was invalidated and requires re-review.",
        metadata: { previousVerificationStatus: task.verificationStatus },
      });
    }

    const statuses = task.evidence.map((evidence) =>
      invalidatesVerification && evidence.verificationStatus === "verified"
        ? "pending_review"
        : evidence.verificationStatus
    );
    const verificationStatus = deriveTaskVerificationStatus(next, statuses);
    const verifiedAt = verificationStatus === "verified" ? task.verifiedAt : null;
    const verifiedBy = verificationStatus === "verified" ? task.verifiedBy : null;

    await tx.deliveryTask.update({
      where: { id: task.id },
      data: {
        status: next,
        completedAt: next === "completed" ? new Date() : null,
        verificationStatus,
        verifiedAt,
        verifiedBy,
      },
    });
    await writeAudit(tx, {
      taskId: task.id,
      actorId: input.userId,
      previousStatus: task.status,
      newStatus: next,
      action: "status_changed",
      reason: reason || null,
      metadata: { verificationInvalidated: invalidatesVerification },
    });
    await touchTracker(tx, task.phase.trackerId);

    return {
      ok: true,
      message: invalidatesVerification
        ? `Status changed to ${next.replace(/_/g, " ")}. Prior evidence verification was invalidated and is awaiting review.`
        : `Status changed to ${next.replace(/_/g, " ")}.`,
    };
  });
}

export async function updateDeliveryTaskNotes(input: {
  userId: string;
  taskId: string;
  notes: string;
}): Promise<DeliveryMutationResult> {
  const notes = input.notes.trim().slice(0, 2000);
  return withAdvisoryLock(`delivery-task:${input.taskId}`, async (tx) => {
    const task = await tx.deliveryTask.findFirst({
      where: { id: input.taskId, phase: { tracker: { ownerId: input.userId } } },
      include: {
        phase: { select: { trackerId: true } },
        evidence: { select: { id: true, verificationStatus: true } },
      },
    });
    if (!task) return { ok: false, error: "Task not found." };
    if (task.completionNotes === (notes || null)) return { ok: true, message: "Notes were unchanged." };

    const hasVerifiedEvidence = task.evidence.some((evidence) => evidence.verificationStatus === "verified");
    const invalidatesVerification = task.verificationStatus === "verified" || hasVerifiedEvidence;

    if (invalidatesVerification) {
      await tx.taskEvidence.updateMany({
        where: { taskId: task.id, verificationStatus: "verified" },
        data: { verificationStatus: "pending_review", verificationBasis: null },
      });
      await tx.deliveryTask.update({
        where: { id: task.id },
        data: {
          completionNotes: notes || null,
          verificationStatus: deriveTaskVerificationStatus(
            task.status,
            task.evidence.map((evidence) =>
              evidence.verificationStatus === "verified" ? "pending_review" : evidence.verificationStatus
            )
          ),
          verifiedAt: null,
          verifiedBy: null,
        },
      });
      await writeAudit(tx, {
        taskId: task.id,
        actorId: input.userId,
        previousStatus: task.status,
        newStatus: task.status,
        action: "verification_invalidated",
        reason: "Completion notes changed after verification; evidence requires re-review.",
      });
    } else {
      await tx.deliveryTask.update({
        where: { id: task.id },
        data: { completionNotes: notes || null },
      });
    }

    await writeAudit(tx, {
      taskId: task.id,
      actorId: input.userId,
      previousStatus: task.status,
      newStatus: task.status,
      action: "notes_updated",
      reason: notes ? "Completion notes updated." : "Completion notes cleared.",
      metadata: { notesLength: notes.length, verificationInvalidated: invalidatesVerification },
    });
    await touchTracker(tx, task.phase.trackerId);

    return {
      ok: true,
      message: invalidatesVerification
        ? "Notes saved. Prior evidence verification was invalidated and is awaiting review."
        : "Notes saved.",
    };
  });
}

export async function addDeliveryEvidence(input: {
  userId: string;
  taskId: string;
  evidenceType: string;
  title: string;
  referenceUrl?: string | null;
  artifactReference?: string | null;
  sourceCommitSha?: string | null;
  notes?: string | null;
  sourceRecordRef?: string | null;
}): Promise<DeliveryMutationResult> {
  if (!isEvidenceType(input.evidenceType)) return { ok: false, error: "Unknown evidence type." };
  const evidenceType = input.evidenceType as EvidenceType;
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: "Evidence title is required." };

  const referenceUrl = input.referenceUrl?.trim() || null;
  if (referenceUrl) {
    const checked = validateMonitorUrl(referenceUrl);
    if (!checked.ok) return { ok: false, error: `Reference URL rejected: ${checked.error}` };
  }
  const artifactReference = input.artifactReference?.trim() || null;
  if (artifactReference && !isSafeArtifactReference(artifactReference)) {
    return {
      ok: false,
      error: "Artifact reference must be a repository-relative path (no absolute paths, traversal, or URLs).",
    };
  }
  const rawCommit = input.sourceCommitSha?.trim() || null;
  const sourceCommitSha = rawCommit ? normalizeCommitSha(rawCommit) : null;
  if (rawCommit && !sourceCommitSha) {
    return { ok: false, error: "Source commit SHA must be a full 40-character hexadecimal SHA." };
  }
  const notes = input.notes?.trim().slice(0, 2000) || null;
  const sourceRef = parseSourceRecordRef(input.sourceRecordRef);
  const requiredType = REQUIRED_SOURCE_TYPE[evidenceType];
  if (requiredType && !sourceRef) {
    return { ok: false, error: `This evidence type requires a linked ${requiredType.replace(/_/g, " ")} record.` };
  }
  if (sourceRef && !["test_run", "monitoring_check", "incident", "pull_request"].includes(sourceRef.type)) {
    return { ok: false, error: "Unknown linked-record type." };
  }
  if (requiredType && sourceRef && sourceRef.type !== requiredType) {
    return { ok: false, error: `This evidence type requires a linked ${requiredType.replace(/_/g, " ")} record.` };
  }

  return withAdvisoryLock(`delivery-task:${input.taskId}`, async (tx) => {
    const task = await tx.deliveryTask.findFirst({
      where: { id: input.taskId, phase: { tracker: { ownerId: input.userId } } },
      include: {
        phase: { select: { trackerId: true } },
        evidence: { select: { verificationStatus: true } },
      },
    });
    if (!task) return { ok: false, error: "Task not found." };

    let sourceRecord: EvidenceSourceRecord | null = null;
    let resolvedCommit = sourceCommitSha;
    if (sourceRef) {
      const resolved = await resolveOwnedSourceRecord(tx, input.userId, sourceRef);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      sourceRecord = resolved.record;
    }

    if (evidenceType === "test_run" || evidenceType === "testsprite_execution") {
      if (!sourceRecord?.testRun) return { ok: false, error: "A test-run record is required." };
      if (sourceRecord.testRun.source === "demo") {
        return { ok: false, error: "Simulated demonstration runs cannot be attached as verification evidence." };
      }
      if (evidenceType === "testsprite_execution" && sourceRecord.testRun.source !== "testsprite") {
        return { ok: false, error: "TestSprite execution evidence must link a TestSprite-source run." };
      }
      if (!resolvedCommit) resolvedCommit = sourceRecord.testRun.commitSha;
      if (resolvedCommit !== sourceRecord.testRun.commitSha) {
        return { ok: false, error: "The commit SHA does not match the linked test run's bound commit." };
      }
    }

    if (evidenceType === "deployment_health" && sourceRecord?.monitoringCheck?.outcome !== "success") {
      return { ok: false, error: "Deployment-health evidence requires a successful monitoring check." };
    }

    const evidence = await tx.taskEvidence.create({
      data: {
        taskId: task.id,
        evidenceType,
        title,
        referenceUrl,
        artifactReference,
        sourceCommitSha: resolvedCommit,
        sourceRecordType: sourceRecord?.type ?? null,
        sourceRecordId: sourceRecord?.id ?? null,
        notes,
        verificationStatus: "pending_review",
        submittedBy: input.userId,
      },
    });

    const statuses = [...task.evidence.map((item) => item.verificationStatus), "pending_review"];
    const verificationStatus = deriveTaskVerificationStatus(task.status, statuses);
    await tx.deliveryTask.update({
      where: { id: task.id },
      data: { verificationStatus },
    });
    await writeAudit(tx, {
      taskId: task.id,
      actorId: input.userId,
      previousStatus: null,
      newStatus: null,
      action: "evidence_added",
      reason: `Evidence attached: ${title}`,
      metadata: { evidenceId: evidence.id, evidenceType },
    });
    await touchTracker(tx, task.phase.trackerId);

    return {
      ok: true,
      message: "Evidence attached and marked pending review. Attaching evidence does not verify the task.",
    };
  });
}

export async function reviewDeliveryEvidence(input: {
  userId: string;
  evidenceId: string;
  decision: "verify" | "reject";
  note?: string | null;
}): Promise<DeliveryMutationResult> {
  const reviewNote = (input.note ?? "").trim().slice(0, 1000);
  if (input.decision !== "verify" && input.decision !== "reject") {
    return { ok: false, error: "Unknown review decision." };
  }

  return withAdvisoryLock(`delivery-evidence:${input.evidenceId}`, async (tx) => {
    const evidence = await tx.taskEvidence.findFirst({
      where: { id: input.evidenceId, task: { phase: { tracker: { ownerId: input.userId } } } },
      include: {
        task: {
          include: {
            phase: { select: { trackerId: true } },
            evidence: { select: { id: true, verificationStatus: true } },
          },
        },
      },
    });
    if (!evidence) return { ok: false, error: "Evidence not found." };

    if (input.decision === "reject") {
      if (reviewNote.length < 5) return { ok: false, error: "A rejection reason is required (at least 5 characters)." };
      await tx.taskEvidence.update({
        where: { id: evidence.id },
        data: {
          verificationStatus: "rejected",
          verificationBasis: null,
          verifiedAt: null,
          verifiedBy: null,
        },
      });
      const statuses = evidence.task.evidence.map((item) =>
        item.id === evidence.id ? "rejected" : item.verificationStatus
      );
      const verificationStatus = deriveTaskVerificationStatus(evidence.task.status, statuses);
      await tx.deliveryTask.update({
        where: { id: evidence.task.id },
        data: {
          verificationStatus,
          verifiedAt: verificationStatus === "verified" ? evidence.task.verifiedAt : null,
          verifiedBy: verificationStatus === "verified" ? evidence.task.verifiedBy : null,
        },
      });
      await writeAudit(tx, {
        taskId: evidence.task.id,
        actorId: input.userId,
        previousStatus: null,
        newStatus: null,
        action: "evidence_rejected",
        reason: reviewNote,
        metadata: { evidenceId: evidence.id },
      });
      await touchTracker(tx, evidence.task.phase.trackerId);
      return { ok: true, message: "Evidence rejected. The task is not verified by this record." };
    }

    if (evidence.task.status !== "completed") {
      return { ok: false, error: "Only a completed task can have its evidence verified." };
    }
    if (evidence.task.verificationStatus === "verified" && evidence.verificationStatus === "verified") {
      return { ok: true, message: "Evidence is already verified." };
    }

    let sourceRecord: EvidenceSourceRecord | null = null;
    if (evidence.sourceRecordType && evidence.sourceRecordId) {
      const ref = { type: evidence.sourceRecordType, id: evidence.sourceRecordId };
      if (!["test_run", "monitoring_check", "incident", "pull_request"].includes(ref.type)) {
        return { ok: false, error: "Linked evidence source type is invalid." };
      }
      const resolved = await resolveOwnedSourceRecord(tx, input.userId, ref);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      sourceRecord = resolved.record;
    }

    const policy = evaluateEvidencePolicy({
      evidenceType: evidence.evidenceType,
      referenceUrl: evidence.referenceUrl,
      artifactReference: evidence.artifactReference,
      sourceCommitSha: evidence.sourceCommitSha,
      notes: reviewNote || evidence.notes,
      sourceRecord,
    });
    if (!policy.ok) {
      await writeAudit(tx, {
        taskId: evidence.task.id,
        actorId: input.userId,
        previousStatus: null,
        newStatus: null,
        action: "evidence_verification_failed",
        reason: policy.reason,
        metadata: { evidenceId: evidence.id },
      });
      await touchTracker(tx, evidence.task.phase.trackerId);
      return { ok: false, error: `Verification refused: ${policy.reason}` };
    }

    await tx.taskEvidence.update({
      where: { id: evidence.id },
      data: {
        verificationStatus: "verified",
        verificationBasis: policy.basis,
        verifiedAt: new Date(),
        verifiedBy: input.userId,
      },
    });

    const statuses = evidence.task.evidence.map((item) =>
      item.id === evidence.id ? "verified" : item.verificationStatus
    );
    const verificationStatus = deriveTaskVerificationStatus(evidence.task.status, statuses);
    await tx.deliveryTask.update({
      where: { id: evidence.task.id },
      data: {
        verificationStatus,
        verifiedAt: verificationStatus === "verified" ? new Date() : null,
        verifiedBy: verificationStatus === "verified" ? input.userId : null,
      },
    });
    await writeAudit(tx, {
      taskId: evidence.task.id,
      actorId: input.userId,
      previousStatus: null,
      newStatus: null,
      action: "evidence_verified",
      reason: policy.summary,
      metadata: { evidenceId: evidence.id, basis: policy.basis },
    });
    await touchTracker(tx, evidence.task.phase.trackerId);

    return {
      ok: true,
      message: `Evidence verified (${policy.basis.replace(/_/g, " ")}). ${policy.summary}`,
    };
  });
}

export type DeliveryTaskDetail = {
  snapshot: DeliverySnapshot;
  phase: DeliveryPhaseView;
  task: DeliveryTaskView;
};

export async function getDeliveryTaskDetail(
  ownerId: string,
  taskStableKey: string
): Promise<DeliveryTaskDetail | null> {
  const snapshot = await getDeliverySnapshot(ownerId);
  for (const phase of snapshot.tracker.phases) {
    const task = phase.tasks.find((candidate) => candidate.stableKey === taskStableKey);
    if (task) return { snapshot, phase, task };
  }
  return null;
}

export async function getDeliveryPhaseDetail(
  ownerId: string,
  phaseStableKey: string
): Promise<{ snapshot: DeliverySnapshot; phase: DeliveryPhaseView } | null> {
  const snapshot = await getDeliverySnapshot(ownerId);
  const phase = snapshot.tracker.phases.find((candidate) => candidate.stableKey === phaseStableKey);
  return phase ? { snapshot, phase } : null;
}

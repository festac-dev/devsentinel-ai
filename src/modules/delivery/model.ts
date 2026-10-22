/**
 * Pure delivery-tracker domain logic. Kept free of Prisma and Next.js so the
 * progress rules, verification policy, readiness criteria, and report text can
 * be unit tested without a database.
 */

import { validateMonitorUrl } from "@/modules/monitoring/ssrf";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const VERIFICATION_STATUSES = ["unverified", "pending_review", "verified", "rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const EVIDENCE_VERIFICATION_STATUSES = ["pending_review", "verified", "rejected"] as const;
export type EvidenceVerificationStatus = (typeof EVIDENCE_VERIFICATION_STATUSES)[number];

export const EVIDENCE_TYPES = [
  "test_run",
  "github_pr",
  "github_check",
  "testsprite_execution",
  "monitoring_check",
  "incident",
  "ci_run",
  "build_report",
  "deployment_health",
  "security_review",
  "documentation",
  "demo",
  "review_note",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  test_run: "Test run record",
  github_pr: "GitHub pull request",
  github_check: "GitHub commit check",
  testsprite_execution: "TestSprite execution",
  monitoring_check: "Monitoring check",
  incident: "Incident record",
  ci_run: "CI run result",
  build_report: "Build / typecheck / lint report",
  deployment_health: "Deployment health check",
  security_review: "Security review note",
  documentation: "Documentation or repository path",
  demo: "Demonstration URL",
  review_note: "Review note",
};

export const EVIDENCE_TYPE_HINTS: Record<EvidenceType, string> = {
  test_run: "Links an existing TestRun in this account. Verification requires a final, non-demo run with a commit binding.",
  github_pr: "A genuine GitHub pull-request reference, or an existing pull-request record already imported by DevSentinel.",
  github_check: "A GitHub check/commit reference plus the tested 40-character commit SHA and the observed conclusion in the review note.",
  testsprite_execution: "Links an existing TestRun whose source is testsprite and which carries a provider execution id.",
  monitoring_check: "Links an existing monitoring check. Simulated results are not accepted.",
  incident: "Links an existing incident record owned by this account.",
  ci_run: "A CI run URL or artifact, the tested commit SHA, and the observed result in the review note.",
  build_report: "A build, typecheck, lint, or test report URL or repository-relative artifact, plus the tested commit and observed result.",
  deployment_health: "Links a successful monitoring check for the deployment. A hardcoded success message is not accepted.",
  security_review: "Record scope, method, date, result, and reviewer. This is not represented as an independent audit.",
  documentation: "A safe repository-relative path or HTTPS URL. Availability is not re-fetched by the tracker.",
  demo: "A demonstration URL. The tracker records it but does not re-fetch availability.",
  review_note: "A dated review note. Verification is an explicit owner review, not a third-party audit.",
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === "string" && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["in_progress", "blocked", "completed"],
  in_progress: ["completed", "blocked", "pending"],
  blocked: ["in_progress", "pending"],
  completed: ["in_progress", "pending"],
};

/** Explicit state machine; same-state writes are never valid transitions. */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return from !== to && TASK_TRANSITIONS[from].includes(to);
}

export function allowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

// ---------------------------------------------------------------------------
// Snapshot shapes used by pages, services, and the report builder.
// ---------------------------------------------------------------------------

export type DeliveryUserRef = { name: string } | null;

export type DeliveryEvidenceView = {
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
  submitter: DeliveryUserRef;
  verifier: DeliveryUserRef;
};

export type DeliveryAuditView = {
  id: string;
  actorId: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  action: string;
  reason: string | null;
  metadata: string | null;
  createdAt: Date;
  actor: DeliveryUserRef;
};

export type DeliveryTaskView = {
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
  evidence: DeliveryEvidenceView[];
  auditEvents: DeliveryAuditView[];
  verifier: DeliveryUserRef;
};

export type DeliveryPhaseView = {
  id: string;
  stableKey: string;
  title: string;
  description: string | null;
  phaseOrder: number;
  createdAt: Date;
  updatedAt: Date;
  tasks: DeliveryTaskView[];
};

export type DeliveryTrackerView = {
  id: string;
  title: string;
  description: string | null;
  liveUrl: string | null;
  repositoryUrl: string | null;
  seedVersion: number;
  createdAt: Date;
  updatedAt: Date;
  phases: DeliveryPhaseView[];
};

export type DeliverySnapshot = {
  tracker: DeliveryTrackerView;
  lastUpdated: Date;
};

// ---------------------------------------------------------------------------
// Progress and readiness
// ---------------------------------------------------------------------------

export type TaskStats = {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  pending: number;
  verified: number;
  pendingReview: number;
  completedUnverified: number;
  completionPercent: number;
  verificationPercent: number;
};

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

type TaskLike = { status: string; verificationStatus: string; evidence?: unknown[] };

export function statsForTasks(tasks: readonly TaskLike[]): TaskStats {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const pending = tasks.filter((task) => task.status === "pending").length;
  const verified = tasks.filter((task) => task.verificationStatus === "verified").length;
  const pendingReview = tasks.filter((task) => task.verificationStatus === "pending_review").length;
  const completedUnverified = tasks.filter(
    (task) => task.status === "completed" && task.verificationStatus !== "verified"
  ).length;
  return {
    total,
    completed,
    inProgress,
    blocked,
    pending,
    verified,
    pendingReview,
    completedUnverified,
    completionPercent: percent(completed, total),
    verificationPercent: percent(verified, total),
  };
}

export type PhaseStats = TaskStats & {
  fullyCompleted: boolean;
  fullyVerified: boolean;
};

export function phaseStats(tasks: readonly TaskLike[]): PhaseStats {
  const stats = statsForTasks(tasks);
  return {
    ...stats,
    fullyCompleted: stats.total > 0 && stats.completed === stats.total,
    fullyVerified: stats.total > 0 && stats.verified === stats.total,
  };
}

export function overallStats(snapshot: DeliverySnapshot): TaskStats {
  return statsForTasks(snapshot.tracker.phases.flatMap((phase) => phase.tasks));
}

export type ReadinessCriterion = {
  key: string;
  label: string;
  met: boolean;
  detail: string;
};

export type Readiness = {
  ready: boolean;
  metCount: number;
  criteria: ReadinessCriterion[];
  summary: string;
};

/**
 * Submission readiness is deliberately more than "100% complete". It requires
 * evidence for every task and an explicit review that accepted that evidence.
 */
export function evaluateSubmissionReadiness(snapshot: DeliverySnapshot): Readiness {
  const tasks = snapshot.tracker.phases.flatMap((phase) => phase.tasks);
  const stats = statsForTasks(tasks);
  const tasksWithEvidence = tasks.filter((task) => (task.evidence?.length ?? 0) > 0).length;
  const pendingEvidence = tasks.reduce(
    (count, task) =>
      count + (task.evidence ?? []).filter((e) => (e as { verificationStatus?: string }).verificationStatus === "pending_review").length,
    0
  );

  const criteria: ReadinessCriterion[] = [
    {
      key: "all_tasks_completed",
      label: "All tasks are reported complete",
      met: stats.total > 0 && stats.completed === stats.total,
      detail: `${stats.completed} of ${stats.total} tasks reported complete.`,
    },
    {
      key: "no_blocked_tasks",
      label: "No task is blocked",
      met: stats.blocked === 0,
      detail: `${stats.blocked} blocked task${stats.blocked === 1 ? "" : "s"}.`,
    },
    {
      key: "evidence_present",
      label: "Every task has at least one evidence record",
      met: stats.total > 0 && tasksWithEvidence === stats.total,
      detail: `${tasksWithEvidence} of ${stats.total} tasks have evidence.`,
    },
    {
      key: "evidence_verified",
      label: "Every task has evidence-verified completion",
      met: stats.total > 0 && stats.verified === stats.total,
      detail: `${stats.verified} of ${stats.total} tasks verified.`,
    },
    {
      key: "no_pending_evidence_review",
      label: "No evidence is awaiting review",
      met: pendingEvidence === 0,
      detail: `${pendingEvidence} evidence record${pendingEvidence === 1 ? "" : "s"} awaiting review.`,
    },
  ];

  const metCount = criteria.filter((criterion) => criterion.met).length;
  const ready = metCount === criteria.length;
  return {
    ready,
    metCount,
    criteria,
    summary: ready
      ? "Submission-ready: every explicit readiness criterion is met."
      : `Not submission-ready: ${metCount} of ${criteria.length} readiness criteria met. Reported completion alone does not establish readiness.`,
  };
}

export function latestTrackerTimestamp(snapshot: DeliverySnapshot): Date {
  const dates: Date[] = [snapshot.tracker.updatedAt];
  for (const phase of snapshot.tracker.phases) {
    dates.push(phase.updatedAt);
    for (const task of phase.tasks) {
      dates.push(task.updatedAt);
      if (task.completedAt) dates.push(task.completedAt);
      if (task.verifiedAt) dates.push(task.verifiedAt);
      for (const evidence of task.evidence) dates.push(evidence.updatedAt);
      for (const event of task.auditEvents) dates.push(event.createdAt);
    }
  }
  return dates.reduce((latest, date) => (date.getTime() > latest.getTime() ? date : latest), dates[0]!);
}

// ---------------------------------------------------------------------------
// Verification policy
// ---------------------------------------------------------------------------

export type EvidenceSourceRecord = {
  type: "test_run" | "pull_request" | "incident" | "monitoring_check";
  id: string;
  label: string;
  testRun?: {
    source: string;
    status: string;
    commitSha: string;
    externalRunId: string | null;
  };
  pullRequest?: {
    currentHeadSha: string;
  };
  incident?: {
    status: string;
  };
  monitoringCheck?: {
    outcome: string;
  };
};

export type EvidencePolicyInput = {
  evidenceType: string;
  referenceUrl: string | null;
  artifactReference: string | null;
  sourceCommitSha: string | null;
  notes: string | null;
  sourceRecord: EvidenceSourceRecord | null;
};

export type EvidencePolicyResult =
  | { ok: true; basis: "internal_record" | "reference_review" | "manual_review"; summary: string }
  | { ok: false; reason: string };

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function normalizeCommitSha(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return FULL_SHA.test(trimmed) ? trimmed : null;
}

/** Repository-relative paths only: no absolute paths, no traversal, no URLs. */
export function isSafeArtifactReference(value: string): boolean {
  if (value.length === 0 || value.length > 300) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("://")) return false;
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value);
}

function parsedUrl(raw: string | null): { url: URL } | { error: string } | null {
  if (!raw) return null;
  const checked = validateMonitorUrl(raw);
  return checked.ok ? { url: checked.url } : { error: checked.error };
}

function isGitHubHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "www.github.com");
}

function isGitHubPrUrl(url: URL): boolean {
  return isGitHubHost(url) && /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname);
}

function isTestSpriteHost(url: URL): boolean {
  return url.protocol === "https:" && (url.hostname === "testsprite.com" || url.hostname.endsWith(".testsprite.com"));
}

function fail(reason: string): EvidencePolicyResult {
  return { ok: false, reason };
}

/**
 * Decide whether the owner may accept this evidence for this evidence type.
 * External references are owner-reviewed, not re-queried by the tracker; the
 * resulting basis is recorded so the report can say exactly what was checked.
 */
export function evaluateEvidencePolicy(input: EvidencePolicyInput): EvidencePolicyResult {
  const notes = (input.notes ?? "").trim();
  const sourceRecord = input.sourceRecord;

  let commit: string | null = null;
  if (input.sourceCommitSha) {
    commit = normalizeCommitSha(input.sourceCommitSha);
    if (!commit) return fail("Source commit SHA must be a full 40-character hexadecimal SHA.");
  }

  const parsed = parsedUrl(input.referenceUrl);
  if (parsed && "error" in parsed) return fail(`Reference URL rejected: ${parsed.error}`);
  const url = parsed && "url" in parsed ? parsed.url : null;

  if (input.artifactReference && !isSafeArtifactReference(input.artifactReference)) {
    return fail("Artifact reference must be a repository-relative path (no absolute paths, traversal, or URLs).");
  }

  switch (input.evidenceType) {
    case "test_run": {
      if (!sourceRecord || sourceRecord.type !== "test_run" || !sourceRecord.testRun) {
        return fail("Link an existing test-run record owned by this account.");
      }
      const run = sourceRecord.testRun;
      if (run.source === "demo") return fail("A simulated demonstration run cannot verify a task.");
      if (run.status !== "passed" && run.status !== "failed") {
        return fail("The linked test run has not produced a final passed/failed result.");
      }
      if (commit && commit !== run.commitSha) {
        return fail("The evidence commit does not match the commit bound to the linked test run.");
      }
      return {
        ok: true,
        basis: "internal_record",
        summary: `Linked test run ${sourceRecord.id} (${run.status}) bound to commit ${run.commitSha.slice(0, 12)}.`,
      };
    }

    case "testsprite_execution": {
      if (!sourceRecord || sourceRecord.type !== "test_run" || !sourceRecord.testRun) {
        return fail("Link an existing TestSprite test-run record owned by this account.");
      }
      const run = sourceRecord.testRun;
      if (run.source !== "testsprite") {
        return fail("Only a run executed through the TestSprite provider can verify this evidence type.");
      }
      if (!run.externalRunId) {
        return fail("The linked TestSprite run has no provider execution id.");
      }
      if (run.status !== "passed" && run.status !== "failed") {
        return fail("The linked TestSprite run has not produced a final passed/failed result.");
      }
      if (commit && commit !== run.commitSha) {
        return fail("The evidence commit does not match the commit bound to the linked TestSprite run.");
      }
      if (url && !isTestSpriteHost(url)) {
        return fail("A TestSprite reference URL must use an https testsprite.com host.");
      }
      return {
        ok: true,
        basis: "internal_record",
        summary: `Linked TestSprite run ${sourceRecord.id} (provider execution ${run.externalRunId}) bound to commit ${run.commitSha.slice(0, 12)}.`,
      };
    }

    case "deployment_health": {
      if (!sourceRecord || sourceRecord.type !== "monitoring_check" || !sourceRecord.monitoringCheck) {
        return fail("Link an actual monitoring check for this deployment.");
      }
      if (sourceRecord.monitoringCheck.outcome !== "success") {
        return fail("The linked monitoring check did not succeed.");
      }
      return {
        ok: true,
        basis: "internal_record",
        summary: `Linked monitoring check ${sourceRecord.id} recorded a successful outcome.`,
      };
    }

    case "monitoring_check": {
      if (!sourceRecord || sourceRecord.type !== "monitoring_check" || !sourceRecord.monitoringCheck) {
        return fail("Link an existing monitoring check owned by this account.");
      }
      return {
        ok: true,
        basis: "internal_record",
        summary: `Linked monitoring check ${sourceRecord.id} (${sourceRecord.monitoringCheck.outcome}).`,
      };
    }

    case "incident": {
      if (!sourceRecord || sourceRecord.type !== "incident" || !sourceRecord.incident) {
        return fail("Link an existing incident record owned by this account.");
      }
      return {
        ok: true,
        basis: "internal_record",
        summary: `Linked incident ${sourceRecord.id} (${sourceRecord.incident.status}).`,
      };
    }

    case "github_pr": {
      if (sourceRecord?.type === "pull_request" && sourceRecord.pullRequest) {
        return {
          ok: true,
          basis: "internal_record",
          summary: `Linked pull-request record ${sourceRecord.id} at head ${sourceRecord.pullRequest.currentHeadSha.slice(0, 12)}.`,
        };
      }
      if (!url || !isGitHubPrUrl(url)) {
        return fail("Provide a genuine GitHub pull-request URL (https://github.com/owner/repo/pull/N) or link an existing pull-request record.");
      }
      return {
        ok: true,
        basis: "reference_review",
        summary: `Owner-reviewed GitHub pull-request reference ${url.toString()}. The tracker did not re-query GitHub.`,
      };
    }

    case "github_check": {
      if (!url || !isGitHubHost(url)) {
        return fail("Provide a GitHub check or commit reference URL on https://github.com.");
      }
      if (!commit) return fail("GitHub check evidence requires the tested full 40-character commit SHA.");
      if (notes.length < 10) {
        return fail("Record the observed check conclusion in the review note (at least 10 characters).");
      }
      return {
        ok: true,
        basis: "reference_review",
        summary: `Owner-reviewed GitHub reference for commit ${commit.slice(0, 12)}; observed conclusion recorded by the reviewer. The tracker did not re-query GitHub.`,
      };
    }

    case "ci_run":
    case "build_report": {
      if (!url && !input.artifactReference) {
        return fail("Provide a CI run URL or a repository-relative artifact reference.");
      }
      if (!commit) return fail("CI and build evidence require the tested full 40-character commit SHA.");
      if (notes.length < 10) return fail("Record the observed result in the review note (at least 10 characters).");
      return {
        ok: true,
        basis: "reference_review",
        summary: `Owner-reviewed CI/build evidence for commit ${commit.slice(0, 12)}; observed result recorded by the reviewer.`,
      };
    }

    case "security_review": {
      if (notes.length < 40) {
        return fail("Record the review scope, method, date, result, and reviewer (at least 40 characters).");
      }
      if (!url && !input.artifactReference) {
        return fail("Provide a review URL or a repository-relative review artifact.");
      }
      return {
        ok: true,
        basis: "manual_review",
        summary: "Owner-recorded security review. This is not an independent third-party audit.",
      };
    }

    case "documentation": {
      if (!url && !input.artifactReference) {
        return fail("Provide a safe documentation URL or a repository-relative path.");
      }
      return {
        ok: true,
        basis: "reference_review",
        summary: "Documentation reference recorded; availability was not re-fetched.",
      };
    }

    case "demo": {
      if (!url) return fail("Demonstration evidence requires an HTTPS URL.");
      return {
        ok: true,
        basis: "reference_review",
        summary: `Demonstration reference recorded (${url.toString()}); availability was not re-fetched.`,
      };
    }

    case "review_note": {
      if (notes.length < 20) return fail("A review note must contain at least 20 characters.");
      return {
        ok: true,
        basis: "manual_review",
        summary: "Dated owner review note. This is an explicit manual review, not an independent audit.",
      };
    }

    default:
      return fail(`Unsupported evidence type: ${input.evidenceType}.`);
  }
}

export function deriveVerificationStatus(evidenceStatuses: readonly string[]): VerificationStatus {
  if (evidenceStatuses.includes("verified")) return "verified";
  if (evidenceStatuses.includes("pending_review")) return "pending_review";
  if (evidenceStatuses.includes("rejected")) return "rejected";
  return "unverified";
}

export function deriveTaskVerificationStatus(
  taskStatus: string,
  evidenceStatuses: readonly string[]
): VerificationStatus {
  if (taskStatus !== "completed") return "unverified";
  return deriveVerificationStatus(evidenceStatuses);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export type ReportOptions = {
  generatedAt: Date;
  sourceRevision: string | null;
};

export function sourceRevisionFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.VERCEL_GIT_COMMIT_SHA ?? env.GIT_COMMIT_SHA ?? env.SOURCE_COMMIT_SHA ?? "").trim();
  return /^[0-9a-f]{7,64}$/i.test(raw) ? raw : null;
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&").trim();
}

function safeUrl(raw: string | null): string | null {
  if (!raw) return null;
  const checked = validateMonitorUrl(raw);
  return checked.ok ? `<${checked.url.toString()}>` : null;
}

function evidenceLine(evidence: DeliveryEvidenceView): string {
  const label = EVIDENCE_TYPE_LABELS[evidence.evidenceType as EvidenceType] ?? evidence.evidenceType;
  const url = safeUrl(evidence.referenceUrl);
  const target = url ?? (evidence.artifactReference ? `\`${inline(evidence.artifactReference)}\`` : "no reference supplied");
  const basis = evidence.verificationBasis ? `, basis: ${inline(evidence.verificationBasis)}` : "";
  const commit = evidence.sourceCommitSha ? `, commit ${evidence.sourceCommitSha.slice(0, 12)}` : "";
  return `  - ${inline(label)}: **${inline(evidence.title)}** — ${evidence.verificationStatus}${basis}${commit} — ${target}`;
}

function statusLine(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * Build a Markdown report from the database snapshot. The text is deliberately
 * conservative: unsupported claims are labelled, and no statement of test or
 * integration success is generated without a matching evidence record.
 */
export function buildDeliveryReport(snapshot: DeliverySnapshot, options: ReportOptions): string {
  const { tracker } = snapshot;
  const tasks = tracker.phases.flatMap((phase) => phase.tasks);
  const stats = statsForTasks(tasks);
  const readiness = evaluateSubmissionReadiness(snapshot);
  const blocked = tasks.filter((task) => task.status === "blocked");
  const unverifiedCompleted = tasks.filter(
    (task) => task.status === "completed" && task.verificationStatus !== "verified"
  );
  const pendingEvidence = tasks.flatMap((task) =>
    task.evidence.filter((evidence) => evidence.verificationStatus === "pending_review")
  );
  const allEvidence = tasks.flatMap((task) =>
    task.evidence.map((evidence) => ({ task, evidence }))
  );
  const testEvidence = allEvidence.filter(({ evidence }) =>
    ["test_run", "testsprite_execution", "ci_run", "build_report"].includes(evidence.evidenceType)
  );
  const integrationEvidence = allEvidence.filter(({ evidence }) =>
    ["github_pr", "github_check", "testsprite_execution", "deployment_health"].includes(evidence.evidenceType)
  );

  const lines: string[] = [];
  const revision = options.sourceRevision ?? "not recorded";
  const generated = options.generatedAt.toISOString();

  lines.push("# DevSentinel AI — Delivery and Verification Report");
  lines.push("");
  lines.push(`Generated at: **${generated}**  `);
  lines.push(`Source revision: **${revision}**  `);
  lines.push(`Tracker seed version: ${tracker.seedVersion}  `);
  lines.push("Data source: the DevSentinel AI PostgreSQL delivery tracker at generation time.");
  lines.push("");

  lines.push("## 1. Executive summary");
  lines.push("");
  lines.push(
    `The tracker contains **${stats.total} tasks** across **${tracker.phases.length} phases**. ` +
      `**${stats.completed}** are reported complete (${stats.completionPercent}%), and ` +
      `**${stats.verified}** ${stats.verified === 1 ? "task is" : "tasks are"} evidence-verified (${stats.verificationPercent}%).`
  );
  lines.push("");
  lines.push(
    `Status counts: ${stats.completed} completed, ${stats.inProgress} in progress, ${stats.blocked} blocked, ${stats.pending} pending. ` +
      `Evidence verification: ${stats.verified} verified, ${stats.pendingReview} pending review, ` +
      `${stats.completedUnverified} reported complete without verification.`
  );
  lines.push("");
  lines.push(`**Submission readiness:** ${readiness.summary}`);
  lines.push("");
  lines.push(
    "This report reflects stored records only. Reported completion is not independent proof, and an evidence-verified task is verified by an explicit authorized review recorded in this application — not by a third-party audit."
  );
  lines.push("");

  lines.push("## 2. Project overview");
  lines.push("");
  lines.push(`- Project: **${inline(tracker.title)}**`);
  if (tracker.description) lines.push(`- Description: ${inline(tracker.description)}`);
  lines.push(`- Live application: ${tracker.liveUrl ? (safeUrl(tracker.liveUrl) ?? "invalid URL omitted") : "not recorded"}`);
  lines.push(`- Repository: ${tracker.repositoryUrl ? (safeUrl(tracker.repositoryUrl) ?? "invalid URL omitted") : "not recorded"}`);
  lines.push(`- Tracker created: ${tracker.createdAt.toISOString()}`);
  lines.push(`- Data last updated: ${latestTrackerTimestamp(snapshot).toISOString()}`);
  lines.push(`- Live application and external references were not re-fetched while generating this report.`);
  lines.push("");

  const phaseHeadingNumbers = ["3", "4", "5", "6"];
  tracker.phases.forEach((phase, index) => {
    const phaseStat = phaseStats(phase.tasks);
    lines.push(`## ${phaseHeadingNumbers[index] ?? String(index + 3)}. Phase ${phase.phaseOrder} — ${inline(phase.title)}`);
    lines.push("");
    if (phase.description) {
      lines.push(`> ${inline(phase.description)}`);
      lines.push("");
    }
    lines.push(
      `Reported completion: **${phaseStat.completed} of ${phaseStat.total}** (${phaseStat.completionPercent}%). ` +
        `Evidence verification: **${phaseStat.verified} of ${phaseStat.total}** (${phaseStat.verificationPercent}%).`
    );
    lines.push("");
    phase.tasks.forEach((task) => {
      lines.push(`### ${phase.phaseOrder}.${task.taskOrder} ${inline(task.title)}`);
      lines.push("");
      lines.push(`> ${inline(task.description)}`);
      lines.push("");
      lines.push(`- Reported status: **${statusLine(task.status)}**`);
      lines.push(`- Evidence verification: **${statusLine(task.verificationStatus)}**`);
      lines.push(`- Completed at: ${task.completedAt ? task.completedAt.toISOString() : "not recorded"}`);
      lines.push(`- Verified at: ${task.verifiedAt ? task.verifiedAt.toISOString() : "not recorded"}`);
      if (task.completionNotes) lines.push(`- Completion notes: ${inline(task.completionNotes)}`);
      if (task.evidence.length === 0) {
        lines.push("- Evidence: none recorded");
      } else {
        lines.push(`- Evidence (${task.evidence.length}):`);
        for (const evidence of task.evidence) lines.push(evidenceLine(evidence));
      }
      lines.push(`- Audit events: ${task.auditEvents.length}`);
      lines.push("");
    });
  });

  lines.push("## 7. Security and architecture");
  lines.push("");
  lines.push(
    "DevSentinel AI uses first-party session authentication with hashed tokens, CSRF origin checks on cookie-authenticated mutations, database-backed rate limiting, SSRF validation for monitoring targets, AES-256-GCM encryption for integration credentials, and a PostgreSQL-backed worker queue. Results are bound to the commit SHA tested at run creation, and this delivery tracker is isolated to its owning account."
  );
  lines.push("");
  lines.push(
    "This paragraph is architecture context, not a statement that a security review occurred. Security-review evidence recorded in this tracker is an owner review unless the evidence itself names an independent reviewer."
  );
  lines.push("");
  const securityEvidence = allEvidence.filter(({ evidence }) => evidence.evidenceType === "security_review");
  if (securityEvidence.length === 0) {
    lines.push("Security-review evidence: none recorded in this tracker.");
  } else {
    lines.push("Security-review evidence recorded:");
    for (const { task, evidence } of securityEvidence) {
      lines.push(`- ${inline(task.title)} — ${evidenceLine(evidence).trim()}`);
    }
  }
  lines.push("");

  lines.push("## 8. Testing and validation");
  lines.push("");
  if (testEvidence.length === 0) {
    lines.push(
      "No test-execution evidence is recorded in this tracker. The initial checklist status does not establish that typecheck, lint, unit tests, database integration tests, or a production build were run."
    );
  } else {
    lines.push(
      "The following test-execution evidence is stored. Acceptance means an authorized review recorded the evidence; the tracker does not re-run commands or re-query CI."
    );
    lines.push("");
    for (const { task, evidence } of testEvidence) {
      lines.push(`- ${inline(task.title)} — ${evidenceLine(evidence).trim()}`);
    }
  }
  lines.push("");
  if (integrationEvidence.length === 0) {
    lines.push("No GitHub, TestSprite, or deployment-health integration evidence is recorded. No integration success is claimed.");
  } else {
    lines.push("Integration evidence recorded (owner-reviewed where marked reference_review):");
    lines.push("");
    for (const { task, evidence } of integrationEvidence) {
      lines.push(`- ${inline(task.title)} — ${evidenceLine(evidence).trim()}`);
    }
  }
  lines.push("");

  lines.push("## 9. Evidence and references");
  lines.push("");
  if (allEvidence.length === 0) {
    lines.push("No evidence records have been attached to any task.");
  } else {
    for (const { task, evidence } of allEvidence) {
      lines.push(
        `- **${inline(task.title)}** — ${evidence.verificationStatus} ` +
          `(${EVIDENCE_TYPE_LABELS[evidence.evidenceType as EvidenceType] ?? evidence.evidenceType})`
      );
      if (evidence.sourceRecordType && evidence.sourceRecordId) {
        lines.push(`  - Source record: ${inline(evidence.sourceRecordType)} ${inline(evidence.sourceRecordId)}`);
      }
      lines.push(`  - Reference: ${evidence.referenceUrl ? (safeUrl(evidence.referenceUrl) ?? "invalid URL omitted") : evidence.artifactReference ? `\`${inline(evidence.artifactReference)}\`` : "none"}`);
      if (evidence.sourceCommitSha) lines.push(`  - Commit: ${evidence.sourceCommitSha}`);
      if (evidence.notes) lines.push(`  - Note: ${inline(evidence.notes)}`);
      lines.push(`  - Submitted: ${evidence.createdAt.toISOString()}${evidence.submitter ? ` by ${inline(evidence.submitter.name)}` : ""}`);
      if (evidence.verifiedAt) {
        lines.push(`  - Verified: ${evidence.verifiedAt.toISOString()}${evidence.verifier ? ` by ${inline(evidence.verifier.name)}` : ""}`);
      }
    }
  }
  lines.push("");

  lines.push("## 10. Outstanding issues and limitations");
  lines.push("");
  if (blocked.length === 0) lines.push("- No blocked tasks are reported.");
  else {
    lines.push("- Blocked tasks:");
    for (const task of blocked) lines.push(`  - ${inline(task.title)}${task.completionNotes ? ` — ${inline(task.completionNotes)}` : ""}`);
  }
  if (unverifiedCompleted.length === 0) {
    lines.push("- No completed task is missing evidence verification.");
  } else {
    lines.push(`- ${unverifiedCompleted.length} completed ${unverifiedCompleted.length === 1 ? "task is" : "tasks are"} not evidence-verified:`);
    for (const task of unverifiedCompleted) lines.push(`  - ${inline(task.title)} (${statusLine(task.verificationStatus)})`);
  }
  if (pendingEvidence.length > 0) lines.push(`- ${pendingEvidence.length} evidence record(s) await an authorized review decision.`);
  const missingTimestamps = tasks.filter((task) => task.status === "completed" && !task.completedAt).length;
  if (missingTimestamps > 0) {
    lines.push(`- ${missingTimestamps} completed ${missingTimestamps === 1 ? "task has" : "tasks have"} no recorded completion timestamp. The supplied checklist did not include timestamps, so none were invented.`);
  }
  lines.push("");
  lines.push("Known limitations:");
  lines.push("");
  lines.push("- Initial task statuses were supplied as reported completion and are preserved without being upgraded to verified.");
  lines.push("- Evidence verification is an explicit owner review in this single-owner application; it is not an independent third-party audit.");
  lines.push("- External URLs, GitHub checks, CI systems, and TestSprite records are stored as references and are not re-queried during report generation.");
  lines.push("- The report is generated as Markdown. A PDF can be produced from the report page using the browser's print-to-PDF feature; no server-side PDF pipeline is included.");
  lines.push(`- Readiness criteria met: ${readiness.metCount} of ${readiness.criteria.length}.`);
  for (const criterion of readiness.criteria) {
    lines.push(`  - [${criterion.met ? "x" : " "}] ${criterion.label} — ${criterion.detail}`);
  }
  lines.push("");

  lines.push("## 11. Conclusion");
  lines.push("");
  if (readiness.ready) {
    lines.push(
      "All explicit readiness criteria are met according to the stored records. This conclusion is limited to the evidence and reviews recorded in this tracker at the generation timestamp."
    );
  } else {
    lines.push(
      `The project is not submission-ready under the tracker's explicit criteria. ${stats.completed} of ${stats.total} tasks are reported complete, but only ${stats.verified} ${stats.verified === 1 ? "task is" : "tasks are"} evidence-verified. Complete the outstanding evidence and review items above before claiming verification.`
    );
  }
  lines.push("");
  lines.push(`Report generated at ${generated}. Source revision: ${revision}.`);
  lines.push("");

  return lines.join("\n");
}

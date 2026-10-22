import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getDeliveryTaskDetail,
  getEvidenceLinkOptions,
} from "@/modules/delivery/service";
import {
  EVIDENCE_TYPE_HINTS,
  EVIDENCE_TYPE_LABELS,
  EVIDENCE_TYPES,
  allowedTaskTransitions,
  isTaskStatus,
  type EvidenceType,
  type TaskStatus,
} from "@/modules/delivery/model";
import { Badge, Card, EmptyState, SectionTitle, Time } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import {
  reviewDeliveryEvidenceAction,
  updateDeliveryTaskNotesAction,
  updateDeliveryTaskStatusAction,
} from "@/app/actions/delivery";
import { EvidenceForm, type EvidenceTypeOption } from "@/components/delivery/evidence-form";
import { TaskStatusBadge, VerificationBadge, humanizeAction, humanizeEvidenceType } from "@/components/delivery/status";
import { SafeExternalLink } from "@/components/delivery/safe-link";

export const dynamic = "force-dynamic";

const inputCls =
  "w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

const SOURCE_TYPE: Record<string, EvidenceTypeOption["sourceType"]> = {
  test_run: "test_run",
  testsprite_execution: "test_run",
  monitoring_check: "monitoring_check",
  deployment_health: "monitoring_check",
  incident: "incident",
  github_pr: "pull_request",
  github_check: "pull_request",
};

const SOURCE_REQUIRED = new Set(["test_run", "testsprite_execution", "monitoring_check", "deployment_health", "incident"]);

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Reported complete",
  blocked: "Blocked",
};

const INTERNAL_EVIDENCE_ROUTE: Record<string, string> = {
  test_run: "/app/runs",
  pull_request: "/app/pull-requests",
  incident: "/app/incidents",
  monitoring_check: "/app/monitoring",
};

function evidenceRoute(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  const base = INTERNAL_EVIDENCE_ROUTE[type];
  if (!base) return null;
  if (type === "monitoring_check") return base;
  return `${base}/${id}`;
}

export default async function DeliveryTaskPage({ params }: { params: Promise<{ taskKey: string }> }) {
  const { taskKey } = await params;
  const user = await requireUser();
  const detail = await getDeliveryTaskDetail(user.id, taskKey);
  if (!detail) notFound();
  const { phase, task } = detail;
  const sourceOptions = await getEvidenceLinkOptions(user.id);
  const currentStatus: TaskStatus = isTaskStatus(task.status) ? task.status : "pending";
  const transitions = allowedTaskTransitions(currentStatus);
  const evidenceTypes: EvidenceTypeOption[] = EVIDENCE_TYPES.map((value) => ({
    value,
    label: EVIDENCE_TYPE_LABELS[value as EvidenceType],
    hint: EVIDENCE_TYPE_HINTS[value as EvidenceType],
    sourceType: SOURCE_TYPE[value] ?? null,
    sourceRequired: SOURCE_REQUIRED.has(value),
  }));

  const pendingEvidence = task.evidence.filter((evidence) => evidence.verificationStatus === "pending_review");

  return (
    <div className="space-y-8">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link href="/app/delivery" className="underline">
            Delivery Tracker
          </Link>{" "}
          <span aria-hidden="true">/</span>{" "}
          <Link href={`/app/delivery/phases/${phase.stableKey}`} className="underline">
            Phase {phase.phaseOrder} — {phase.title}
          </Link>{" "}
          <span aria-hidden="true">/</span> <span>Task {phase.phaseOrder}.{task.taskOrder}</span>
        </nav>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
              Task {phase.phaseOrder}.{task.taskOrder}
            </p>
            <h1 className="mt-1 text-2xl font-semibold">{task.title}</h1>
            <p className="mt-1 max-w-3xl text-slate-500 dark:text-slate-400">{task.description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <TaskStatusBadge status={task.status} />
            <VerificationBadge status={task.verificationStatus} />
          </div>
        </div>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          Assigned user: not supported by this application&apos;s single-owner model. Only the owner may change status,
          attach evidence, or review verification.
        </p>
      </header>

      <section aria-labelledby="task-metadata">
        <SectionTitle>
          <span id="task-metadata">Task record</span>
        </SectionTitle>
        <Card>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Reported status</dt>
              <dd className="mt-1">
                <TaskStatusBadge status={task.status} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Verification</dt>
              <dd className="mt-1">
                <VerificationBadge status={task.verificationStatus} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Completed at</dt>
              <dd className="mt-1">
                <Time date={task.completedAt} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Verified at</dt>
              <dd className="mt-1">
                <Time date={task.verifiedAt} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Verified by</dt>
              <dd className="mt-1">{task.verifier?.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Evidence records</dt>
              <dd className="mt-1">{task.evidence.length}</dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Updated</dt>
              <dd className="mt-1">
                <Time date={task.updatedAt} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400">Stable key</dt>
              <dd className="mt-1 font-mono text-xs break-all">{task.stableKey}</dd>
            </div>
          </dl>

          {task.status === "completed" && task.verificationStatus === "unverified" && (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              This task is <strong>reported complete</strong> but has no evidence-verified completion. The green
              verification state requires attached evidence and an explicit authorized review.
            </p>
          )}
          {task.verificationStatus === "pending_review" && (
            <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {pendingEvidence.length} evidence record{pendingEvidence.length === 1 ? "" : "s"} await an authorized
              review decision. Attaching evidence never verifies a task automatically.
            </p>
          )}
          {task.verificationStatus === "rejected" && (
            <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
              Every evidence record on this task was rejected. Rejected evidence is retained in the audit history and is
              not converted into success.
            </p>
          )}
          {task.verificationStatus === "verified" && (
            <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
              Evidence verified by an explicit owner review. This is not an independent third-party audit; the
              verification basis is recorded on each accepted evidence record.
            </p>
          )}
        </Card>
      </section>

      <section aria-labelledby="status-heading">
        <SectionTitle>
          <span id="status-heading">Change status</span>
        </SectionTitle>
        <Card>
          {transitions.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No transitions are available from this status.</p>
          ) : (
            <FormShell action={updateDeliveryTaskStatusAction} submitLabel="Update status">
              <input type="hidden" name="taskId" value={task.id} />
              <label htmlFor="delivery-status" className="block text-sm font-medium">
                New status
              </label>
              <select id="delivery-status" name="status" className={`${inputCls} max-w-xs`} defaultValue={transitions[0]}>
                {transitions.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABEL[status] ?? status}
                  </option>
                ))}
              </select>
              <label htmlFor="delivery-status-reason" className="block text-sm font-medium">
                Reason or blocker <span className="font-normal text-slate-500 dark:text-slate-400">(required when blocked)</span>
              </label>
              <textarea
                id="delivery-status-reason"
                name="reason"
                rows={2}
                maxLength={1000}
                placeholder="Why is the status changing? What is blocking it?"
                className={inputCls}
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Changing the status of a verified task invalidates prior verification. Evidence must be reviewed again.
              </p>
            </FormShell>
          )}
        </Card>
      </section>

      <section aria-labelledby="notes-heading">
        <SectionTitle>
          <span id="notes-heading">Completion notes</span>
        </SectionTitle>
        <Card>
          <FormShell action={updateDeliveryTaskNotesAction} submitLabel="Save notes">
            <input type="hidden" name="taskId" value={task.id} />
            <label htmlFor="completion-notes" className="block text-sm font-medium">
              Notes, blockers, and context
            </label>
            <textarea
              id="completion-notes"
              name="notes"
              rows={4}
              maxLength={2000}
              defaultValue={task.completionNotes ?? ""}
              placeholder="What was done, what remains, and any blocker. Do not paste secrets."
              className={inputCls}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Editing notes on a verified task invalidates its verification so the new claim can be reviewed.
            </p>
          </FormShell>
        </Card>
      </section>

      <section aria-labelledby="evidence-heading">
        <SectionTitle>
          <span id="evidence-heading">Evidence</span>
        </SectionTitle>
        {task.evidence.length === 0 ? (
          <EmptyState title="No evidence attached">
            Attach a real test run, GitHub check, TestSprite execution, monitoring check, CI result, deployment health
            check, documentation reference, or review note. No evidence is fabricated by the tracker.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {task.evidence.map((evidence) => {
              const route = evidenceRoute(evidence.sourceRecordType, evidence.sourceRecordId);
              return (
                <li key={evidence.id}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          {EVIDENCE_TYPE_LABELS[evidence.evidenceType as EvidenceType] ?? humanizeEvidenceType(evidence.evidenceType)}
                        </p>
                        <h3 className="mt-1 font-semibold break-words">{evidence.title}</h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge status={evidence.verificationStatus}>
                          {evidence.verificationStatus.replace(/_/g, " ")}
                        </Badge>
                        {evidence.verificationBasis && (
                          <Badge status="unknown" tooltip="How this evidence was accepted">
                            {evidence.verificationBasis.replace(/_/g, " ")}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Reference</dt>
                        <dd className="mt-1 break-all">
                          {evidence.referenceUrl || evidence.artifactReference ? (
                            evidence.referenceUrl ? (
                              <SafeExternalLink href={evidence.referenceUrl} />
                            ) : (
                              <code className="text-xs">{evidence.artifactReference}</code>
                            )
                          ) : (
                            "None"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Commit</dt>
                        <dd className="mt-1 font-mono text-xs break-all">{evidence.sourceCommitSha ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Linked record</dt>
                        <dd className="mt-1">
                          {evidence.sourceRecordType && evidence.sourceRecordId ? (
                            route ? (
                              <Link href={route} className="underline">
                                {evidence.sourceRecordType.replace(/_/g, " ")} · {evidence.sourceRecordId.slice(0, 12)}
                              </Link>
                            ) : (
                              <span className="font-mono text-xs">
                                {evidence.sourceRecordType} · {evidence.sourceRecordId.slice(0, 12)}
                              </span>
                            )
                          ) : (
                            "None"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500 dark:text-slate-400">Submitted</dt>
                        <dd className="mt-1">
                          <Time date={evidence.createdAt} />
                          {evidence.submitter && <span> by {evidence.submitter.name}</span>}
                        </dd>
                      </div>
                      {evidence.verifiedAt && (
                        <div>
                          <dt className="text-slate-500 dark:text-slate-400">Verified</dt>
                          <dd className="mt-1">
                            <Time date={evidence.verifiedAt} />
                            {evidence.verifier && <span> by {evidence.verifier.name}</span>}
                          </dd>
                        </div>
                      )}
                    </dl>

                    {evidence.notes && (
                      <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-950/40">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Review note
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words">{evidence.notes}</p>
                      </div>
                    )}

                    {evidence.verificationStatus !== "verified" && (
                      <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
                        <FormShell action={reviewDeliveryEvidenceAction} submitLabel="Record review decision">
                          <input type="hidden" name="evidenceId" value={evidence.id} />
                          <label htmlFor={`review-decision-${evidence.id}`} className="block text-sm font-medium">
                            Review decision
                          </label>
                          <select
                            id={`review-decision-${evidence.id}`}
                            name="decision"
                            className={`${inputCls} max-w-xs`}
                            defaultValue="verify"
                          >
                            <option value="verify">Verify evidence</option>
                            <option value="reject">Reject evidence</option>
                          </select>
                          <label htmlFor={`review-note-${evidence.id}`} className="block text-sm font-medium">
                            Review note <span className="font-normal text-slate-500 dark:text-slate-400">(required to reject)</span>
                          </label>
                          <textarea
                            id={`review-note-${evidence.id}`}
                            name="note"
                            rows={2}
                            maxLength={1000}
                            placeholder="For external checks: the observed conclusion, scope, method, date, and reviewer."
                            className={inputCls}
                          />
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Verification runs the evidence policy on the server. A rejected or failed review stays
                            visible and is never converted into a verified state.
                          </p>
                        </FormShell>
                      </div>
                    )}
                  </Card>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-labelledby="attach-evidence-heading">
        <SectionTitle>
          <span id="attach-evidence-heading">Attach evidence for review</span>
        </SectionTitle>
        <Card>
          <EvidenceForm taskId={task.id} types={evidenceTypes} sources={sourceOptions} />
        </Card>
      </section>

      <section aria-labelledby="audit-heading">
        <SectionTitle>
          <span id="audit-heading">Audit history</span>
        </SectionTitle>
        <Card>
          {task.auditEvents.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No audit events have been recorded.</p>
          ) : (
            <ol className="space-y-4">
              {task.auditEvents.map((event) => (
                <li key={event.id} className="border-l-2 border-slate-200 pl-3 dark:border-slate-800">
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium">{humanizeAction(event.action)}</span>
                    {event.previousStatus || event.newStatus ? (
                      <span className="text-slate-500 dark:text-slate-400">
                        {event.previousStatus ? STATUS_LABEL[event.previousStatus] ?? event.previousStatus : "—"} →{" "}
                        {event.newStatus ? STATUS_LABEL[event.newStatus] ?? event.newStatus : "—"}
                      </span>
                    ) : null}
                    <span className="text-slate-500 dark:text-slate-400">
                      · {event.actor?.name ?? "System / initial import"}
                    </span>
                    <span className="text-slate-500 dark:text-slate-400">
                      · <Time date={event.createdAt} />
                    </span>
                  </div>
                  {event.reason && <p className="mt-1 text-sm whitespace-pre-wrap break-words">{event.reason}</p>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      <section aria-labelledby="reports-heading">
        <SectionTitle>
          <span id="reports-heading">Submission report</span>
        </SectionTitle>
        <Card>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            The report is generated from the current database state and labels reported completion, verified evidence,
            and outstanding issues separately.
          </p>
          <Link
            href="/app/delivery/report"
            className="mt-3 inline-flex rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            Generate project report
          </Link>
        </Card>
      </section>
    </div>
  );
}

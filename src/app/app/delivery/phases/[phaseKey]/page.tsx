import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getDeliveryPhaseDetail } from "@/modules/delivery/service";
import { phaseStats } from "@/modules/delivery/model";
import { Badge, Card, EmptyState, LinkButton, SectionTitle, Time } from "@/components/ui";
import { ProgressBar } from "@/components/delivery/progress";
import { TaskStatusBadge, VerificationBadge } from "@/components/delivery/status";

export const dynamic = "force-dynamic";

export default async function DeliveryPhasePage({ params }: { params: Promise<{ phaseKey: string }> }) {
  const { phaseKey } = await params;
  const user = await requireUser();
  const detail = await getDeliveryPhaseDetail(user.id, phaseKey);
  if (!detail) notFound();
  const { phase } = detail;
  const stats = phaseStats(phase.tasks);

  return (
    <div className="space-y-8">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link href="/app/delivery" className="underline">
            Delivery Tracker
          </Link>{" "}
          <span aria-hidden="true">/</span> <span>Phase {phase.phaseOrder}</span>
        </nav>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Phase {phase.phaseOrder}</p>
            <h1 className="mt-1 text-2xl font-semibold">{phase.title}</h1>
            {phase.description && (
              <p className="mt-1 max-w-3xl text-slate-500 dark:text-slate-400">{phase.description}</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge status={stats.fullyCompleted ? "completed" : "in_progress"}>
              {stats.fullyCompleted ? "All tasks reported complete" : "In progress"}
            </Badge>
            <Badge status={stats.fullyVerified ? "verified" : "unverified"}>
              {stats.fullyVerified ? "All tasks verified" : `${stats.verified} of ${stats.total} verified`}
            </Badge>
          </div>
        </div>
      </header>

      <section aria-labelledby="phase-progress">
        <SectionTitle>
          <span id="phase-progress">Phase progress</span>
        </SectionTitle>
        <Card>
          <div className="grid gap-6 sm:grid-cols-2">
            <ProgressBar
              value={stats.completionPercent}
              label={`Reported completion (${stats.completed} of ${stats.total} tasks)`}
            />
            <ProgressBar
              value={stats.verificationPercent}
              label={`Evidence verified (${stats.verified} of ${stats.total} tasks)`}
              tone="verified"
            />
          </div>
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            A phase is fully completed only when every task is reported complete. It is fully verified only when every
            task has evidence accepted by an authorized review. Completion and verification are separate.
          </p>
        </Card>
      </section>

      <section aria-labelledby="task-list">
        <SectionTitle action={<LinkButton href="/app/delivery" variant="secondary">Back to overview</LinkButton>}>
          <span id="task-list">Task checklist</span>
        </SectionTitle>
        {phase.tasks.length === 0 ? (
          <EmptyState title="No tasks in this phase" />
        ) : (
          <ol className="space-y-3">
            {phase.tasks.map((task) => (
              <li key={task.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Task {phase.phaseOrder}.{task.taskOrder}
                      </p>
                      <h3 className="mt-1 text-base font-semibold">
                        <Link
                          href={`/app/delivery/tasks/${task.stableKey}`}
                          className="underline decoration-transparent hover:decoration-current focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                        >
                          {task.title}
                        </Link>
                      </h3>
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{task.description}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <TaskStatusBadge status={task.status} />
                      <VerificationBadge status={task.verificationStatus} />
                    </div>
                  </div>

                  <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">Completed</dt>
                      <dd>
                        <Time date={task.completedAt} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">Verified</dt>
                      <dd>
                        <Time date={task.verifiedAt} />
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500 dark:text-slate-400">Evidence</dt>
                      <dd>
                        {task.evidence.length} record{task.evidence.length === 1 ? "" : "s"}
                        {task.evidence.some((evidence) => evidence.verificationStatus === "pending_review") && (
                          <span className="ml-2 text-amber-700 dark:text-amber-300">review pending</span>
                        )}
                      </dd>
                    </div>
                  </dl>

                  {task.completionNotes && (
                    <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-950/40">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Notes / blockers
                      </p>
                      <p className="mt-1 whitespace-pre-wrap break-words">{task.completionNotes}</p>
                    </div>
                  )}

                  <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                    {task.auditEvents.length} audit event{task.auditEvents.length === 1 ? "" : "s"} · last changed{" "}
                    <Time date={task.updatedAt} />
                  </p>
                </Card>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

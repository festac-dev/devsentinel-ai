import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDeliverySnapshot } from "@/modules/delivery/service";
import {
  evaluateSubmissionReadiness,
  overallStats,
  phaseStats,
} from "@/modules/delivery/model";
import { Badge, Card, LinkButton, SectionTitle, Time } from "@/components/ui";
import { ProgressBar } from "@/components/delivery/progress";
import {
  ReadinessBadge,
  TaskStatusBadge,
  VerificationBadge,
} from "@/components/delivery/status";
import { SafeExternalLink } from "@/components/delivery/safe-link";

export const dynamic = "force-dynamic";

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {detail && <dd className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</dd>}
    </div>
  );
}

export default async function DeliveryOverviewPage() {
  const user = await requireUser();
  const snapshot = await getDeliverySnapshot(user.id);
  const { tracker } = snapshot;
  const stats = overallStats(snapshot);
  const readiness = evaluateSubmissionReadiness(snapshot);

  return (
    <div className="space-y-8">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Delivery Tracker</p>
            <h1 className="mt-1 text-2xl font-semibold">{tracker.title}</h1>
            {tracker.description && (
              <p className="mt-1 max-w-3xl text-slate-500 dark:text-slate-400">{tracker.description}</p>
            )}
          </div>
          <LinkButton href="/app/delivery/report">Generate project report</LinkButton>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-500 dark:text-slate-400">
          <span>
            Live application: <SafeExternalLink href={tracker.liveUrl} />
          </span>
          <span>
            Repository: <SafeExternalLink href={tracker.repositoryUrl} />
          </span>
          <span>
            Last updated: <Time date={snapshot.lastUpdated} />
          </span>
        </div>
      </header>

      <section aria-labelledby="honesty-heading">
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <h2 id="honesty-heading" className="font-semibold">
            Reported completion and evidence verification are separate
          </h2>
          <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
            The 16 initial tasks were supplied as completed. They are stored as <strong>reported complete</strong> and
            begin <strong>unverified</strong>. A green verification badge requires an attached evidence record and an
            explicit authorized review; nothing is auto-verified.
          </p>
        </Card>
      </section>

      <section aria-labelledby="progress-heading">
        <SectionTitle>Overall progress</SectionTitle>
        <h2 id="progress-heading" className="sr-only">
          Overall progress
        </h2>
        <Card>
          <div className="grid gap-6 sm:grid-cols-2">
            <ProgressBar
              value={stats.completionPercent}
              label={`Reported completion (${stats.completed} of ${stats.total})`}
            />
            <ProgressBar
              value={stats.verificationPercent}
              label={`Evidence verified (${stats.verified} of ${stats.total})`}
              tone="verified"
            />
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Completed" value={stats.completed} detail="Reported complete" />
            <Stat label="In progress" value={stats.inProgress} />
            <Stat label="Blocked" value={stats.blocked} />
            <Stat label="Pending" value={stats.pending} />
            <Stat label="Verified" value={stats.verified} detail="Evidence reviewed" />
            <Stat label="Verification pending" value={stats.pendingReview} />
          </dl>
        </Card>
      </section>

      <section aria-labelledby="readiness-heading">
        <SectionTitle action={<ReadinessBadge ready={readiness.ready} />}>
          <span id="readiness-heading">Submission readiness</span>
        </SectionTitle>
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-400">{readiness.summary}</p>
          <ul className="mt-4 space-y-2">
            {readiness.criteria.map((criterion) => (
              <li key={criterion.key} className="flex flex-wrap items-baseline gap-2 text-sm">
                <Badge status={criterion.met ? "verified" : "pending_review"}>
                  {criterion.met ? "Met" : "Open"}
                </Badge>
                <span className={criterion.met ? "" : "font-medium"}>{criterion.label}</span>
                <span className="text-slate-500 dark:text-slate-400">— {criterion.detail}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
            Completion percentage alone never makes the project submission-ready. Verification in this single-owner
            application is an explicit owner review recorded with an actor and timestamp; it is not a third-party audit.
          </p>
        </Card>
      </section>

      <section aria-labelledby="phases-heading">
        <SectionTitle>
          <span id="phases-heading">Four phases</span>
        </SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          {tracker.phases.map((phase) => {
            const phaseStat = phaseStats(phase.tasks);
            const taskStatuses = ["completed", "in_progress", "blocked", "pending"] as const;
            return (
              <Card key={phase.id} className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Phase {phase.phaseOrder}
                    </p>
                    <h3 className="mt-1 text-lg font-semibold">
                      <Link
                        href={`/app/delivery/phases/${phase.stableKey}`}
                        className="underline decoration-transparent hover:decoration-current focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                      >
                        {phase.title}
                      </Link>
                    </h3>
                  </div>
                  <Badge status={phaseStat.fullyCompleted ? "completed" : "in_progress"}>
                    {phaseStat.fullyCompleted ? "Reported complete" : "In progress"}
                  </Badge>
                </div>
                {phase.description && (
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{phase.description}</p>
                )}
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <ProgressBar
                    value={phaseStat.completionPercent}
                    label={`${phaseStat.completed} of ${phaseStat.total} reported complete`}
                  />
                  <ProgressBar
                    value={phaseStat.verificationPercent}
                    label={`${phaseStat.verified} of ${phaseStat.total} verified`}
                    tone="verified"
                  />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {taskStatuses.map((status) => {
                    const count =
                      status === "completed"
                        ? phaseStat.completed
                        : status === "in_progress"
                          ? phaseStat.inProgress
                          : status === "blocked"
                            ? phaseStat.blocked
                            : phaseStat.pending;
                    return count > 0 ? (
                      <span key={status} className="inline-flex items-center gap-1.5 text-xs">
                        <TaskStatusBadge status={status} />
                        <span className="tabular-nums text-slate-500 dark:text-slate-400">{count}</span>
                      </span>
                    ) : null;
                  })}
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <VerificationBadge status={phaseStat.fullyVerified ? "verified" : "unverified"} />
                    <span className="tabular-nums text-slate-500 dark:text-slate-400">{phaseStat.verified}</span>
                  </span>
                </div>
                <div className="mt-auto pt-4 text-sm">
                  <Link
                    href={`/app/delivery/phases/${phase.stableKey}`}
                    className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    View phase tasks
                  </Link>
                </div>
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}

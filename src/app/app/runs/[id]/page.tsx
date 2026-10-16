import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, Time, SourceBadge, StaleBadge, SectionTitle, ErrorNote } from "@/components/ui";
import { isStale } from "@/modules/runs/status";
import { retryRunAction } from "@/app/actions/projects";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) notFound();
  const run = await prisma.testRun.findFirst({
    where: { id: id, project: { ownerId: user.id } },
    include: { pr: true, project: true, parent: true, retries: true, publications: true },
  });
  if (!run) notFound();

  let summary: { total?: number; passed?: number; failed?: number; skipped?: number; durationSec?: number } | null = null;
  if (run.summary) {
    try { summary = JSON.parse(run.summary); } catch { summary = null; }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">Test run</h1>
          <Badge status={run.status}>{run.status}</Badge>
          <SourceBadge source={run.source} />
          {run.pr && isStale(run, run.pr) && <StaleBadge runSha={run.commitSha} headSha={run.pr.currentHeadSha} />}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Project <Link href={`/app/projects/${run.project.id}`} className="underline">{run.project.name}</Link>
          {run.pr && <> · Pull request <Link href={`/app/pull-requests/${run.pr.id}`} className="underline">#{run.pr.number}</Link></>}
          {" "}· Commit <span className="font-mono">{run.commitSha.slice(0, 12)}</span> · Trigger {run.trigger}
          {run.attempt > 1 && <> · Attempt {run.attempt}</>}
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Queued <Time date={run.queuedAt} /> · Started <Time date={run.startedAt} /> · Completed <Time date={run.completedAt} />
        </p>
      </div>

      {run.pr && isStale(run, run.pr) && (
        <ErrorNote>
          This result is stale: it tested commit <strong>{run.commitSha.slice(0, 7)}</strong> but the pull request&apos;s current head is{" "}
          <strong>{run.pr.currentHeadSha.slice(0, 7)}</strong>. It does not validate the current head.
        </ErrorNote>
      )}

      {run.status === "error" && run.statusReason && <ErrorNote>Run ended in error: {run.statusReason}</ErrorNote>}

      <section>
        <SectionTitle>Result</SectionTitle>
        <Card>
          {summary ? (
            <dl className="grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
              <div><dt className="text-slate-500 dark:text-slate-400">Total</dt><dd className="text-lg font-semibold">{summary.total ?? "unavailable"}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">Passed</dt><dd className="text-lg font-semibold">{summary.passed ?? "unavailable"}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">Failed</dt><dd className="text-lg font-semibold">{summary.failed ?? "unavailable"}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">Skipped</dt><dd className="text-lg font-semibold">{summary.skipped ?? "unavailable"}</dd></div>
              <div><dt className="text-slate-500 dark:text-slate-400">Duration</dt><dd className="text-lg font-semibold">{summary.durationSec !== undefined ? `${summary.durationSec}s` : "unavailable"}</dd></div>
            </dl>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {run.status === "passed" || run.status === "failed"
                ? "Result unavailable — the provider did not return summary counts."
                : "Result unavailable — the run has not produced a result yet."}
            </p>
          )}
          {run.summaryText && <p className="text-sm mt-3">{run.summaryText}</p>}
          {run.externalRunId && <p className="text-sm mt-2 text-slate-500 dark:text-slate-400">Provider run reference: <span className="font-mono">{run.externalRunId}</span>{run.externalTestId ? <> · test <span className="font-mono">{run.externalTestId}</span></> : null}</p>}
        </Card>
      </section>

      {(run.output || run.errorMessage) && (
        <section>
          <SectionTitle>Provider output</SectionTitle>
          <Card>
            <pre className="whitespace-pre-wrap break-words text-xs font-mono max-h-96 overflow-y-auto">{run.output ?? run.errorMessage}</pre>
            {run.outputTruncated && <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">Output was truncated to the storage cap.</p>}
          </Card>
        </section>
      )}

      <section>
        <SectionTitle>GitHub publications</SectionTitle>
        <Card>
          {run.publications.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No status was published for this run (publishing may not be configured, or the run has not finished).</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {run.publications.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <Badge status={p.outcome}>{p.outcome.replace(/_/g, " ")}</Badge>
                  <span>{p.kind}</span>
                  {p.detail && <span className="text-slate-500 dark:text-slate-400">{p.detail}</span>}
                  <Time date={p.createdAt} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>Retry lineage</SectionTitle>
        <Card>
          {run.parent && (
            <p className="text-sm mb-2">
              Retrying <Link href={`/app/runs/${run.parent.id}`} className="underline">{run.parent.id.slice(0, 10)}</Link> (attempt {run.attempt})
            </p>
          )}
          {run.retries.length > 0 && (
            <ul className="text-sm list-disc pl-5">
              {run.retries.map((r) => (
                <li key={r.id}><Link href={`/app/runs/${r.id}`} className="underline">{r.id.slice(0, 10)}</Link> — attempt {r.attempt}, <Badge status={r.status}>{r.status}</Badge></li>
              ))}
            </ul>
          )}
          {!run.parent && run.retries.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">No retries of this run.</p>}
          <form action={retryRunAction} className="mt-3">
            <input type="hidden" name="runId" value={run.id} />
            <button type="submit" className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
              Retry this run (same commit)
            </button>
          </form>
        </Card>
      </section>
    </div>
  );
}

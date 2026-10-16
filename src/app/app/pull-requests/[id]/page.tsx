import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, Time, SourceBadge, StaleBadge, SectionTitle } from "@/components/ui";
import { isStale } from "@/modules/runs/status";
import { runTestsForPrAction } from "@/app/actions/projects";

export const dynamic = "force-dynamic";

export default async function PullRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) notFound();
  const pr = await prisma.pullRequest.findFirst({
    where: { id: id, project: { ownerId: user.id } },
    include: { project: true },
  });
  if (!pr) notFound();

  const runs = await prisma.testRun.findMany({
    where: { prId: pr.id },
    orderBy: { queuedAt: "desc" },
    include: { publications: true },
  });

  const currentRun = runs.find((r) => r.commitSha === pr.currentHeadSha && r.status !== "queued" && r.status !== "running");

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">
              {pr.repoOwner}/{pr.repoName} #{pr.number}
            </h1>
            <p>{pr.title}{pr.author ? ` · by ${pr.author}` : ""}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
              {pr.sourceBranch} → {pr.targetBranch} · head{" "}
              <a href={`https://github.com/${pr.repoOwner}/${pr.repoName}/pull/${pr.number}/commits/${pr.currentHeadSha}`} target="_blank" rel="noreferrer" className="underline">
                {pr.currentHeadSha.slice(0, 7)}
              </a>
            </p>
          </div>
          <form action={runTestsForPrAction}>
            <input type="hidden" name="prId" value={pr.id} />
            <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
              Run tests
            </button>
          </form>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Project: <Link href={`/app/projects/${pr.project.id}`} className="underline">{pr.project.name}</Link></p>
      </div>

      <section>
        <SectionTitle>Current result for head {pr.currentHeadSha.slice(0, 7)}</SectionTitle>
        {!currentRun ? (
          <EmptyState title="No completed run for the current head commit">
            Results apply only to the commit they tested. Push a new commit and wait for the run, or use “Run tests”.
          </EmptyState>
        ) : (
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Badge status={currentRun.status}>{currentRun.status}</Badge>
              <SourceBadge source={currentRun.source} />
              <Link href={`/app/runs/${currentRun.id}`} className="text-sm underline">View run detail</Link>
              <Time date={currentRun.completedAt ?? currentRun.queuedAt} />
            </div>
            {currentRun.summaryText && <p className="text-sm mt-2">{currentRun.summaryText}</p>}
            {currentRun.statusReason && <p className="text-sm mt-1 text-slate-500 dark:text-slate-400">{currentRun.statusReason}</p>}
          </Card>
        )}
      </section>

      <section>
        <SectionTitle>Run history (all commits)</SectionTitle>
        {runs.length === 0 ? (
          <EmptyState title="No runs for this pull request yet" />
        ) : (
          <div className="overflow-x-auto">
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-2">
              The status column shows <strong>DevSentinel&apos;s own</strong> commit-status publications. The TestSprite
              PR comment/check is posted by the TestSprite GitHub App on GitHub itself and is not produced by DevSentinel.
            </p>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4 font-medium">Commit</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 font-medium">Source</th><th className="py-2 pr-4 font-medium">Trigger</th><th className="py-2 pr-4 font-medium">DevSentinel status</th><th className="py-2 font-medium">Queued</th>
              </tr></thead>
              <tbody>
                {runs.map((r) => {
                  const stale = isStale(r, pr);
                  const pub = r.publications[0];
                  return (
                    <tr key={r.id} className="border-b border-slate-100 dark:border-slate-900">
                      <td className="py-2 pr-4 font-mono text-xs">
                        <Link href={`/app/runs/${r.id}`} className="underline">{r.commitSha.slice(0, 7)}</Link>
                        {stale && <StaleBadge runSha={r.commitSha} headSha={pr.currentHeadSha} />}
                      </td>
                      <td className="py-2 pr-4"><Badge status={r.status}>{r.status}</Badge></td>
                      <td className="py-2 pr-4"><SourceBadge source={r.source} /></td>
                      <td className="py-2 pr-4">{r.trigger}</td>
                      <td className="py-2 pr-4">{pub ? <Badge status={pub.outcome}>{pub.outcome.replace(/_/g, " ")}</Badge> : <span className="text-slate-400">—</span>}</td>
                      <td className="py-2"><Time date={r.queuedAt} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

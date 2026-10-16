import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmptyState, Badge, Time, StaleBadge } from "@/components/ui";
import { isStale } from "@/modules/runs/status";

export const dynamic = "force-dynamic";

export default async function PullRequestsPage() {
  const user = await requireUser();
  const prs = await prisma.pullRequest.findMany({
    where: { project: { ownerId: user.id } },
    orderBy: { updatedAt: "desc" },
    include: { project: true, runs: { orderBy: { queuedAt: "desc" }, take: 1 } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Pull Requests</h1>
        <p className="text-slate-500 dark:text-slate-400">Every PR seen through webhooks, with the current head SHA and its latest TestSprite run.</p>
      </div>

      {prs.length === 0 ? (
        <EmptyState title="No pull requests yet">
          Connect a repository in a project and open a pull request — the webhook starts a run automatically.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {prs.map((pr) => {
            const latest = pr.runs[0];
            const stale = latest ? isStale(latest, pr) : false;
            return (
              <Link key={pr.id} href={`/app/pull-requests/${pr.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{pr.repoOwner}/{pr.repoName} #{pr.number} — {pr.title}</p>
                  {pr.state === "closed" && <Badge status="closed">closed</Badge>}
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                  head {pr.currentHeadSha.slice(0, 7)} · {pr.sourceBranch} → {pr.targetBranch} · {pr.project.name}
                </p>
                {latest ? (
                  <p className="text-sm mt-1 flex items-center gap-2">
                    <span className="text-slate-500 dark:text-slate-400">Latest run:</span>
                    <Badge status={latest.status}>{latest.status}</Badge>
                    {stale && <StaleBadge runSha={latest.commitSha} headSha={pr.currentHeadSha} />}
                    <Time date={latest.queuedAt} />
                  </p>
                ) : (
                  <p className="text-sm mt-1 text-slate-500 dark:text-slate-400">No TestSprite runs yet.</p>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

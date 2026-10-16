import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, Time, SectionTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DeploymentsPage() {
  const user = await requireUser();
  const targets = await prisma.monitoringTarget.findMany({
    where: { project: { ownerId: user.id } },
    orderBy: { createdAt: "desc" },
    include: { project: true, checks: { orderBy: { checkedAt: "desc" }, take: 50 } },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Deployments</h1>
        <p className="text-slate-500 dark:text-slate-400">
          Deployment health observed from stored HTTP checks. DevSentinel does not deploy.
          GitHub deployment events are not configured in this build, so deployments cannot be linked to commits yet — only observed URL checks are shown.
        </p>
      </div>

      {targets.length === 0 ? (
        <EmptyState title="No deployment checks yet">Add a monitoring target for a deployed URL on the Monitoring page.</EmptyState>
      ) : (
        <div className="space-y-6">
          {targets.map((t) => {
            const relevant = t.checks.slice(0, 30);
            const successes = relevant.filter((c) => c.outcome === "success").length;
            const windowNote = `${relevant.length} checks in the shown window`;
            return (
              <Card key={t.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{t.name} <span className="text-sm text-slate-500 dark:text-slate-400">({t.project.name})</span></p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-mono truncate max-w-xl">{t.url}</p>
                  </div>
                  <Badge status={t.currentState}>{t.currentState}</Badge>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">
                  Uptime over shown window: {relevant.length > 0 ? `${Math.round((successes / relevant.length) * 100)}% (${windowNote})` : "no data"} — computed only from stored checks.
                </p>
                <SectionTitle>Recent checks</SectionTitle>
                {relevant.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">No checks recorded yet.</p>
                ) : (
                  <ul className="text-xs space-y-1">
                    {relevant.map((c) => (
                      <li key={c.id} className="flex flex-wrap gap-2">
                        <Time date={c.checkedAt} />
                        <Badge status={c.outcome === "success" ? "passed" : "failed"}>{c.outcome}</Badge>
                        {c.statusCode !== null && <span>HTTP {c.statusCode}</span>}
                        {c.responseTimeMs !== null && <span>{c.responseTimeMs} ms</span>}
                        {c.errorClass && <span className="text-rose-600 dark:text-rose-400">{c.errorClass}</span>}
                        {c.redirectedTo && <span className="truncate max-w-xs">→ {c.redirectedTo}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

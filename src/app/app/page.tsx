import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, SectionTitle, Badge, EmptyState, Time, SourceBadge, LinkButton } from "@/components/ui";
import { isStale } from "@/modules/runs/status";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const user = await requireUser();
  const projects = await prisma.project.findMany({
    where: { ownerId: user.id },
    include: { repository: true },
    orderBy: { createdAt: "asc" },
  });
  const projectIds = projects.map((p) => p.id);

  const [recentRuns, activeIncidents, openIncidentCount] = await Promise.all([
    projectIds.length
      ? prisma.testRun.findMany({
          where: { projectId: { in: projectIds } },
          orderBy: { queuedAt: "desc" },
          take: 8,
          include: { pr: true },
        })
      : Promise.resolve([]),
    projectIds.length
      ? prisma.incident.findMany({
          where: { projectId: { in: projectIds }, status: { in: ["open", "investigating", "identified"] } },
          orderBy: { openedAt: "desc" },
          take: 5,
        })
      : Promise.resolve([]),
    projectIds.length
      ? prisma.incident.count({ where: { projectId: { in: projectIds }, status: { in: ["open", "investigating", "identified"] } } })
      : Promise.resolve(0),
  ]);

  const prs = projectIds.length
    ? await prisma.pullRequest.findMany({
        where: { projectId: { in: projectIds }, state: "open" },
        orderBy: { updatedAt: "desc" },
        take: 5,
        include: { project: true },
      })
    : [];
  const monitoringTargets = projectIds.length
    ? await prisma.monitoringTarget.findMany({ where: { projectId: { in: projectIds } }, orderBy: { createdAt: "desc" }, take: 5 })
    : [];

  const hasData = projects.length > 0;

  if (!hasData) {
    return (
      <div>
        <h1 className="text-2xl font-semibold mb-2">Welcome to DevSentinel AI</h1>
        <p className="text-slate-500 dark:text-slate-400 mb-6">Set up your first project to start testing pull requests with TestSprite.</p>
        <Card>
          <ol className="space-y-3 text-sm">
            {[
              { done: true, label: "Create your account" },
              { done: false, label: "Create a project", href: "/app/projects" },
              { done: false, label: "Connect a GitHub repository", href: "/app/projects" },
              { done: false, label: "Configure TestSprite credentials", href: "/app/integrations" },
              { done: false, label: "Open a pull request (the webhook starts a run)" },
            ].map((step, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${step.done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300" : "bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`}>
                  {step.done ? "✓" : i + 1}
                </span>
                {step.href ? <Link href={step.href} className="underline">{step.label}</Link> : <span>{step.label}</span>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    );
  }

  const passing = recentRuns.filter((r) => r.status === "passed").length;
  const failing = recentRuns.filter((r) => r.status === "failed").length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-slate-500 dark:text-slate-400">
          {projects.length} project{projects.length === 1 ? "" : "s"} · last 8 runs: {passing} passed, {failing} failed · {openIncidentCount} active incident{openIncidentCount === 1 ? "" : "s"}
        </p>
      </div>

      <section>
        <SectionTitle action={<LinkButton href="/app/projects" variant="secondary">Manage projects</LinkButton>}>Projects</SectionTitle>
        {projects.length === 0 ? <EmptyState title="No projects yet" /> : (
          <div className="space-y-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/app/projects/${p.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {p.repository ? `${p.repository.owner}/${p.repository.repo}` : "No repository connected"}
                      {p.repository?.disabled && <span className="ml-2 text-rose-600 dark:text-rose-400">(disabled: {p.repository.disabledReason})</span>}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle action={<LinkButton href="/app/pull-requests" variant="secondary">All pull requests</LinkButton>}>Recent pull requests</SectionTitle>
        {prs.length === 0 ? <EmptyState title="No pull requests yet">Open a PR on a connected repository — the webhook starts a TestSprite run automatically.</EmptyState> : (
          <div className="space-y-2">
            {prs.map((pr) => (
              <Link key={pr.id} href={`/app/pull-requests/${pr.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <p className="font-medium">{pr.repoOwner}/{pr.repoName} #{pr.number} — {pr.title}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">head {pr.currentHeadSha.slice(0, 7)} · {pr.sourceBranch} → {pr.targetBranch}</p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle action={<LinkButton href="/app/runs" variant="secondary">All test runs</LinkButton>}>Recent test runs</SectionTitle>
        {recentRuns.length === 0 ? <EmptyState title="No test runs yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                <th className="py-2 pr-4 font-medium">Run</th><th className="py-2 pr-4 font-medium">Commit</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 font-medium">Source</th><th className="py-2 font-medium">Queued</th>
              </tr></thead>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-900">
                    <td className="py-2 pr-4"><Link href={`/app/runs/${r.id}`} className="underline">{r.trigger}{r.pr ? ` · PR #${r.pr.number}` : ""}</Link></td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.commitSha.slice(0, 7)}{r.pr && isStale(r, r.pr) && <Badge status="unknown" tooltip={`Tested commit ${r.commitSha.slice(0, 7)}; current head is ${r.pr.currentHeadSha.slice(0, 7)}`}>stale</Badge>}</td>
                    <td className="py-2 pr-4"><Badge status={r.status}>{r.status}</Badge></td>
                    <td className="py-2 pr-4"><SourceBadge source={r.source} /></td>
                    <td className="py-2"><Time date={r.queuedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle action={<LinkButton href="/app/incidents" variant="secondary">All incidents</LinkButton>}>Active incidents</SectionTitle>
        {activeIncidents.length === 0 ? <EmptyState title="No active incidents" /> : (
          <div className="space-y-2">
            {activeIncidents.map((i) => (
              <Link key={i.id} href={`/app/incidents/${i.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">{i.title}</p>
                  <div className="flex gap-2"><Badge status={i.severity}>{i.severity}</Badge><Badge status={i.status}>{i.status}</Badge></div>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Opened <Time date={i.openedAt} /></p>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle action={<LinkButton href="/app/monitoring" variant="secondary">Monitoring</LinkButton>}>Deployment checks</SectionTitle>
        {monitoringTargets.length === 0 ? <EmptyState title="No monitoring targets" /> : (
          <div className="space-y-2">
            {monitoringTargets.map((t) => (
              <div key={t.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium truncate">{t.name}</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{t.url}</p>
                </div>
                <Badge status={t.currentState}>{t.currentState}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

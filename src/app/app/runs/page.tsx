import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, Time, SourceBadge, StaleBadge } from "@/components/ui";
import { isStale, RUN_SOURCES } from "@/modules/runs/status";

export const dynamic = "force-dynamic";

type Search = { project?: string; status?: string; source?: string; sha?: string; trigger?: string };

export default async function RunsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const user = await requireUser();

  const where: Record<string, unknown> = { project: { ownerId: user.id } };
  if (sp.project) where.projectId = sp.project;
  if (sp.status) where.status = sp.status;
  if (sp.source) where.source = sp.source;
  if (sp.trigger) where.trigger = sp.trigger;
  if (sp.sha) where.commitSha = { startsWith: sp.sha.trim().toLowerCase() };

  const [runs, projects] = await Promise.all([
    prisma.testRun.findMany({ where, orderBy: { queuedAt: "desc" }, take: 50, include: { pr: true, project: true } }),
    prisma.project.findMany({ where: { ownerId: user.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const filterCls = "rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Test Runs</h1>
        <p className="text-slate-500 dark:text-slate-400">Showing up to 50 most recent runs matching the filters. Each run is permanently bound to its commit SHA.</p>
      </div>

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm" htmlFor="f-project">Project
            <select id="f-project" name="project" defaultValue={sp.project ?? ""} className={`${filterCls} block`}>
              <option value="">All</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-sm" htmlFor="f-status">Status
            <select id="f-status" name="status" defaultValue={sp.status ?? ""} className={`${filterCls} block`}>
              <option value="">All</option>
              {["queued", "running", "passed", "failed", "cancelled", "error", "unknown"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm" htmlFor="f-source">Source
            <select id="f-source" name="source" defaultValue={sp.source ?? ""} className={`${filterCls} block`}>
              <option value="">All</option>
              {RUN_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm" htmlFor="f-trigger">Trigger
            <select id="f-trigger" name="trigger" defaultValue={sp.trigger ?? ""} className={`${filterCls} block`}>
              <option value="">All</option>
              {["pull_request", "manual", "retry"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm" htmlFor="f-sha">Commit SHA
            <input id="f-sha" name="sha" defaultValue={sp.sha ?? ""} placeholder="full or prefix" className={`${filterCls} block`} />
          </label>
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
            Apply filters
          </button>
          <Link href="/app/runs" className="text-sm underline">Clear</Link>
        </form>
      </Card>

      {runs.length === 0 ? (
        <EmptyState title="No test runs match">Adjust the filters, or trigger a run from a pull request page.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
              <th className="py-2 pr-4 font-medium">Run</th><th className="py-2 pr-4 font-medium">Project</th><th className="py-2 pr-4 font-medium">Commit</th><th className="py-2 pr-4 font-medium">Status</th><th className="py-2 pr-4 font-medium">Source</th><th className="py-2 pr-4 font-medium">Trigger</th><th className="py-2 font-medium">Queued</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 dark:border-slate-900">
                  <td className="py-2 pr-4"><Link href={`/app/runs/${r.id}`} className="underline">{r.id.slice(0, 10)}</Link></td>
                  <td className="py-2 pr-4"><Link href={`/app/projects/${r.project.id}`} className="underline">{r.project.name}</Link></td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {r.commitSha.slice(0, 7)}
                    {r.pr && isStale(r, r.pr) && <StaleBadge runSha={r.commitSha} headSha={r.pr.currentHeadSha} />}
                  </td>
                  <td className="py-2 pr-4"><Badge status={r.status}>{r.status}</Badge></td>
                  <td className="py-2 pr-4"><SourceBadge source={r.source} /></td>
                  <td className="py-2 pr-4">{r.trigger}</td>
                  <td className="py-2"><Time date={r.queuedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

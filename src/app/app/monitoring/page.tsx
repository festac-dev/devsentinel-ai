import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, EmptyState, Time, SectionTitle } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import { createMonitoringTargetAction, deleteMonitoringTargetAction, runCheckNowAction } from "@/app/actions/projects";
import { ALLOWED_PORTS } from "@/modules/monitoring/ssrf";

export const dynamic = "force-dynamic";

export default async function MonitoringPage() {
  const user = await requireUser();
  const targets = await prisma.monitoringTarget.findMany({
    where: { project: { ownerId: user.id } },
    orderBy: { createdAt: "desc" },
    include: { project: true, checks: { orderBy: { checkedAt: "desc" }, take: 5 } },
  });
  const projects = await prisma.project.findMany({ where: { ownerId: user.id }, orderBy: { name: "asc" } });

  const inputCls = "w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Monitoring</h1>
        <p className="text-slate-500 dark:text-slate-400">
          DevSentinel observes deployed applications over HTTP. It does not deploy or manage infrastructure.
          Internal addresses (loopback, private ranges, cloud metadata) are blocked; allowed ports are {Array.from(ALLOWED_PORTS).join(", ")}.
        </p>
      </div>

      {projects.length === 0 ? (
        <EmptyState title="Create a project first">Monitoring targets belong to projects.</EmptyState>
      ) : (
        <Card>
          <h2 className="font-semibold mb-3">Add a monitoring target</h2>
          <FormShell action={createMonitoringTargetAction} submitLabel="Create target">
            <label htmlFor="m-project" className="block text-sm font-medium">Project</label>
            <select id="m-project" name="projectId" className={inputCls}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="m-name" className="block text-sm font-medium mb-1">Name</label>
                <input id="m-name" name="name" placeholder="Staging web" className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-url" className="block text-sm font-medium mb-1">URL (http/https, ports 80/443/8080/8443)</label>
                <input id="m-url" name="url" type="url" required placeholder="https://staging.example.com/health" className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-method" className="block text-sm font-medium mb-1">Method</label>
                <select id="m-method" name="method" className={inputCls}><option>GET</option><option>HEAD</option></select>
              </div>
              <div>
                <label htmlFor="m-interval" className="block text-sm font-medium mb-1">Interval (minutes, 1–60)</label>
                <input id="m-interval" name="intervalMinutes" type="number" min={1} max={60} defaultValue={5} className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-timeout" className="block text-sm font-medium mb-1">Timeout (seconds, 1–30)</label>
                <input id="m-timeout" name="timeoutSeconds" type="number" min={1} max={30} defaultValue={10} className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-status" className="block text-sm font-medium mb-1">Expected status</label>
                <input id="m-status" name="expectedStatus" type="number" min={100} max={599} defaultValue={200} className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-body" className="block text-sm font-medium mb-1">Expected body substring (optional)</label>
                <input id="m-body" name="expectedBody" className={inputCls} />
              </div>
              <div>
                <label htmlFor="m-threshold" className="block text-sm font-medium mb-1">Failures before alerting (1–10)</label>
                <input id="m-threshold" name="failureThreshold" type="number" min={1} max={10} defaultValue={3} className={inputCls} />
              </div>
            </div>
          </FormShell>
        </Card>
      )}

      <section>
        <SectionTitle>Targets</SectionTitle>
        {targets.length === 0 ? (
          <EmptyState title="No monitoring targets yet">Add a deployed URL to start monitoring. Status shows as Unknown until the first check completes.</EmptyState>
        ) : (
          <div className="space-y-3">
            {targets.map((t) => (
              <Card key={t.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name} <span className="text-sm text-slate-500 dark:text-slate-400">({t.project.name})</span></p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 truncate font-mono">{t.method} {t.url}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      every {t.intervalMinutes} min · timeout {t.timeoutSeconds}s · expects {t.expectedStatus}
                      {t.expectedBody ? ` · body contains "${t.expectedBody}"` : ""} · alert after {t.failureThreshold} failures
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      Last checked <Time date={t.lastCheckedAt} /> · last success <Time date={t.lastSuccessAt} /> · last failure <Time date={t.lastFailureAt} />
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge status={t.currentState}>{t.currentState}</Badge>
                    <form action={runCheckNowAction}>
                      <input type="hidden" name="targetId" value={t.id} />
                      <button type="submit" className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Run check now</button>
                    </form>
                    <form action={deleteMonitoringTargetAction}>
                      <input type="hidden" name="targetId" value={t.id} />
                      <button type="submit" className="rounded-md border border-rose-300 dark:border-rose-900 px-2 py-1 text-xs text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Delete</button>
                    </form>
                  </div>
                </div>
                {t.checks.length > 0 && (
                  <div className="mt-3 border-t border-slate-200 dark:border-slate-800 pt-3">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Last checks</p>
                    <ul className="text-xs space-y-1">
                      {t.checks.map((c) => (
                        <li key={c.id} className="flex flex-wrap gap-2">
                          <Time date={c.checkedAt} />
                          <Badge status={c.outcome === "success" ? "passed" : "failed"}>{c.outcome}</Badge>
                          {c.statusCode !== null && <span>HTTP {c.statusCode}</span>}
                          {c.responseTimeMs !== null && <span>{c.responseTimeMs} ms</span>}
                          {c.errorClass && <span className="text-rose-600 dark:text-rose-400">{c.errorClass}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, Time } from "@/components/ui";
import { SystemStatus } from "@/components/system-status";
import { testspriteProvider } from "@/modules/testsprite/provider";
import { githubAppConfigured } from "@/modules/github/app-auth";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const user = await requireUser();
  const projects = await prisma.project.findMany({
    where: { ownerId: user.id },
    include: { repository: true, integrations: true },
    orderBy: { name: "asc" },
  });

  const perProjectChecks = await Promise.all(
    projects.map(async (p) => ({ project: p, ts: await testspriteProvider.checkConfiguration(p.id) }))
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Integrations &amp; system status</h1>
        <p className="text-slate-500 dark:text-slate-400">Current status of each external integration and background service.</p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">System</h2>
        <SystemStatus />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">TestSprite per project</h2>
        {perProjectChecks.length === 0 ? (
          <Card><p className="text-sm text-slate-500 dark:text-slate-400">No projects yet.</p></Card>
        ) : (
          <div className="space-y-3">
            {perProjectChecks.map(({ project: p, ts }) => (
              <Card key={p.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{p.name}</p>
                  <Badge status={ts.state}>{ts.state}</Badge>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400">{ts.message}</p>
                <p className="text-xs text-slate-400">
                  Project ID: {p.testspriteProjectId ?? "not set"} · Target URL: {p.testTargetUrl ?? "not set"}
                  {p.testspriteTestId && <> · Reusable test: <span className="font-mono">{p.testspriteTestId}</span></>}
                  {" "}· Last updated <Time date={p.updatedAt} />
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">GitHub repositories</h2>
        {projects.filter((p) => p.repository).length === 0 ? (
          <Card><p className="text-sm text-slate-500 dark:text-slate-400">No repositories connected.</p></Card>
        ) : (
          <div className="space-y-3">
            {projects.filter((p) => p.repository).map((p) => (
              <Card key={p.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{p.repository!.owner}/{p.repository!.repo}</p>
                  {p.repository!.disabled ? <Badge status="down">disabled: {p.repository!.disabledReason}</Badge> : <Badge status="published">active</Badge>}
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Webhook URL: <span className="font-mono text-xs">{process.env.APP_BASE_URL ?? "<APP_BASE_URL not set>"}/api/webhooks/github</span>
                  {" "}· Status publishing: {p.integrations.some((i) => i.kind === "github_token") ? "project token set" : p.repository!.installationId && githubAppConfigured() ? "GitHub App installation" : "not configured"}
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

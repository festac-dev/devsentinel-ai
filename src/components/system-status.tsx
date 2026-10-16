import { prisma } from "@/lib/db";
import { Badge, Card, Time } from "@/components/ui";
import { resolveCliPath } from "@/modules/testsprite/provider";
import { aiConfigured } from "@/modules/investigation/provider";
import { githubAppConfigured } from "@/modules/github/app-auth";

const WORKER_STALE_MS = 90_000;

function isWorkerLive(heartbeat: { updatedAt: Date } | null): boolean {
  return Boolean(heartbeat && Date.now() - heartbeat.updatedAt.getTime() < WORKER_STALE_MS);
}

/** Honest status of the background worker and each external integration. */
export async function SystemStatus() {
  const heartbeat = await prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } });
  const workerLive = isWorkerLive(heartbeat);
  const envConfigured = (v: string | undefined) => Boolean(v);
  const cliPath = resolveCliPath();

  return (
    <Card>
      <ul className="text-sm space-y-2">
        <li className="flex items-center gap-2">
          Background worker:{" "}
          {workerLive ? <Badge status="published">running</Badge> : <Badge status="down">not running</Badge>}
          <span className="text-slate-500 dark:text-slate-400">
            {heartbeat ? <>last heartbeat <Time date={heartbeat.updatedAt} /></> : "no heartbeat recorded"}
          </span>
        </li>
        <li>TestSprite CLI: {cliPath ? <span className="font-mono text-xs">{cliPath}</span> : <Badge status="down">not found</Badge>}</li>
        <li>
          GitHub webhook:{" "}
          {envConfigured(process.env.GITHUB_WEBHOOK_SECRET) ? (
            <Badge status="published">configured</Badge>
          ) : (
            <>
              <Badge status="down">disabled</Badge>{" "}
              <span className="text-slate-500 dark:text-slate-400">GITHUB_WEBHOOK_SECRET not set</span>
            </>
          )}
        </li>
        <li>Email provider: {envConfigured(process.env.EMAIL_PROVIDER_API_KEY) ? <Badge status="published">configured</Badge> : <Badge status="not_configured">in-app only</Badge>}</li>
        <li>AI provider: {aiConfigured() ? <Badge status="published">configured</Badge> : <Badge status="not_configured">not configured</Badge>}</li>
        <li>
          TestSprite GitHub App: <Badge status="not_configured">external</Badge>{" "}
          <span className="text-slate-500 dark:text-slate-400">posts its own PR comment and check — managed in the <a href="https://docs.testsprite.com/web-portal/integrations/github-integration" target="_blank" rel="noreferrer" className="underline">TestSprite portal</a></span>
        </li>
        <li>
          DevSentinel GitHub App:{" "}
          {githubAppConfigured() ? (
            <Badge status="published">configured</Badge>
          ) : (
            <>
              <Badge status="not_configured">not configured</Badge>{" "}
              <span className="text-slate-500 dark:text-slate-400">add a project token or GITHUB_APP_* keys — docs/github-app-setup.md</span>
            </>
          )}
        </li>
      </ul>
    </Card>
  );
}

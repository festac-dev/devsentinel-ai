import { notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, SectionTitle, EmptyState, Time, SourceBadge } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import {
  updateProjectAction, deleteProjectAction, connectRepoAction,
  saveTestspriteKeyAction, verifyTestspriteAction, disconnectRepoAction,
} from "@/app/actions/projects";
import { testspriteProvider } from "@/modules/testsprite/provider";
import { githubConnectEnabled, githubConnectMissing, listInstallationRepos } from "@/modules/github/install";
import { ownedInstallationIds } from "@/modules/github/ownership";
import { PendingButton } from "@/components/pending-button";
import { RepoPicker } from "./repo-picker";

const GITHUB_FLASH: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "GitHub App connected — DevSentinel can now publish commit statuses for this repository." },
  linked: { tone: "ok", text: "GitHub account connected. Pick one of your repositories below." },
  no_installation: { tone: "warn", text: "No GitHub App installation was found for your GitHub account. Install the App on a repository, then try again." },
  pending: { tone: "warn", text: "Installation requested. The org owner must approve it on GitHub, then click Connect GitHub again." },
  wrong_repo: { tone: "warn", text: "The App can't access this repository yet. Add it in the App's settings on GitHub, then click Connect GitHub again." },
  invalid_state: { tone: "warn", text: "The installation link expired or isn't for this account. Please try again." },
  no_repository: { tone: "warn", text: "Connect a repository before installing the GitHub App." },
  not_available: { tone: "warn", text: "GitHub sign-in isn't fully set up on this server (see the notice below)." },
  error: { tone: "warn", text: "The GitHub App installation couldn't be completed. Please try again." },
};

export const dynamic = "force-dynamic";

function inputCls() {
  return "w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";
}

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ github?: string }> }) {
  const { id } = await params;
  const { github } = await searchParams;
  const flash = github ? GITHUB_FLASH[github] : undefined;
  const connectEnabled = githubConnectEnabled();
  const user = await getSessionUser();
  if (!user) notFound();
  const project = await prisma.project.findFirst({ where: { id: id, ownerId: user.id }, include: { repository: true } });
  if (!project) notFound();

  const [tsConfig, recentRuns, targets] = await Promise.all([
    testspriteProvider.checkConfiguration(project.id),
    prisma.testRun.findMany({ where: { projectId: project.id }, orderBy: { queuedAt: "desc" }, take: 5, include: { pr: true } }),
    prisma.monitoringTarget.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const tsIntegration = await prisma.projectIntegration.findUnique({
    where: { projectId_kind: { projectId: project.id, kind: "testsprite" } },
  });

  // Corrupt/legacy plan-step rows must not take the whole page (and the form
  // that would fix them) down with a JSON.parse throw.
  let planStepsText = "";
  if (project.testPlanSteps) {
    try {
      planStepsText = (JSON.parse(project.testPlanSteps) as Array<{ type: string; description: string }>)
        .map((s) => `${s.type === "assertion" ? "assert:" : ""}${s.description}`)
        .join("\n");
    } catch {
      planStepsText = "";
    }
  }

  const ghToken = await prisma.projectIntegration.findUnique({
    where: { projectId_kind: { projectId: project.id, kind: "github_token" } },
  });

  // Repositories come ONLY from installations this account proved access to (never from every
  // installation of the App), and only when there is a repo to pick and GitHub sign-in is set up.
  const ownedIds = connectEnabled ? await ownedInstallationIds(user.id) : [];
  const availableRepos = !project.repository && connectEnabled && ownedIds.length > 0 ? await listInstallationRepos(ownedIds) : null;
  const pickableRepos = availableRepos?.ok ? availableRepos.repos : [];
  const connectMissing = connectEnabled ? [] : githubConnectMissing();
  const connectBtn = "inline-block rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200";

  // Setup checklist: the whole page boils down to these five things.
  const publishingReady = Boolean(ghToken || project.repository?.installationId);
  const steps = [
    { done: Boolean(project.repository), label: "Connect your GitHub repository", href: "#repository" },
    { done: publishingReady, label: "Let DevSentinel post results on your pull requests (connect GitHub)", href: "#repository" },
    { done: Boolean(tsIntegration), label: "Save your TestSprite API key", href: "#testsprite" },
    { done: Boolean(project.testspriteProjectId), label: "Pick your TestSprite project (click Verify to fill it in for you)", href: "#testsprite" },
    { done: Boolean(project.testTargetUrl), label: "Set the URL of your deployed app", href: "#settings" },
  ];
  const doneCount = steps.filter((x) => x.done).length;

  const manualForm = (
    <FormShell action={connectRepoAction} submitLabel="Connect repository">
      <div className="grid gap-3 sm:grid-cols-3">
        <input name="projectId" type="hidden" value={project.id} />
        <input name="owner" required placeholder="owner (e.g. octocat)" aria-label="Repository owner" className={inputCls()} />
        <input name="repo" required placeholder="repository name" aria-label="Repository name" className={inputCls()} />
        <input name="defaultBranch" placeholder="default branch (main)" aria-label="Default branch" className={inputCls()} />
      </div>
      <input name="githubToken" type="password" placeholder="GitHub token for commit statuses (optional, write-only)" aria-label="GitHub token" className={inputCls()} />
    </FormShell>
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          {project.description && <p className="text-slate-500 dark:text-slate-400">{project.description}</p>}
        </div>
        <Link href="/app/projects" className="text-sm underline">← All projects</Link>
      </div>

      <section aria-labelledby="setup-title">
        <Card>
          <p id="setup-title" className="font-medium mb-2">
            {doneCount === steps.length ? "All set" : `Setup: ${doneCount} of ${steps.length} done`}
          </p>
          {doneCount === steps.length ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Open or update a pull request on {project.repository?.owner}/{project.repository?.repo} and DevSentinel will test it automatically.
            </p>
          ) : (
            <ol className="space-y-1 text-sm">
              {steps.map((st) => (
                <li key={st.label} className="flex gap-2">
                  <span aria-hidden="true">{st.done ? "✅" : "⬜"}</span>
                  <a href={st.href} className={st.done ? "text-slate-500 dark:text-slate-400 line-through" : "underline"}>{st.label}</a>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>

      <section id="repository">
        <SectionTitle>Repository</SectionTitle>
        {flash && (
          <div role="status" className={`mb-3 rounded-lg border px-4 py-3 text-sm ${flash.tone === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"}`}>
            {flash.text}
          </div>
        )}
        {!project.repository ? (
          <Card>
            {pickableRepos.length > 0 ? (
              <>
                <RepoPicker projectId={project.id} repos={pickableRepos} />
                <p className="mt-3 text-sm">
                  <a href={`/api/github/install?projectId=${project.id}&mode=install`} className="underline">Install the App on another GitHub account</a>
                </p>
                <details className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-4">
                  <summary className="text-sm text-slate-500 dark:text-slate-400 cursor-pointer">Connect by name instead</summary>
                  <div className="mt-3">{manualForm}</div>
                </details>
              </>
            ) : (
              <>
                {connectEnabled ? (
                  <div className="mb-4 space-y-2">
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {ownedIds.length === 0
                        ? "Connect your GitHub account to pick from your own repositories. Other accounts never see them."
                        : availableRepos && !availableRepos.ok
                          ? `Couldn't load your repositories from GitHub${availableRepos.detail ? ` (${availableRepos.detail})` : ""}. Try Connect GitHub again.`
                          : "No repositories found on your GitHub App installation — add one in the App's settings on GitHub, or connect by name below."}
                    </p>
                    <a href={`/api/github/install?projectId=${project.id}`} className={connectBtn}>Connect GitHub</a>
                  </div>
                ) : (
                  <p className="text-sm text-amber-800 dark:text-amber-300 mb-3">
                    GitHub sign-in isn&apos;t configured on this server{connectMissing.length > 0 ? ` (missing: ${connectMissing.join(", ")})` : ""}. Until it is, connect by name with a token that has push access to the repository.
                  </p>
                )}
                <details open={!connectEnabled} className="border-t border-slate-200 dark:border-slate-800 pt-3">
                  <summary className="text-sm text-slate-500 dark:text-slate-400 cursor-pointer">Connect by name instead</summary>
                  <div className="mt-3">{manualForm}</div>
                </details>
              </>
            )}
          </Card>
        ) : (
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">
                  <a href={`https://github.com/${project.repository.owner}/${project.repository.repo}`} target="_blank" rel="noreferrer" className="underline">
                    {project.repository.owner}/{project.repository.repo}
                  </a>
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Default branch: {project.repository.defaultBranch} · Connected <Time date={project.repository.connectedAt} />
                </p>
                <p className="text-sm mt-1">
                  Status publishing: {ghToken ? <Badge status="published">token set (••••{ghToken.last4})</Badge> : project.repository.installationId ? <Badge status="published">GitHub App installed</Badge> : <Badge status="not_configured">not configured</Badge>}
                </p>
                {connectEnabled && !project.repository.installationId && (
                  <p className="mt-2">
                    <a href={`/api/github/install?projectId=${project.id}`} className={connectBtn}>Connect GitHub</a>
                  </p>
                )}
              </div>
              <form action={disconnectRepoAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <PendingButton label="Disconnect repository" pendingLabel="Disconnecting…"
                  className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
              </form>
            </div>
          </Card>
        )}
      </section>

      <section id="testsprite">
        <SectionTitle>TestSprite integration</SectionTitle>
        <Card>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Badge status={tsConfig.state}>{tsConfig.state}</Badge>
            <span className="text-sm text-slate-500 dark:text-slate-400">{tsConfig.message}</span>
          </div>
          <FormShell action={saveTestspriteKeyAction} submitLabel="Save API key">
            <input type="hidden" name="projectId" value={project.id} />
            <label htmlFor="apiKey" className="block text-sm font-medium mb-1">TestSprite API key <span className="font-normal text-slate-500 dark:text-slate-400">(write-only, encrypted)</span></label>
            <input id="apiKey" name="apiKey" type="password" placeholder={tsIntegration ? `Stored — ends ${tsIntegration.last4}. Paste a new key to replace.` : "sk-..."} className={inputCls()} />
          </FormShell>
          <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <FormShell action={verifyTestspriteAction} submitLabel="Verify credentials">
              <input type="hidden" name="projectId" value={project.id} />
              <p className="text-sm text-slate-500 dark:text-slate-400">Checks your key and fills in the project ID for you (result appears under the bell).</p>
            </FormShell>
          </div>
        </Card>
      </section>

      <section id="settings">
        <SectionTitle>Project settings</SectionTitle>
        <Card>
          <FormShell action={updateProjectAction} submitLabel="Save settings">
            <input type="hidden" name="projectId" value={project.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="name" className="block text-sm font-medium mb-1">Name</label>
                <input id="name" name="name" defaultValue={project.name} maxLength={100} className={inputCls()} />
              </div>
              <div>
                <label htmlFor="description" className="block text-sm font-medium mb-1">Description</label>
                <input id="description" name="description" defaultValue={project.description ?? ""} maxLength={500} className={inputCls()} />
              </div>
              <div>
                <label htmlFor="testTargetUrl" className="block text-sm font-medium mb-1">Deployed target URL TestSprite should test</label>
                <input id="testTargetUrl" name="testTargetUrl" type="url" defaultValue={project.testTargetUrl ?? ""} placeholder="https://staging.example.com" className={inputCls()} />
              </div>
            </div>
            <details className="border-t border-slate-200 dark:border-slate-800 pt-3">
              <summary className="text-sm font-medium cursor-pointer">Advanced</summary>
              <div className="mt-3 space-y-3">
                <div>
                  <label htmlFor="testspriteProjectId" className="block text-sm font-medium mb-1">TestSprite project ID <span className="font-normal text-slate-500 dark:text-slate-400">(filled in by Verify, or copy from your TestSprite dashboard)</span></label>
                  <input id="testspriteProjectId" name="testspriteProjectId" defaultValue={project.testspriteProjectId ?? ""} placeholder="proj_..." className={inputCls()} />
                </div>
                <div>
                  <label htmlFor="testPlanSteps" className="block text-sm font-medium mb-1">
                    Test plan steps <span className="font-normal text-slate-500 dark:text-slate-400">(one per line; prefix <code>assert:</code> for assertions — defaults to a smoke test)</span>
                  </label>
                  <textarea
                    id="testPlanSteps" name="testPlanSteps" rows={4}
                    placeholder={project.testPlanSteps ? undefined : "Open the deployed URL and wait for the page to finish loading\nassert: the page renders without an application error screen"}
                    defaultValue={planStepsText}
                    className={inputCls()} />
                </div>
                <fieldset className="text-sm">
                  <legend className="text-sm font-medium mb-1">Run triggers</legend>
                  <label className="mr-4"><input type="checkbox" name="runOnPrOpened" defaultChecked={project.runOnPrOpened} /> PR opened</label>
                  <label className="mr-4"><input type="checkbox" name="runOnPrSynchronize" defaultChecked={project.runOnPrSynchronize} /> New commits (synchronize)</label>
                  <label className="mr-4"><input type="checkbox" name="runOnPrReopened" defaultChecked={project.runOnPrReopened} /> PR reopened</label>
                  <label><input type="checkbox" name="incidentOnRunFail" defaultChecked={project.incidentOnRunFail} /> Open incident when a run fails on the current head</label>
                </fieldset>
              </div>
            </details>
          </FormShell>
        </Card>
      </section>

      <section>
        <SectionTitle action={<Link href="/app/monitoring" className="text-sm underline">Manage monitoring</Link>}>Monitoring targets</SectionTitle>
        {targets.length === 0 ? <EmptyState title="No monitoring targets for this project" /> : (
          <div className="space-y-2">
            {targets.map((t) => (
              <div key={t.id} className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 flex items-center justify-between gap-3">
                <div className="min-w-0"><p className="font-medium">{t.name}</p><p className="text-sm text-slate-500 dark:text-slate-400 truncate">{t.url}</p></div>
                <Badge status={t.currentState}>{t.currentState}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Recent runs in this project</SectionTitle>
        {recentRuns.length === 0 ? <EmptyState title="No test runs yet" /> : (
          <div className="space-y-2">
            {recentRuns.map((r) => (
              <Link key={r.id} href={`/app/runs/${r.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="font-mono text-xs">{r.commitSha.slice(0, 7)}</span>
                  <span>{r.trigger}{r.pr ? ` · PR #${r.pr.number}` : ""}</span>
                  <Badge status={r.status}>{r.status}</Badge>
                  <SourceBadge source={r.source} />
                  <Time date={r.queuedAt} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Danger zone</SectionTitle>
        <Card className="border-rose-300 dark:border-rose-900">
          <FormShell action={deleteProjectAction} submitLabel="Delete project permanently" danger>
            <input type="hidden" name="projectId" value={project.id} />
            <label htmlFor="confirm" className="block text-sm font-medium mb-1">
              Type the project name (<strong>{project.name}</strong>) exactly to confirm. This deletes the repository connection, all runs, incidents, and monitoring data.
            </label>
            <input id="confirm" name="confirm" required className={inputCls()} placeholder={project.name} />
          </FormShell>
        </Card>
      </section>
    </div>
  );
}

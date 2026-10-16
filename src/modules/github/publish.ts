/**
 * Publishes run results to GitHub as a commit status on the run's OWN SHA
 * (spec 9.4: never against HEAD of the branch). Before publishing, the PR's
 * current head SHA is re-read; a stale run is never allowed to publish for
 * the new head.
 */

import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { redact } from "@/lib/redact";
import { getInstallationToken, githubAppConfigured } from "@/modules/github/app-auth";

export type PublishOutcome = "published" | "failed" | "not_configured" | "skipped_stale";

const STATUS_STATE: Record<string, "success" | "failure" | "error" | "pending"> = {
  passed: "success",
  failed: "failure",
  error: "error",
  cancelled: "error",
  unknown: "pending",
  queued: "pending",
  running: "pending",
};

export async function publishRunStatus(runId: string): Promise<PublishOutcome> {
  const run = await prisma.testRun.findUnique({ where: { id: runId }, include: { pr: true, project: true } });
  if (!run || !run.pr) return "skipped_stale";

  // Re-read the current head SHA at publish time (not enqueue time).
  const pr = await prisma.pullRequest.findUnique({ where: { id: run.prId! } });
  if (!pr || pr.currentHeadSha !== run.commitSha) {
    await prisma.checkPublication.create({
      data: { runId, kind: "status", outcome: "skipped_stale", detail: "Run's commit is no longer the PR head; status not published." },
    });
    return "skipped_stale";
  }

  const connection = await prisma.repositoryConnection.findUnique({ where: { projectId: run.projectId } });
  const integration = connection
    ? await prisma.projectIntegration.findUnique({
        where: { projectId_kind: { projectId: run.projectId, kind: "github_token" } },
      })
    : null;

  if (!connection || connection.disabled || !process.env.ENCRYPTION_KEY) {
    await prisma.checkPublication.create({
      data: { runId, kind: "status", outcome: "not_configured", detail: "Repository not connected or ENCRYPTION_KEY missing; status not published." },
    });
    return "not_configured";
  }

  // Credential resolution order: per-project PAT, then the GitHub App
  // installation token (requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY and a
  // linked installation). Without either, publishing is honestly unconfigured.
  let token: string;
  if (integration) {
    try {
      token = decryptSecret(integration.cipher, integration.keyVersion);
    } catch {
      await recordFailure(runId, "Stored GitHub token could not be decrypted.");
      return "failed";
    }
  } else if (connection.installationId && githubAppConfigured()) {
    try {
      token = await getInstallationToken(connection.installationId);
    } catch (err) {
      await recordFailure(runId, redact(err instanceof Error ? err.message : String(err)).slice(0, 300));
      return "failed";
    }
  } else {
    const detail = connection.installationId
      ? "GitHub App is not configured on the server (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing)."
      : "No GitHub token or GitHub App installation configured for status publishing.";
    await prisma.checkPublication.create({
      data: { runId, kind: "status", outcome: "not_configured", detail },
    });
    return "not_configured";
  }

  const state = STATUS_STATE[run.status] ?? "pending";
  const description =
    run.status === "passed"
      ? "DevSentinel: TestSprite run passed"
      : run.status === "failed"
        ? "DevSentinel: TestSprite run failed"
        : `DevSentinel: run ${run.status}`;
  const base = process.env.APP_BASE_URL ?? "";

  try {
    const res = await fetch(
      `https://api.github.com/repos/${run.repoOwner}/${run.repoName}/statuses/${run.commitSha}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "devsentinel-ai",
        },
        body: JSON.stringify({
          state,
          target_url: base ? `${base}/app/runs/${run.id}` : undefined,
          description: redact(description).slice(0, 140),
          context: "devsentinel/testsprite",
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (res.ok) {
      const body = (await res.json()) as { id?: number };
      await prisma.checkPublication.create({
        data: { runId, kind: "status", outcome: "published", externalId: body.id ? String(body.id) : null },
      });
      return "published";
    }
    const detail = redact(await res.text()).slice(0, 300);
    await recordFailure(runId, `GitHub API responded ${res.status}: ${detail}`);
    return "failed";
  } catch (err) {
    await recordFailure(runId, redact(String(err)).slice(0, 300));
    return "failed";
  }
}

async function recordFailure(runId: string, detail: string) {
  await prisma.checkPublication.create({
    data: { runId, kind: "status", outcome: "failed", detail },
  });
}

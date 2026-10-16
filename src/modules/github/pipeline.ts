/**
 * GitHub PR event pipeline (spec 9.2): find the connected project, upsert the
 * PR + head SHA, create a run bound to the exact commit SHA, enqueue the test
 * job. Idempotent via delivery ID + natural key.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { isRunnablePrAction, splitFullName, type PrEventPayload } from "@/modules/github/webhook";
import { notify } from "@/modules/notifications/send";

export async function handlePrEvent(payload: PrEventPayload, deliveryId: string): Promise<{ processed: string }> {
  const split = splitFullName(payload.repository.full_name);
  if (!split) throw new Error(`Unparseable repository name: ${payload.repository.full_name}`);

  // GitHub's webhook payload carries canonical casing, but a connection may
  // have been stored with user-typed casing (GitHub names are case-insensitive).
  const connection = await prisma.repositoryConnection.findFirst({
    where: {
      owner: { equals: split.owner, mode: "insensitive" },
      repo: { equals: split.repo, mode: "insensitive" },
      disabled: false,
    },
    include: { project: true },
  });
  if (!connection) return { processed: "ignored: repository not connected to any project" };
  const project = connection.project;

  // Keep the PR record current (head SHA changes on synchronize / force-push).
  const pr = await prisma.pullRequest.upsert({
    where: {
      projectId_repoOwner_repoName_number: {
        projectId: project.id,
        repoOwner: split.owner,
        repoName: split.repo,
        number: payload.number,
      },
    },
    create: {
      projectId: project.id,
      repoOwner: split.owner,
      repoName: split.repo,
      number: payload.number,
      title: payload.pull_request.title ?? `PR #${payload.number}`,
      author: payload.pull_request.user?.login ?? null,
      sourceBranch: payload.pull_request.head.ref,
      targetBranch: payload.pull_request.base.ref,
      currentHeadSha: payload.pull_request.head.sha,
      state: payload.action === "closed" ? "closed" : "open",
    },
    update: {
      currentHeadSha: payload.pull_request.head.sha,
      title: payload.pull_request.title ?? undefined,
      state: payload.action === "closed" ? "closed" : "open",
    },
  });

  if (payload.action === "closed") {
    return { processed: "pr closed; no run started" };
  }

  if (!isRunnablePrAction(payload.action)) {
    return { processed: `ignored: action ${payload.action}` };
  }
  if (pr.state === "closed") return { processed: "ignored: PR is closed" };

  // Trigger rules from project settings.
  const ruleOk =
    (payload.action === "opened" && project.runOnPrOpened) ||
    (payload.action === "synchronize" && project.runOnPrSynchronize) ||
    (payload.action === "reopened" && project.runOnPrReopened) ||
    payload.action === "ready_for_review";
  if (!ruleOk) return { processed: `ignored: trigger disabled for action ${payload.action}` };

  const commitSha = payload.pull_request.head.sha;

  // Deduplicate per delivery: the idempotency key below includes the delivery
  // id, so a replayed delivery is a no-op — but a NEW delivery id (GitHub
  // redelivery, double-send) legitimately creates another run for the commit.
  const run = await prisma.testRun.create({
    data: {
      projectId: project.id,
      prId: pr.id,
      repoOwner: split.owner,
      repoName: split.repo,
      commitSha,
      trigger: "pull_request",
      source: "testsprite",
      status: "queued",
    },
  });

  await enqueue({
    type: "start_test_run",
    payload: { runId: run.id },
    idempotencyKey: `${connection.owner}/${connection.repo}#${payload.number}@${commitSha}:pull_request:${deliveryId}`,
  });

  return { processed: `run ${run.id} queued for commit ${commitSha.slice(0, 7)}` };
}

export async function notifyRunFinished(runId: string) {
  const run = await prisma.testRun.findUnique({ where: { id: runId }, include: { project: true, pr: true } });
  if (!run) return;
  if (run.status === "failed" && run.project.incidentOnRunFail) {
    await maybeCreateRunIncident(run);
  }
  const type = run.status === "passed" ? "test_run_completed" : run.status === "failed" ? "test_run_failed" : "test_run_error";
  await notify({
    projectId: run.projectId,
    type,
    title:
      run.status === "passed"
        ? `Test run passed on ${run.commitSha.slice(0, 7)}`
        : run.status === "failed"
          ? `Test run failed on ${run.commitSha.slice(0, 7)}`
          : `Test run ended as ${run.status} on ${run.commitSha.slice(0, 7)}`,
    body: run.errorMessage ?? run.statusReason ?? "Run finished.",
    entityRef: `run:${run.id}`,
    dedupKey: `run_finished:${run.id}:${run.status}`,
  });
}

async function maybeCreateRunIncident(
  run: { id: string; projectId: string; commitSha: string; prId: string | null; repoOwner: string; repoName: string }
) {
  const pr = run.prId ? await prisma.pullRequest.findUnique({ where: { id: run.prId } }) : null;
  // Only fails on the PR's current head (a stale failure does not open an incident).
  if (pr && pr.currentHeadSha !== run.commitSha) return;
  const fingerprint = `test_run:${run.projectId}:${run.repoOwner}/${run.repoName}:${pr?.number ?? "-"}:${run.commitSha.slice(0, 12)}`;
  const existing = await prisma.incident.findUnique({
    where: { projectId_fingerprint: { projectId: run.projectId, fingerprint } },
  });
  if (existing && existing.status !== "closed" && existing.status !== "resolved") {
    await prisma.incidentEvent.create({
      data: { incidentId: existing.id, actor: "system", type: "occurrence", note: `Run ${run.id} failed again on ${run.commitSha.slice(0, 7)}.` },
    });
    return;
  }
  if (existing) return; // already resolved/closed; do not reopen without a rule
  try {
    await prisma.incident.create({
      data: {
        projectId: run.projectId,
        title: `Test run failed on ${run.repoOwner}/${run.repoName}${pr ? ` #${pr.number}` : ""} (${run.commitSha.slice(0, 7)})`,
        severity: "high",
        status: "open",
        sourceType: "test_run",
        fingerprint,
        evidence: JSON.stringify([{ kind: "run", id: run.id, commitSha: run.commitSha }]),
        events: {
          create: {
            actor: "system",
            type: "opened",
            note: `Auto-opened from failed run ${run.id} on commit ${run.commitSha.slice(0, 7)}.`,
          },
        },
      },
    });
  } catch (err) {
    // Two concurrent failing runs of the same commit can both pass the lookup
    // above; the loser hits the unique (projectId, fingerprint) constraint and
    // must not corrupt the run's outcome with a provider exception.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    return;
  }
  await notify({
    projectId: run.projectId,
    type: "incident_opened",
    title: "Incident opened: test run failure",
    body: `A TestSprite run failed on ${run.commitSha.slice(0, 7)} and the project rule opened an incident.`,
    entityRef: `run:${run.id}`,
    dedupKey: `incident_opened:${fingerprint}`,
  });
}

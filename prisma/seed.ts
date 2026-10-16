/**
 * Representative demo data (prisma db seed). Idempotent: re-running fills in
 * whatever is missing and never duplicates or overwrites real records.
 *
 * The seeded runs use source "demo" so every surface that shows a source badge
 * labels them honestly as "Simulated demonstration" (see docs/demo-guide.md).
 * Includes a failed run bound to the PR's current head SHA plus the matching
 * incident, mirroring the production rule in src/modules/github/pipeline.ts.
 *
 * Usage: npm run db:seed   (requires DATABASE_URL; run migrations first)
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/crypto";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@devsentinel.example";
const DEMO_PASSWORD = "DemoPassw0rd";
const REPO_OWNER = "octocat";
const REPO_NAME = "sample-app";
const PR_NUMBER = 42;
const HEAD_SHA = "abc1230000000000000000000000000000000000"; // matches a "abc123" prefix search
const OLD_SHA = "1a2b3c0000000000000000000000000000000000";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function main() {
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: {
      email: DEMO_EMAIL,
      name: "Demo User",
      passwordHash: await hashPassword(DEMO_PASSWORD),
    },
  });

  let project = await prisma.project.findFirst({ where: { ownerId: user.id, name: "Sample App" } });
  if (!project) {
    project = await prisma.project.create({
      data: {
        name: "Sample App",
        description: "Demo project with representative runs and incidents.",
        ownerId: user.id,
        testTargetUrl: "https://sample-app.example.com",
      },
    });
  }

  await prisma.repositoryConnection.upsert({
    where: { projectId: project.id },
    update: {},
    create: {
      projectId: project.id,
      owner: REPO_OWNER,
      repo: REPO_NAME,
      defaultBranch: "main",
      monitoredBranch: "main",
    },
  });

  const pr = await prisma.pullRequest.upsert({
    where: {
      projectId_repoOwner_repoName_number: {
        projectId: project.id,
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        number: PR_NUMBER,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      number: PR_NUMBER,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      title: "Add checkout flow",
      author: "octocat",
      sourceBranch: "feature/checkout",
      targetBranch: "main",
      currentHeadSha: HEAD_SHA,
      state: "open",
    },
  });

  const existingRuns = await prisma.testRun.count({ where: { projectId: project.id } });
  if (existingRuns === 0) {
    const passedSummary = JSON.stringify({ total: 12, passed: 12, failed: 0, skipped: 0, durationSec: 95 });
    const failedSummary = JSON.stringify({ total: 12, passed: 10, failed: 2, skipped: 0, durationSec: 112 });

    await prisma.testRun.create({
      data: {
        projectId: project.id,
        prId: pr.id,
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        commitSha: OLD_SHA,
        trigger: "pull_request",
        source: "demo",
        status: "passed",
        summary: passedSummary,
        summaryText: "12/12 passed",
        queuedAt: minutesAgo(180),
        startedAt: minutesAgo(179),
        completedAt: minutesAgo(177),
      },
    });

    const failedRun = await prisma.testRun.create({
      data: {
        projectId: project.id,
        prId: pr.id,
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        commitSha: HEAD_SHA,
        trigger: "pull_request",
        source: "demo",
        status: "failed",
        summary: failedSummary,
        summaryText: "10/12 passed, 2 failed",
        failures: JSON.stringify([
          { name: "checkout: pay with saved card", message: "Expected confirmation screen, got error banner." },
          { name: "checkout: apply discount code", message: "Discount total did not update within 5s." },
        ]),
        errorMessage: "2 of 12 checks failed on commit abc1230.",
        queuedAt: minutesAgo(120),
        startedAt: minutesAgo(119),
        completedAt: minutesAgo(117),
      },
    });

    await prisma.testRun.create({
      data: {
        projectId: project.id,
        prId: pr.id,
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        commitSha: HEAD_SHA,
        trigger: "pull_request",
        source: "demo",
        status: "passed",
        summary: passedSummary,
        summaryText: "12/12 passed",
        queuedAt: minutesAgo(60),
        startedAt: minutesAgo(59),
        completedAt: minutesAgo(57),
      },
    });

    // Mirrors maybeCreateRunIncident(): the failed run is on the PR's current
    // head, so the project rule opens (or folds into) one incident.
    const fingerprint = `test_run:${project.id}:${REPO_OWNER}/${REPO_NAME}:${PR_NUMBER}:${HEAD_SHA.slice(0, 12)}`;
    await prisma.incident.upsert({
      where: { projectId_fingerprint: { projectId: project.id, fingerprint } },
      update: {},
      create: {
        projectId: project.id,
        title: `Test run failed on ${REPO_OWNER}/${REPO_NAME} #${PR_NUMBER} (${HEAD_SHA.slice(0, 7)})`,
        severity: "high",
        status: "open",
        sourceType: "test_run",
        fingerprint,
        evidence: JSON.stringify([{ kind: "run", id: failedRun.id, commitSha: HEAD_SHA }]),
        events: {
          create: {
            actor: "system",
            type: "opened",
            note: `Auto-opened from failed run ${failedRun.id} on commit ${HEAD_SHA.slice(0, 7)}.`,
          },
        },
      },
    });
  }

  console.log(`Seeded demo data: user ${DEMO_EMAIL}, project "Sample App", PR #${PR_NUMBER}.`);
  if (existingRuns === 0) console.log("Created 3 demo runs (passed/failed/passed) and 1 linked incident.");
  else console.log(`Project already has ${existingRuns} runs; run/incident seeding skipped.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

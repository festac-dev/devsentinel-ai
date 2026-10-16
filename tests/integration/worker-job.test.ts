/**
 * Worker job consumption against the MOCK TestSprite CLI fixture (spec 20:
 * "full PR→run→result flow against mocks") — labeled mocked: no real TestSprite
 * execution happens here. Verifies that:
 *   - the webhook pipeline (what the endpoint calls) enqueues and returns fast
 *     without doing the provider work, and
 *   - the worker claims the job, runs the fake provider, and completes the run
 *     with a commit-bound result, then enqueues the status publication.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "./helpers/testdb";
import { FAKE_TESTSPRITE_CLI } from "./helpers/fake-cli";

type Db = typeof import("@/lib/db");
type Pipeline = typeof import("@/modules/github/pipeline");
type Loop = typeof import("@/worker/loop");
type Crypto = typeof import("@/lib/crypto");

let db: Db;
let pipeline: Pipeline;
let loop: Loop;
let crypto: Crypto;

beforeAll(async () => {
  prepareTestDatabase();
  process.env.TESTSPRITE_CLI_PATH = FAKE_TESTSPRITE_CLI;
  db = await import("@/lib/db");
  pipeline = await import("@/modules/github/pipeline");
  loop = await import("@/worker/loop");
  crypto = await import("@/lib/crypto");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

async function seedProject(name: string, testspriteProjectId: string) {
  const user = await db.prisma.user.create({ data: { email: `${name}@example.com`, passwordHash: "x", name } });
  const project = await db.prisma.project.create({
    data: { name: `P-${name}`, ownerId: user.id, testspriteProjectId, testTargetUrl: "https://app-under-test.example" },
  });
  const { cipher, keyVersion } = crypto.encryptSecret("ts_live_mock_key_0123456789");
  await db.prisma.projectIntegration.create({
    data: { projectId: project.id, kind: "testsprite", cipher, keyVersion, last4: "6789" },
  });
  return project;
}

describe("webhook pipeline enqueues without doing the work", () => {
  it("returns fast, queues exactly one job, and leaves the run queued", async () => {
    const project = await seedProject("fast", "proj_fast");
    await db.prisma.repositoryConnection.create({
      data: { projectId: project.id, owner: "octocat", repo: "fast-repo" },
    });

    const payload = {
      action: "opened",
      number: 7,
      repository: { full_name: "octocat/fast-repo", name: "fast-repo", owner: { login: "octocat" } },
      pull_request: {
        head: { sha: "a".repeat(40), ref: "feature" },
        base: { ref: "main" },
        title: "Fast enqueue",
        user: { login: "octocat" },
      },
    };

    const started = Date.now();
    const result = await pipeline.handlePrEvent(payload, `delivery-fast-${Date.now()}`);
    const elapsedMs = Date.now() - started;

    expect(result.processed).toMatch(/queued/);
    expect(elapsedMs).toBeLessThan(2000); // enqueue-and-ack contract; no provider work inline

    const run = await db.prisma.testRun.findFirst({ where: { projectId: project.id } });
    expect(run!.status).toBe("queued");
    expect(run!.commitSha).toBe("a".repeat(40));

    const jobs = await db.prisma.job.findMany({ where: { type: "start_test_run", status: "queued" } });
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ runId: run!.id });
  });
});

describe("worker consumes and completes a job (mocked provider)", () => {
  it("passes a project through the fake CLI to a passed, commit-bound run", async () => {
    const project = await seedProject("pass", "proj_pass");
    const run = await db.prisma.testRun.create({
      data: { projectId: project.id, repoOwner: "o", repoName: "r", commitSha: "b".repeat(40), trigger: "manual", source: "testsprite" },
    });
    await db.prisma.job.create({ data: { type: "start_test_run", payload: JSON.stringify({ runId: run.id }) } });

    await loop.tick(5);

    const finished = await db.prisma.testRun.findUnique({ where: { id: run.id } });
    expect(finished!.status, `statusReason: ${finished!.statusReason}`).toBe("passed");
    expect(finished!.externalTestId).toBe("ts_mock_1");
    // The create envelope carries counts in stepSummary; no one-line summary text.
    expect(finished!.summaryText).toBeNull();
    const summary = JSON.parse(finished!.summary!);
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    // Created test id is persisted for reuse on reruns.
    expect((await db.prisma.project.findUnique({ where: { id: project.id } }))!.testspriteTestId).toBe("ts_mock_1");
    // Publication enqueued for the worker pipeline.
    const publish = await db.prisma.job.findFirst({ where: { type: "publish_github_status", idempotencyKey: `publish:${run.id}` } });
    expect(publish).not.toBeNull();
  });

  it("records a real failing result (no fabrication) for a failing provider run", async () => {
    const project = await seedProject("fail", "fail-proj");
    const run = await db.prisma.testRun.create({
      data: { projectId: project.id, repoOwner: "o", repoName: "r", commitSha: "c".repeat(40), trigger: "manual", source: "testsprite" },
    });
    await db.prisma.job.create({ data: { type: "start_test_run", payload: JSON.stringify({ runId: run.id }) } });

    await loop.tick(5);

    const finished = await db.prisma.testRun.findUnique({ where: { id: run.id } });
    expect(finished!.status, `statusReason: ${finished!.statusReason}`).toBe("failed");
    expect(finished!.statusReason).toContain("run failure:");
    const summary = JSON.parse(finished!.summary!);
    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });

  it("requeues a job with backoff when the run id does not exist", async () => {
    await db.prisma.job.create({ data: { type: "start_test_run", payload: JSON.stringify({ runId: "no-such-run" }) } });
    await loop.tick(5);
    const job = await db.prisma.job.findFirst({ where: { type: "start_test_run", payload: { contains: "no-such-run" } } });
    expect(job!.status).toBe("queued"); // attempts < maxAttempts: requeued with backoff
    expect(job!.attempts).toBe(1);
    expect(job!.lastError).toContain("not found");
    expect(job!.runAfter!.getTime()).toBeGreaterThan(Date.now());
  });
});

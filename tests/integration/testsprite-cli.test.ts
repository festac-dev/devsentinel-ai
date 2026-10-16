/**
 * TestSprite integration against the REAL official CLI.
 *
 * Unlike the E2E mock fixture (fake-testsprite.cjs, a hand-written stand-in for
 * the whole CLI), this suite runs the actual `@testsprite/testsprite-cli`
 * package the worker resolves in production (node_modules/.bin/testsprite) —
 * its argument handling, HTTP client, response schemas, long-poll loop and
 * exit codes are all genuine. Only the TestSprite *backend* is replaced: a
 * local stub of the documented `/api/cli/v1` endpoints (TESTSPRITE_API_URL),
 * with response bodies matching the CLI's own validated wire shapes (verified
 * live against the real api.testsprite.com error paths and the CLI's bundled
 * response schemas). The provider is driven through its production invocation
 * path (runCli → interpret, verifyCredentials, startRun), so wire-shape drift
 * between the app and the pinned CLI fails here instead of in production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { prepareTestDatabase } from "./helpers/testdb";

type Provider = typeof import("@/modules/testsprite/provider");
type Db = typeof import("@/lib/db");
type Crypto = typeof import("@/lib/crypto");

const API_KEY = "sk-user-stub-integration-key";
const PROJECT_ID = "proj_stub_1";
const TEST_ID = "test_stub_1";
const RUN_ID = "run_stub_1";

let providerMod: Provider;
let db: Db;
let crypto: Crypto;
let server: Server;
let baseUrl = "";
/** Scenario for the next run poll: which terminal status (or never). */
let runOutcome: "passed" | "failed" | "never-terminal" = "passed";
let pollsBeforeTerminal = 1;
const seen: Array<{ method: string; path: string; apiKey?: string }> = [];

const now = () => new Date().toISOString();

/** Full RunResponse — required fields mirror the CLI's RUN_RESPONSE_SCHEMA (userId/source/stepSummary). */
function runResponse(status: "running" | "passed" | "failed") {
  const failed = status === "failed";
  return {
    runId: RUN_ID,
    testId: TEST_ID,
    testTitle: null,
    projectId: PROJECT_ID,
    userId: "user_stub_1",
    status,
    source: "cli",
    createdAt: now(),
    startedAt: status === "running" ? null : now(),
    finishedAt: status === "running" ? null : now(),
    codeVersion: "v1",
    targetUrl: "https://app-under-test.example",
    createdFrom: null,
    failedStepIndex: failed ? 1 : null,
    failureKind: failed ? "assertion" : null,
    error: failed ? "Expected the cart badge to show 1 item, found 0" : null,
    videoUrl: null,
    stepSummary: { total: 2, completed: 2, passedCount: failed ? 1 : 2, failedCount: failed ? 1 : 0 },
  };
}

async function startStub(): Promise<{ url: string }> {
  const { createServer } = await import("node:http");
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://stub");
      const path = u.pathname.replace(/^\/api\/cli\/v1/, "");
      seen.push({ method: req.method ?? "", path, apiKey: (req.headers["x-api-key"] as string) ?? undefined });
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // Observed live from api.testsprite.com for an invalid key (401 → CLI exit 3).
      if (req.headers["x-api-key"] !== API_KEY) {
        return json(401, {
          error: {
            code: "AUTH_INVALID",
            message: "API key is invalid or revoked.",
            nextAction: "Generate a new one at https://www.testsprite.com/dashboard/settings/apikey.",
            requestId: "req_stub",
            details: {},
          },
        });
      }
      if (req.method === "GET" && path === "/projects") {
        return json(200, {
          items: [{ id: PROJECT_ID, name: "Stub Project", type: "frontend", createdFrom: "portal", createdAt: now(), updatedAt: now() }],
          nextToken: null,
        });
      }
      if (req.method === "GET" && /^\/projects\/[^/]+\/env$/.test(path)) {
        return json(200, {
          environments: [
            { id: "env_stub_1", name: "default", url: "https://app-under-test.example", isDefault: true, authMode: "public", hasCredentials: false, username: null, enableOtp: false, isTemporary: false, updatedAt: now() },
          ],
        });
      }
      if (req.method === "GET" && path.startsWith("/tests?")) {
        return json(200, { items: [], nextToken: null });
      }
      if (req.method === "POST" && path === "/tests") {
        const parsed = body ? (JSON.parse(body) as { projectId?: string }) : {};
        return json(200, {
          testId: TEST_ID,
          projectId: parsed.projectId ?? PROJECT_ID,
          type: "frontend",
          codeVersion: "v1",
          createdAt: now(),
          planSteps: [],
          dashboardUrl: null,
        });
      }
      if (req.method === "POST" && /^\/tests\/[^/]+\/runs$/.test(path)) {
        return json(200, { runId: RUN_ID, status: "queued", enqueuedAt: now(), codeVersion: "v1", targetUrl: "https://app-under-test.example" });
      }
      if (req.method === "GET" && path.startsWith("/runs/")) {
        const waitSeconds = Number(u.searchParams.get("waitSeconds") ?? 0);
        const respond = () => {
          let status: "running" | "passed" | "failed";
          if (runOutcome === "never-terminal") {
            status = "running";
          } else if (pollsBeforeTerminal > 0) {
            pollsBeforeTerminal -= 1;
            status = "running";
          } else {
            status = runOutcome;
          }
          json(200, runResponse(status));
        };
        // Honor the long-poll contract, bounded for test speed.
        setTimeout(respond, Math.min(waitSeconds, 1000));
        return;
      }
      if (req.method === "GET" && /^\/tests\/[^/]+\/result$/.test(path)) {
        const failed = runOutcome === "failed";
        return json(200, {
          testId: TEST_ID,
          status: failed ? "failed" : "passed",
          verdict: failed ? "failed" : "passed",
          executionStatus: "completed",
          startedAt: now(),
          finishedAt: now(),
          videoUrl: null,
          failureAnalysisUrl: null,
          runIdIfAvailable: RUN_ID,
          summary: failed ? "Failed (assertion) on step 1" : "2 checks executed",
        });
      }
      json(200, {}); // best-effort surfaces (telemetry, advisories) must not fail the flow
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  server = srv;
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("stub server address");
  return { url: `http://127.0.0.1:${addr.port}` };
}

async function seedProject(name: string, apiKey: string) {
  const user = await db.prisma.user.create({ data: { email: `${name}@example.com`, passwordHash: "x", name } });
  const project = await db.prisma.project.create({
    data: { name: `P-${name}`, ownerId: user.id, testspriteProjectId: PROJECT_ID, testTargetUrl: "https://app-under-test.example" },
  });
  const { cipher, keyVersion } = crypto.encryptSecret(apiKey);
  await db.prisma.projectIntegration.create({
    data: { projectId: project.id, kind: "testsprite", cipher, keyVersion, last4: apiKey.slice(-4) },
  });
  return project;
}

beforeAll(async () => {
  prepareTestDatabase();
  // Pin the REAL CLI: remove any E2E mock override so the provider resolves
  // the official package (node_modules/.bin/testsprite) exactly as production does.
  delete process.env.TESTSPRITE_CLI_PATH;
  const { fileURLToPath } = await import("node:url");
  process.env.TESTSPRITE_CLI_PATH = fileURLToPath(new URL("../../node_modules/.bin/testsprite", import.meta.url));
  providerMod = await import("@/modules/testsprite/provider");
  db = await import("@/lib/db");
  crypto = await import("@/lib/crypto");
  ({ url: baseUrl } = await startStub());
  process.env.TESTSPRITE_API_URL = baseUrl;
});

afterAll(async () => {
  delete process.env.TESTSPRITE_API_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.prisma?.$disconnect();
});

describe("real TestSprite CLI against a stub backend", () => {
  it("verifyCredentials accepts a valid key via the documented Page shape", async () => {
    const project = await seedProject("cli-ok", API_KEY);
    const result = await providerMod.testspriteProvider.verifyCredentials(project.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1 project(s) visible");
    expect(result.projects).toEqual([{ id: PROJECT_ID, name: "Stub Project" }]);
    // The decrypted stored key must reach the CLI and be sent as x-api-key.
    expect(seen.some((s) => s.method === "GET" && s.path === "/projects" && s.apiKey === API_KEY)).toBe(true);
  });

  it("verifyCredentials reports the real auth error for an invalid key", async () => {
    const project = await seedProject("cli-bad", "sk-user-wrong-key");
    const result = await providerMod.testspriteProvider.verifyCredentials(project.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("exit 3");
    expect(result.message).toContain("AUTH_INVALID");
  });

  it("startRun (first run: test create --run --wait) returns a passed result with real envelope facts", async () => {
    runOutcome = "passed";
    pollsBeforeTerminal = 1;
    const project = await seedProject("cli-run", API_KEY);
    const result = await providerMod.testspriteProvider.startRun({
      projectId: project.id,
      testName: "PR #1 check — integration",
      timeoutSeconds: 120,
    });
    expect(result.status).toBe("passed");
    expect(result.externalTestId).toBe(TEST_ID);
    expect(result.externalRunId).toBe(RUN_ID);
    expect(result.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    // The provider used the documented merged envelope path: create, trigger,
    // then long-poll. The created test id is persisted for later reruns.
    expect(seen.some((s) => s.method === "POST" && s.path === "/tests")).toBe(true);
    expect(seen.some((s) => s.method === "POST" && s.path === `/tests/${TEST_ID}/runs`)).toBe(true);
    expect(await db.prisma.project.findUnique({ where: { id: project.id } })).toMatchObject({ testspriteTestId: TEST_ID });
  });

  it("startRun (stored test id: test run --wait) maps a failed run to failed with the run's own failure text", async () => {
    runOutcome = "failed";
    pollsBeforeTerminal = 0;
    const project = await seedProject("cli-fail", API_KEY);
    await db.prisma.project.update({ where: { id: project.id }, data: { testspriteTestId: TEST_ID } });
    const result = await providerMod.testspriteProvider.startRun({
      projectId: project.id,
      testName: "PR #2 check — integration",
      timeoutSeconds: 120,
    });
    expect(result.status).toBe("failed");
    expect(result.statusReason).toContain("run failure: Expected the cart badge to show 1 item, found 0");
    expect(result.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
  });

  it("honors the CLI's own poll deadline: exit 7 becomes an error, never a non-terminal status", async () => {
    runOutcome = "never-terminal";
    const project = await seedProject("cli-timeout", API_KEY);
    await db.prisma.project.update({ where: { id: project.id }, data: { testspriteTestId: TEST_ID } });
    // Drive runCli (the provider's own invocation) with a tiny CLI-side
    // deadline; the provider's spawn budget stays generous.
    const res = await providerMod.runCli(["test", "run", TEST_ID, "--wait", "--timeout", "2", "--output", "json"], API_KEY, 60);
    expect(res.code).toBe(7);
    const result = providerMod.interpret(res.stdout, res.code, res.stdout + `\n${res.stderr}`, res.timedOut, res.stderr);
    expect(result.status).toBe("error");
    expect(result.statusReason).toContain("Timed out after 2s waiting for run");
    expect(result.externalRunId).toBe(RUN_ID);
  }, 30_000);

  it("getRunResults maps the flat CliLatestResult shape (summary as a string)", async () => {
    runOutcome = "passed";
    const project = await seedProject("cli-result", API_KEY);
    await db.prisma.project.update({ where: { id: project.id }, data: { testspriteTestId: TEST_ID } });
    const result = await providerMod.testspriteProvider.getRunResults(TEST_ID);
    expect(result.status).toBe("passed");
    expect(result.externalRunId).toBe(RUN_ID);
    expect(result.summaryText).toBe("2 checks executed");
  });
});

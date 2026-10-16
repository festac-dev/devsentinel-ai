#!/usr/bin/env node
/**
 * MOCK TestSprite CLI for end-to-end tests (spec 20: "Playwright, full PR→run→
 * result flow against mocks"). Emits the REAL CLI's wire shapes (verified
 * against @testsprite/testsprite-cli@0.14.0 source: the merged
 * `{ ...createResponse, run: <RunResponse> }` envelope, `stepSummary` counts,
 * the `{ items, nextToken }` Page shape) so the mock cannot drift from
 * production. Selected by TESTSPRITE_CLI_PATH; never used in production.
 * A project id beginning with "fail-" simulates a failing run (exit 1),
 * everything else passes (exit 0).
 */
const args = process.argv.slice(2);

if (args.includes("project") && args.includes("list")) {
  console.log(JSON.stringify({ items: [{ id: "proj_mock_1", name: "mock" }], nextToken: null }));
  process.exit(0);
}
if (args.includes("test") && args.includes("result")) {
  // `test result --output json`: flat CliLatestResult (summary is a string;
  // the CLI replaced the former count object with it).
  console.log(JSON.stringify({
    testId: "ts_mock_1",
    status: "passed",
    verdict: "passed",
    executionStatus: "completed",
    startedAt: new Date().toISOString(),
    finishedAt: new Date(Date.now() + 1000).toISOString(),
    runIdIfAvailable: "run_mock_1",
    summary: "2 checks executed",
  }));
  process.exit(0);
}

const projectIdx = args.indexOf("--project");
const projectId = projectIdx >= 0 ? args[projectIdx + 1] : "";
const now = new Date();
const done = new Date(now.getTime() + 1000);
const passed = !projectId.startsWith("fail-");
// `test create --run --wait --output json`: merged envelope — the create
// response's own fields at the top level, the final RunResponse under `run`.
console.log(JSON.stringify({
  testId: "ts_mock_1",
  projectId: projectId || "proj_mock_1",
  type: "frontend",
  codeVersion: "v1",
  createdAt: now.toISOString(),
  run: {
    runId: "run_mock_1",
    testId: "ts_mock_1",
    projectId: projectId || "proj_mock_1",
    status: passed ? "passed" : "failed",
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    finishedAt: done.toISOString(),
    failedStepIndex: passed ? null : 1,
    failureKind: passed ? null : "assertion",
    error: passed ? null : "Expected the cart badge to show 1 item, found 0",
    stepSummary: { total: 2, completed: 2, passedCount: passed ? 2 : 1, failedCount: passed ? 0 : 1 },
  },
}));
process.exit(passed ? 0 : 1);

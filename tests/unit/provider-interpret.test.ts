import { describe, it, expect } from "vitest";
import { interpret } from "@/../src/modules/testsprite/provider";

/**
 * Tests the mapping of raw CLI stdout/exit codes to honest run statuses.
 * "interpret" is exported for exactly this purpose (mocked CLI).
 */
describe("TestSprite CLI output interpretation", () => {
  it("maps a passing result JSON", () => {
    const out = JSON.stringify({ testId: "test_1", status: "passed", runIdIfAvailable: "run_1", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:00Z" });
    const r = interpret(out, 0, out, false);
    expect(r.status).toBe("passed");
    expect(r.externalTestId).toBe("test_1");
    expect(r.externalRunId).toBe("run_1");
    expect(r.summary?.durationSec).toBe(60);
  });

  it("maps failed with stats", () => {
    const out = JSON.stringify({ testId: "t", status: "failed", stats: { total: 4, passed: 3, failed: 1, blocked: 0 } });
    const r = interpret(out, 1, out, false);
    expect(r.status).toBe("failed");
    expect(r.summary?.failed).toBe(1);
  });

  it("maps the REAL merged create envelope (test create --run --wait --output json)", () => {
    // Exact shape emitted by @testsprite/testsprite-cli: the create response's
    // own fields at the top level, the final RunResponse under `run`, counts in
    // stepSummary — there is no top-level status/runId/stats.
    const merged = JSON.stringify({
      testId: "test_abc123",
      projectId: "proj_8f0f6",
      type: "frontend",
      codeVersion: "v1",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: {
        runId: "run_9f2",
        testId: "test_abc123",
        projectId: "proj_8f0f6",
        status: "passed",
        createdAt: "2026-01-01T00:00:05.000Z",
        startedAt: "2026-01-01T00:00:06.000Z",
        finishedAt: "2026-01-01T00:01:06.000Z",
        failedStepIndex: null,
        failureKind: null,
        error: null,
        stepSummary: { total: 2, completed: 2, passedCount: 2, failedCount: 0 },
      },
    });
    const r = interpret(merged, 0, merged, false);
    expect(r.status).toBe("passed");
    expect(r.externalTestId).toBe("test_abc123");
    expect(r.externalRunId).toBe("run_9f2");
    expect(r.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(r.summary?.durationSec).toBe(60);
  });

  it("maps a failed run inside the merged envelope to failed with the real failure text, never provider error", () => {
    const merged = JSON.stringify({
      testId: "test_abc123",
      projectId: "proj_8f0f6",
      run: {
        runId: "run_bad",
        status: "failed",
        error: "Expected the cart badge to show 1 item, found 0",
        stepSummary: { total: 2, completed: 2, passedCount: 1, failedCount: 1 },
      },
    });
    const r = interpret(merged, 1, merged, false);
    expect(r.status).toBe("failed");
    expect(r.statusReason).toContain("Expected the cart badge to show 1 item");
    expect(r.statusReason).not.toContain("provider error");
    expect(r.summary?.failed).toBe(1);
  });

  it("maps a failed flat RunResponse (test run --wait stdout) to failed, not provider error", () => {
    // RunResponse.error is a raw STRING — the run's own failure text.
    const run = JSON.stringify({
      runId: "run_flat",
      testId: "t1",
      projectId: "p1",
      status: "failed",
      error: "assertion failed at step 2",
      stepSummary: { total: 3, completed: 3, passedCount: 2, failedCount: 1 },
    });
    const r = interpret(run, 1, run, false);
    expect(r.status).toBe("failed");
    expect(r.statusReason).toContain("assertion failed at step 2");
    expect(r.summary?.passed).toBe(2);
  });

  it("survives a malformed nested run object without throwing, keeping the raw output", () => {
    // A `run` that passes the outer record parse but violates the nested
    // schema must not throw past interpret; the honest fallback is unknown
    // with the raw output attached (never a thrown ZodError / discarded CLI output).
    const merged = JSON.stringify({
      testId: "test_abc123",
      projectId: "proj_8f0f6",
      run: { status: "passed", startedAt: 123, stats: "n/a" },
    });
    const r = interpret(merged, 0, merged, false);
    expect(r.status).not.toBe("passed");
    expect(r.output).toContain("startedAt");
  });

  it("treats a stderr ApiError envelope as a provider error with the real message", () => {
    const stdout = "";
    const stderr = JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "apiKey must be a TestSprite API key beginning with sk-user-", nextAction: "Set a valid key" } });
    const r = interpret(stdout, 5, `${stdout}\n${stderr}`, false, stderr);
    expect(r.status).toBe("error");
    expect(r.statusReason).toContain("VALIDATION_ERROR");
    expect(r.statusReason).toContain("sk-user-");
  });

  it("prefers the stdout run envelope when stderr also carries JSON", () => {
    const run = JSON.stringify({ runId: "run_ok", testId: "t", status: "passed", stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 } });
    const stderr = JSON.stringify({ error: { code: "RATE_LIMITED", message: "throttled" } });
    const r = interpret(run, 0, `${run}\n${stderr}`, false, stderr);
    expect(r.status).toBe("passed");
    expect(r.externalRunId).toBe("run_ok");
  });

  it("treats unparseable output with exit 0 as unknown, never passed", () => {
    const r = interpret("this is not json", 0, "this is not json", false);
    expect(r.status).toBe("unknown");
    expect(r.statusReason).toContain("unparseable");
  });

  it("maps provider error envelopes to error status with the real message", () => {
    const out = JSON.stringify({ error: { code: "AUTH_ERROR", message: "Invalid API key" } });
    const r = interpret(out, 3, out, false);
    expect(r.status).toBe("error");
    expect(r.statusReason).toContain("Invalid API key");
  });

  it("maps a timeout honestly", () => {
    const r = interpret("", 0, "", true);
    expect(r.status).toBe("error");
    expect(r.statusReason).toContain("timeout");
  });

  it("maps exit 7 (timeout) to error, never passed", () => {
    const r = interpret("", 7, "Timed out after 600s", false);
    expect(r.status).toBe("error");
  });

  it("maps a poll-timeout exit 7 to error even when stdout carries the last non-terminal poll row", () => {
    // Observed live from @testsprite/testsprite-cli@0.14.0: when its own poll
    // deadline hits, the CLI prints the LAST poll row (status "running") to
    // stdout and exits 7 with the timeout envelope on stderr. Fields below are
    // the RunResponse shape the row can carry; the exit code — not the
    // non-terminal status — is the truthful signal: a finished invocation that
    // never reached a terminal state is an Error, never "running" (a stranded
    // non-terminal run would never resolve).
    const stdout = JSON.stringify({
      runId: "run_live_1",
      testId: "test_live_1",
      projectId: "proj_live",
      status: "running",
      enqueuedAt: "2026-10-16T10:59:17.971Z",
      codeVersion: "v1",
      targetUrl: "https://app-under-test.example",
    });
    const stderr = JSON.stringify({
      error: {
        code: "UNSUPPORTED",
        message: "Timed out after 2s waiting for run run_live_1. Run run_live_1 is still executing on the server and will keep running (and billing) until it finishes.",
        nextAction: "Resume polling: testsprite test wait run_live_1, or cancel it: testsprite test cancel run_live_1",
        requestId: "local",
        details: { runId: "run_live_1", timeoutSeconds: 2 },
      },
    });
    const r = interpret(stdout, 7, `${stdout}\n${stderr}`, false, stderr);
    expect(r.status).toBe("error");
    expect(r.statusReason).toContain("Timed out after 2s waiting for run run_live_1");
    // The run id is a real fact from the poll row — keep it so the user can
    // follow the CLI's own resume/cancel advice.
    expect(r.externalRunId).toBe("run_live_1");
    expect(r.externalTestId).toBe("test_live_1");
  });

  it("maps a poll-timeout inside the merged create envelope to error, never running", () => {
    // Same exit-7 path via `test create --run --wait`: the merged envelope's
    // nested `run` still holds the non-terminal poll row.
    const stdout = JSON.stringify({
      testId: "test_new_1",
      projectId: "proj_live",
      type: "frontend",
      createdAt: "2026-10-16T11:00:00.000Z",
      run: { runId: "run_new_1", testId: "test_new_1", projectId: "proj_live", status: "running" },
    });
    const stderr = JSON.stringify({ error: { code: "UNSUPPORTED", message: "Timed out after 600s waiting for run run_new_1." } });
    const r = interpret(stdout, 7, `${stdout}\n${stderr}`, false, stderr);
    expect(r.status).toBe("error");
    expect(r.statusReason).toContain("Timed out after 600s");
    expect(r.externalTestId).toBe("test_new_1");
    expect(r.externalRunId).toBe("run_new_1");
  });

  it("redacts secrets appearing in CLI output", () => {
    const out = `run failed; api_key=sk-live-supersecret123`;
    const r = interpret(out, 1, out, false);
    expect(r.output).not.toContain("supersecret123");
  });
});

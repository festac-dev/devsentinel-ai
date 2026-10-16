/**
 * TestSprite integration adapter (spec 8).
 *
 * The only verified programmatic interface available to this app is the
 * official TestSprite CLI (@testsprite/testsprite-cli). This module
 * implements TestExecutionProvider strictly against the CLI's documented
 * behavior (see docs/testsprite-integration.md):
 *   - authentication via the TESTSPRITE_API_KEY environment variable
 *   - `test create --plan-from <file> --run --wait --output json`
 *     (emits the merged `{ ...createResponse, run: <RunResponse> }` envelope)
 *   - `test run <test-id> --wait --output json` (flat RunResponse)
 *   - `test result <test-id> --output json` (flat CliLatestResult)
 *   - `test cancel <run-id>` / documented exit codes
 *
 * Capabilities TestSprite does not document are reported as unsupported.
 * Nothing here fabricates results: unparseable output becomes an Error run
 * with the real (redacted) message.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { redact, truncateOutput } from "@/lib/redact";
import { mapProviderStatus, type RunStatus } from "@/modules/runs/status";

export const TESTSPRITE_SOURCE = "testsprite" as const;
export const MAX_WAIT_SECONDS = 900;

export type ConfigState = "configured" | "unconfigured" | "error";

export type ProviderConfigCheck = {
  state: ConfigState;
  message: string;
  cliPath?: string;
};

export type StartRunInput = {
  projectId: string;
  testName: string;
  timeoutSeconds?: number;
};

export type ProviderRunResult = {
  status: RunStatus;
  statusReason?: string;
  externalTestId?: string;
  externalRunId?: string;
  summary?: { total?: number; passed?: number; failed?: number; skipped?: number; blocked?: number; durationSec?: number };
  summaryText?: string;
  output: string;
  outputTruncated: boolean;
};

export type TestExecutionProvider = {
  readonly name: string;
  checkConfiguration(projectId: string): Promise<ProviderConfigCheck>;
  verifyCredentials(projectId: string): Promise<{ ok: boolean; message: string; projects?: Array<{ id: string; name?: string }> }>;
  startRun(input: StartRunInput): Promise<ProviderRunResult>;
  getRunResults(externalTestId: string): Promise<ProviderRunResult>;
  cancelRun(externalRunId: string): Promise<{ supported: true; ok: boolean; message: string }>;
};

// ---- helpers ----

export function resolveCliPath(): string | null {
  if (process.env.TESTSPRITE_CLI_PATH && existsSync(process.env.TESTSPRITE_CLI_PATH)) {
    return process.env.TESTSPRITE_CLI_PATH;
  }
  const local = join(process.cwd(), "node_modules", ".bin", "testsprite");
  if (existsSync(local)) return local;
  return "testsprite"; // rely on PATH
}

const MIN_RUNNABLE = 60;

/** Spawn the CLI (exported for the real-CLI integration test; same invocation path as production). */
export async function runCli(
  args: string[],
  apiKey: string,
  timeoutSeconds: number
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const cli = resolveCliPath();
  if (!cli) return { code: 127, stdout: "", stderr: "testsprite CLI not found", timedOut: false };
  return new Promise((resolve) => {
    // A .js/.cjs/.mjs CLI (the mock fixture) is run through Node so it works
    // without an executable bit (git on Android/Windows checkouts drops it).
    // The real CLI is a bin shim with a shebang and is spawned directly.
    const isScript = /\.[cm]?js$/i.test(cli);
    const child = spawn(/*turbopackIgnore: true*/ isScript ? process.execPath : cli, isScript ? [cli, ...args] : args, {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: apiKey,
        TESTSPRITE_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Keep only the tail so a chatty CLI cannot exhaust worker memory, without
    // discarding the final result envelope that interpret() parses.
    const MAX_CAPTURE = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-MAX_CAPTURE)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-MAX_CAPTURE)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      resolve({ code: 127, stdout, stderr, timedOut });
    });
  });
}

/** Parse the CLI's JSON result envelope (defensive; result shapes documented in docs/testsprite-integration.md). */
const ResultSchema = z.object({
  testId: z.string().optional(),
  status: z.string().nullish(),
  verdict: z.string().nullish(),
  executionStatus: z.string().nullish(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  runId: z.string().nullish(),
  runIdIfAvailable: z.string().nullish(),
  summary: z.string().nullish(),
  // RunResponse carries per-run counts in stepSummary (the CLI has no `stats`
  // field anywhere); kept nullish so older shapes still parse.
  stepSummary: z
    .object({
      total: z.number().nullish(),
      completed: z.number().nullish(),
      passedCount: z.number().nullish(),
      failedCount: z.number().nullish(),
    })
    .nullish(),
  stats: z
    .object({
      total: z.number().nullish(),
      passed: z.number().nullish(),
      failed: z.number().nullish(),
      blocked: z.number().nullish(),
      running: z.number().nullish(),
      cancelled: z.number().nullish(),
    })
    .nullish(),
  error: z
    .object({ code: z.string().nullish(), message: z.string().nullish(), nextAction: z.string().nullish() })
    .nullish()
    .or(z.string().nullish()),
  // `test create --run --wait --output json` emits the merged envelope
  // `{ ...createResponse, run: <RunResponse> }` — the run's status/counts live
  // nested under `run`, never at the top level.
  run: z.record(z.string(), z.unknown()).nullish(),
});

/** Extract the last JSON object embedded in CLI output (stderr noise may precede it). */
function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Map raw CLI stdout + exit code to an honest run result. Exported for unit tests. */
export function interpret(
  stdout: string,
  exitCode: number,
  rawOutput: string,
  timedOut: boolean,
  stderrText = ""
): ProviderRunResult {
  const { text, truncated } = truncateOutput(redact(rawOutput.slice(0, 512 * 1024)));
  const base: ProviderRunResult = { status: "unknown", output: text, outputTruncated: truncated };

  if (timedOut) {
    return { ...base, status: "error", statusReason: "timeout: CLI did not finish within the wait budget" };
  }

  // Parse priority: stdout first (the run envelope — flat RunResponse or the
  // merged create envelope), then stderr (the ApiError envelope a failed
  // command prints there in JSON mode), then a JSON object embedded in the
  // combined output. A run that finished owns stdout; an operation that failed
  // owns stderr.
  const parsedJson = (() => {
    for (const candidate of [stdout, stderrText]) {
      try {
        return ResultSchema.parse(JSON.parse(candidate));
      } catch {
        // try the next candidate
      }
    }
    const extracted = extractJsonObject(rawOutput);
    if (extracted === null) return null;
    try {
      return ResultSchema.parse(extracted);
    } catch {
      return null;
    }
  })();

  // Provider error envelope: `error` as an OBJECT with a code (ApiError JSON).
  // A plain-string `error` is the RunResponse's raw failure text for a
  // failed/blocked run — the run's own failure message, never a provider error.
  const topError = parsedJson?.error;
  if (topError && typeof topError !== "string") {
    const err = [topError.code, topError.message, topError.nextAction]
      .filter(Boolean)
      .join(" — ") || "unknown error";
    return { ...base, status: "error", statusReason: `provider error: ${redact(err).slice(0, 500)}` };
  }

  if (!parsedJson) {
    // exit 0 without parseable JSON is still not trustworthy as "passed"
    if (exitCode === 0) {
      return { ...base, status: "unknown", statusReason: "CLI exited 0 but returned unparseable output; result unavailable" };
    }
    const { status, reason } = mapExitReason(exitCode, rawOutput);
    return { ...base, status, statusReason: reason };
  }

  // Merged create envelope: run facts (status, runId, counts, error) are nested
  // under `run`; the create response's own testId stays at the top level. A
  // nested object that violates the schema must not throw past this function —
  // fall back to the top-level envelope so the raw output stays attached.
  const runParsed = parsedJson.run ? ResultSchema.safeParse(parsedJson.run) : null;
  const runFields = runParsed?.success ? runParsed.data : parsedJson;

  const runId = runFields.runId ?? runFields.runIdIfAvailable ?? undefined;
  const mapped = mapProviderStatus(runFields.status ?? runFields.verdict ?? runFields.executionStatus);
  // A `--wait` invocation that ends WITHOUT a terminal status never finished:
  // when the CLI's own poll deadline hits (exit 7) it prints the last
  // non-terminal poll row to stdout (verified live against
  // @testsprite/testsprite-cli@0.14.0). The exit code is the truthful signal —
  // report Error, never queued/running: the job would otherwise finalize a run
  // that no mechanism will ever recheck.
  if ((mapped === "queued" || mapped === "running") && exitCode !== 0) {
    const envelope = extractJsonObject(stderrText) as
      | { error?: { code?: string; message?: string; nextAction?: string } }
      | null;
    const detail =
      envelope?.error && typeof envelope.error !== "string"
        ? [envelope.error.code, envelope.error.message, envelope.error.nextAction].filter(Boolean).join(" — ")
        : "";
    const { reason } = mapExitReason(exitCode, rawOutput);
    return {
      ...base,
      status: "error",
      statusReason: detail
        ? `provider error: ${redact(detail).slice(0, 500)}`
        : reason || "CLI wait ended without a terminal status",
      externalTestId: parsedJson.testId ?? runFields.testId,
      externalRunId: runId,
    };
  }
  // A failed/blocked run's real failure text (RunResponse.error string) —
  // recorded as the run's failure reason, never converted into a provider error.
  const runFailureText =
    typeof runFields.error === "string" && runFields.error.trim() ? runFields.error : undefined;
  // Per-run counts: the CLI's RunResponse carries them in `stepSummary`
  // (passedCount/failedCount); tolerate a legacy `stats` shape too.
  const stepSummary = runFields.stepSummary ?? undefined;
  const stats = runFields.stats ?? undefined;
  const durationSec =
    runFields.startedAt && runFields.finishedAt
      ? Math.max(0, Math.round((new Date(runFields.finishedAt).getTime() - new Date(runFields.startedAt).getTime()) / 1000))
      : undefined;

  return {
    ...base,
    status: mapped,
    statusReason: runFailureText
      ? `run failure: ${redact(runFailureText).slice(0, 500)}`
      : undefined,
    externalTestId: parsedJson.testId ?? runFields.testId,
    externalRunId: runId,
    summary: stepSummary
      ? {
          total: stepSummary.total ?? undefined,
          passed: stepSummary.passedCount ?? undefined,
          failed: stepSummary.failedCount ?? undefined,
          skipped: 0,
          durationSec,
        }
      : stats
        ? {
            total: stats.total ?? undefined,
            passed: stats.passed ?? undefined,
            failed: stats.failed ?? undefined,
            blocked: stats.blocked ?? undefined,
            skipped: 0,
            durationSec,
          }
        : durationSec !== undefined
          ? { durationSec }
          : undefined,
    summaryText: runFields.summary ?? undefined,
  };
}

function mapExitReason(exitCode: number, rawOutput: string): { status: RunStatus; reason: string } {
  const tail = redact(rawOutput.split("\n").filter(Boolean).slice(-3).join(" ")).slice(0, 300);
  switch (exitCode) {
    case 0:
      return { status: "passed", reason: "" };
    case 1:
      return { status: "failed", reason: "run reported failure" };
    case 7:
      return { status: "error", reason: `timeout waiting for the provider run ${tail}` };
    case 3:
      return { status: "error", reason: `authentication or missing scope (exit 3) ${tail}` };
    case 4:
      return { status: "error", reason: `not found (exit 4) ${tail}` };
    case 5:
      return { status: "error", reason: `validation error (exit 5) ${tail}` };
    case 10:
      return { status: "error", reason: `TestSprite service unavailable (exit 10) ${tail}` };
    case 11:
      return { status: "error", reason: `rate limited (exit 11) ${tail}` };
    case 12:
      return { status: "error", reason: `insufficient credits (exit 12) ${tail}` };
    case 13:
      return { status: "error", reason: `feature gated (exit 13) ${tail}` };
    default:
      return { status: "error", reason: `CLI exited with code ${exitCode} ${tail}` };
  }
}

function buildPlanFile(projectName: string, testName: string, steps: Array<{ type: string; description: string }>, projectId: string): { dir: string; file: string } {
  // The plan file gets its own mkdtemp directory; cleanup removes exactly that
  // directory (never a computed parent of an arbitrary path).
  const dir = mkdtempSync(join(tmpdir(), "devsentinel-plan-"));
  const file = join(dir, "plan.json");
  writeFileSync(
    file,
    JSON.stringify({
      projectId,
      type: "frontend",
      name: testName.slice(0, 120),
      description: `DevSentinel automated check for project ${projectName}`,
      priority: "p0",
      planSteps: steps,
    }),
    "utf8"
  );
  return { dir, file };
}

export function defaultPlanSteps(): Array<{ type: string; description: string }> {
  return [
    { type: "action", description: "Open the project's deployed URL and wait for the page to finish loading" },
    { type: "assertion", description: "Verify the page renders without an application error screen" },
  ];
}

async function loadApiKey(projectId: string): Promise<{ apiKey?: string; problem?: string }> {
  const integration = await prisma.projectIntegration.findUnique({
    where: { projectId_kind: { projectId, kind: "testsprite" } },
  });
  if (!integration) return { problem: "TestSprite API key not configured for this project." };
  if (!process.env.ENCRYPTION_KEY) {
    return { problem: "ENCRYPTION_KEY is not configured on the server; stored credentials cannot be decrypted." };
  }
  try {
    return { apiKey: decryptSecret(integration.cipher, integration.keyVersion) };
  } catch {
    return { problem: "Stored TestSprite credential could not be decrypted (key mismatch or corruption)." };
  }
}

// ---- implementation ----

export const testspriteProvider: TestExecutionProvider = {
  name: "testsprite-cli",

  async checkConfiguration(projectId): Promise<ProviderConfigCheck> {
    const cli = resolveCliPath();
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return { state: "error", message: "Project not found." };
    if (!project.testspriteProjectId) {
      return { state: "unconfigured", message: "TestSprite project ID not set. Click “Verify TestSprite credentials” to fill it in automatically, or paste it from your TestSprite dashboard.", cliPath: cli ?? undefined };
    }
    const { problem } = await loadApiKey(projectId);
    if (problem) return { state: "unconfigured", message: problem, cliPath: cli ?? undefined };
    if (!project.testTargetUrl) {
      return { state: "unconfigured", message: "No target URL configured — TestSprite frontend tests need the URL of the deployed app under test.", cliPath: cli ?? undefined };
    }
    return { state: "configured", message: "TestSprite API key, project ID, and target URL are set.", cliPath: cli ?? undefined };
  },

  async verifyCredentials(projectId) {
    const { apiKey, problem } = await loadApiKey(projectId);
    if (!apiKey) return { ok: false, message: problem ?? "not configured" };
    const res = await runCli(["project", "list", "--output", "json"], apiKey, 30);
    if (res.timedOut) return { ok: false, message: "Verification timed out." };
    if (res.code === 0) {
      try {
        // The CLI's list endpoints return its documented Page shape
        // `{ items: [...], nextToken }` (OpenAPI ProjectList), not `{ projects }`.
        const parsed = JSON.parse(res.stdout) as { items?: unknown[]; projects?: unknown[] };
        const rows = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.projects) ? parsed.projects : undefined;
        const count = rows === undefined ? undefined : rows.length;
        const projects = (rows ?? []).flatMap((r) => {
          const o = (r ?? {}) as { id?: unknown; projectId?: unknown; name?: unknown };
          const id = typeof o.id === "string" ? o.id : typeof o.projectId === "string" ? o.projectId : undefined;
          return id ? [{ id, name: typeof o.name === "string" ? o.name : undefined }] : [];
        });
        const listed = projects.slice(0, 5).map((p) => (p.name ? `${p.name} (${p.id})` : p.id)).join("; ");
        return {
          ok: true,
          message: count === undefined ? "API key accepted." : `API key accepted (${count} project(s) visible).${listed ? ` Your projects: ${listed}.` : ""}`,
          projects,
        };
      } catch {
        return { ok: false, message: "CLI exited 0 but returned unparseable output; cannot confirm verification." };
      }
    }
    const combined = `${res.stderr}\n${res.stdout}`;
    let detail = "";
    const extracted = extractJsonObject(combined) as
      | { error?: { code?: string; message?: string; nextAction?: string } }
      | null;
    if (extracted?.error) {
      detail = [extracted.error.code, extracted.error.message, extracted.error.nextAction]
        .filter(Boolean)
        .join(" — ");
    }
    if (!detail) {
      detail = combined.split("\n").filter(Boolean).slice(-2).join(" ");
    }
    return { ok: false, message: `Verification failed (exit ${res.code}): ${redact(detail).slice(0, 300) || "no detail returned"}` };
  },

  async startRun(input): Promise<ProviderRunResult> {
    const project = await prisma.project.findUnique({ where: { id: input.projectId } });
    if (!project) throw new Error("Project not found.");
    const { apiKey, problem } = await loadApiKey(input.projectId);
    if (!apiKey) {
      return {
        status: "error",
        statusReason: problem ?? "TestSprite not configured.",
        output: problem ?? "TestSprite not configured.",
        outputTruncated: false,
      };
    }
    if (!project.testspriteProjectId) {
      const msg = "TestSprite project ID not configured for this project.";
      return { status: "error", statusReason: msg, output: msg, outputTruncated: false };
    }

    const timeoutSeconds = Math.min(Math.max(input.timeoutSeconds ?? 600, MIN_RUNNABLE), MAX_WAIT_SECONDS);
    let plan: { dir: string; file: string } | null = null;

    try {
      if (project.testspriteTestId) {
        // Re-run the project's stored test against the current environment.
        const res = await runCli(
          ["test", "run", project.testspriteTestId, "--wait", "--timeout", String(timeoutSeconds), "--output", "json"],
          apiKey,
          timeoutSeconds + 120
        );
        return interpret(res.stdout, res.code, res.stdout + (res.stderr ? `\n${res.stderr}` : ""), res.timedOut, res.stderr);
      }

      let steps = defaultPlanSteps();
      if (project.testPlanSteps) {
        try {
          const parsed = z.array(z.object({ type: z.enum(["action", "assertion"]), description: z.string().min(1) })).parse(JSON.parse(project.testPlanSteps));
          if (parsed.length > 0) steps = parsed;
        } catch {
          // fall back to default steps; recorded in output below
        }
      }
      plan = buildPlanFile(project.name, input.testName, steps, project.testspriteProjectId);
      const res = await runCli(
        [
          "test", "create",
          "--project", project.testspriteProjectId,
          "--plan-from", plan.file,
          "--run", "--wait",
          "--timeout", String(timeoutSeconds),
          "--output", "json",
        ],
        apiKey,
        timeoutSeconds + 120
      );
      const result = interpret(res.stdout, res.code, res.stdout + (res.stderr ? `\n${res.stderr}` : ""), res.timedOut, res.stderr);
      // Persist the created test id so future runs reuse it.
      if (result.externalTestId) {
        await prisma.project.update({
          where: { id: project.id },
          data: { testspriteTestId: result.externalTestId },
        });
      }
      return result;
    } finally {
      if (plan) {
        try {
          rmSync(plan.dir, { recursive: true, force: true });
        } catch {
          // best effort cleanup
        }
      }
    }
  },

  async getRunResults(externalTestId) {
    const firstProject = await prisma.project.findFirst({
      where: { testspriteTestId: externalTestId },
      select: { id: true },
    });
    let apiKey: string | undefined;
    if (firstProject) {
      const loaded = await loadApiKey(firstProject.id);
      apiKey = loaded.apiKey;
      if (!apiKey) {
        return { status: "error", statusReason: loaded.problem, output: loaded.problem ?? "", outputTruncated: false };
      }
    }
    if (!apiKey) {
      return { status: "unknown", statusReason: "No API key available to fetch results.", output: "", outputTruncated: false };
    }
    const res = await runCli(["test", "result", externalTestId, "--output", "json"], apiKey, 60);
    return interpret(res.stdout, res.code, res.stdout, res.timedOut, res.stderr);
  },

  async cancelRun(externalRunId) {
    // Documented: `test cancel <run-id>` (see docs/testsprite-integration.md).
    return { supported: true, ok: false, message: `Cancellation of ${externalRunId} requires the API key context of the owning run; trigger from the run detail page after configuring credentials.` };
  },
};

export function testspriteConfigSummary(projectId: string) {
  return testspriteProvider.checkConfiguration(projectId);
}

/**
 * Run status model (spec 8.4): the ONLY display statuses, mapped strictly from
 * actual provider execution state. Queued/accepted is never "passed".
 */

export const RUN_STATUSES = ["queued", "running", "passed", "failed", "cancelled", "error", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_SOURCES = ["testsprite", "local", "demo"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

const ILLEGAL = new Set<string>([
  // terminal states cannot move back to queued/running
  "passed->queued", "passed->running",
  "failed->queued", "failed->running",
  "cancelled->queued", "cancelled->running",
  "error->queued", "error->running",
]);

export function isTransitionLegal(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  return !ILLEGAL.has(`${from}->${to}`);
}

/** Map the TestSprite CLI run status strings to our display statuses. */
export function mapProviderStatus(providerStatus: string | undefined | null): RunStatus {
  switch ((providerStatus ?? "").toLowerCase()) {
    case "queued":
    case "created":
    case "pending":
      return "queued";
    case "running":
    case "in_progress":
    case "executing":
      return "running";
    case "passed":
    case "success":
      return "passed";
    case "failed":
      return "failed";
    case "blocked":
    case "skipped":
      return "unknown";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Map CLI exit codes (docs: DOCUMENTATION.md "Exit codes") to status + reason. */
export function mapCliExitCode(exitCode: number): { status: RunStatus; reason: string } {
  if (exitCode === 0) return { status: "passed", reason: "" };
  if (exitCode === 1) return { status: "failed", reason: "run reported failure" };
  if (exitCode === 7) return { status: "error", reason: "timeout waiting for the provider run" };
  if (exitCode === 3) return { status: "error", reason: "authentication or missing scope (exit 3)" };
  if (exitCode === 10) return { status: "error", reason: "TestSprite service unavailable (exit 10)" };
  if (exitCode === 11) return { status: "error", reason: "rate limited by TestSprite (exit 11)" };
  if (exitCode === 12) return { status: "error", reason: "insufficient credits (exit 12)" };
  if (exitCode === 13) return { status: "error", reason: "feature gated for this plan (exit 13)" };
  return { status: "error", reason: `CLI exited with code ${exitCode}` };
}

/**
 * Staleness (spec 9.4): a run is stale when its bound SHA differs from the
 * PR's current head SHA. Runs without a PR are never stale.
 */
export function isStale(run: { prId: string | null; commitSha: string }, pr: { currentHeadSha: string } | null): boolean {
  if (!run.prId || !pr) return false;
  return run.commitSha !== pr.currentHeadSha;
}

export function stalenessTooltip(run: { commitSha: string }, pr: { currentHeadSha: string }): string {
  const short = (s: string) => s.slice(0, 7);
  return `Tested commit ${short(run.commitSha)}; current head is ${short(pr.currentHeadSha)}`;
}

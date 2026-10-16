import { describe, it, expect } from "vitest";
import {
  isTransitionLegal,
  mapProviderStatus,
  mapCliExitCode,
  isStale,
  stalenessTooltip,
} from "@/modules/runs/status";

describe("run status transitions", () => {
  it("allows legal transitions", () => {
    expect(isTransitionLegal("queued", "running")).toBe(true);
    expect(isTransitionLegal("running", "passed")).toBe(true);
    expect(isTransitionLegal("running", "failed")).toBe(true);
    expect(isTransitionLegal("queued", "error")).toBe(true);
    expect(isTransitionLegal("passed", "passed")).toBe(true);
  });

  it("rejects illegal transitions (terminal states cannot restart)", () => {
    expect(isTransitionLegal("passed", "queued")).toBe(false);
    expect(isTransitionLegal("passed", "running")).toBe(false);
    expect(isTransitionLegal("failed", "running")).toBe(false);
    expect(isTransitionLegal("error", "queued")).toBe(false);
    expect(isTransitionLegal("cancelled", "running")).toBe(false);
  });
});

describe("provider status mapping", () => {
  it("maps documented provider statuses", () => {
    expect(mapProviderStatus("queued")).toBe("queued");
    expect(mapProviderStatus("running")).toBe("running");
    expect(mapProviderStatus("passed")).toBe("passed");
    expect(mapProviderStatus("success")).toBe("passed");
    expect(mapProviderStatus("failed")).toBe("failed");
    expect(mapProviderStatus("cancelled")).toBe("cancelled");
    expect(mapProviderStatus("blocked")).toBe("unknown");
  });

  it("never fabricates: unknown provider strings map to unknown", () => {
    expect(mapProviderStatus("wat")).toBe("unknown");
    expect(mapProviderStatus(undefined)).toBe("unknown");
    expect(mapProviderStatus(null)).toBe("unknown");
  });
});

describe("CLI exit code mapping", () => {
  it("maps documented exit codes to honest statuses", () => {
    expect(mapCliExitCode(0).status).toBe("passed");
    expect(mapCliExitCode(1).status).toBe("failed");
    expect(mapCliExitCode(7).status).toBe("error"); // timeout is never passed
    expect(mapCliExitCode(3).status).toBe("error");
    expect(mapCliExitCode(10).status).toBe("error");
    expect(mapCliExitCode(12).status).toBe("error");
    expect(mapCliExitCode(99).status).toBe("error");
  });
});

describe("staleness", () => {
  const run = { prId: "pr1", commitSha: "a".repeat(40) };
  it("marks runs stale when the PR head moved", () => {
    expect(isStale(run, { currentHeadSha: "b".repeat(40) })).toBe(true);
    expect(isStale(run, { currentHeadSha: "a".repeat(40) })).toBe(false);
  });
  it("runs without a PR are never stale", () => {
    expect(isStale({ prId: null, commitSha: "a" }, null)).toBe(false);
  });
  it("tooltip names both SHAs", () => {
    const tip = stalenessTooltip(run, { currentHeadSha: "b".repeat(40) });
    expect(tip).toContain("aaaaaaa");
    expect(tip).toContain("bbbbbbb");
  });
});

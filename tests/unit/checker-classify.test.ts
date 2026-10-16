/**
 * Monitoring check error classification (pure function). A connection reset is
 * a hard failure, not a timeout: recording it as "timeout" fabricates a
 * response time equal to the full configured timeout and hides the real class.
 */
import { describe, expect, it } from "vitest";
import { classifyCheckError } from "@/modules/monitoring/checker";

function err(code?: string, message = "boom"): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(message);
  if (code) e.code = code;
  return e;
}

describe("classifyCheckError", () => {
  it("classifies inactivity timeouts as timeout with the configured duration", () => {
    const r = classifyCheckError(err("ETIMEDOUT"), 30);
    expect(r).toMatchObject({ outcome: "timeout", errorClass: "timeout", responseTimeMs: 30_000 });
    const r2 = classifyCheckError(err(undefined, "timeout"), 10);
    expect(r2).toMatchObject({ outcome: "timeout", errorClass: "timeout" });
  });

  it("classifies connection resets as a hard error, not a fabricated timeout", () => {
    for (const code of ["ECONNRESET", "ECONNABORTED", "EPIPE"]) {
      const r = classifyCheckError(err(code), 30);
      expect(r).toMatchObject({ outcome: "error", errorClass: "connection_reset" });
      expect(r.responseTimeMs).toBeUndefined();
    }
  });

  it("keeps the SSRF and body-cap classes", () => {
    expect(classifyCheckError(err("EHOSTFORBIDDEN"), 30)).toMatchObject({ outcome: "error", errorClass: "ssrf_blocked" });
    expect(classifyCheckError(err(undefined, "body-too-large"), 30)).toMatchObject({ outcome: "error", errorClass: "body_too_large" });
  });

  it("falls back to the errno code or network_error", () => {
    expect(classifyCheckError(err("ENOTFOUND"), 30)).toMatchObject({ outcome: "error", errorClass: "ENOTFOUND" });
    expect(classifyCheckError(err(undefined), 30)).toMatchObject({ outcome: "error", errorClass: "network_error" });
  });
});

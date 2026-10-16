import { describe, it, expect } from "vitest";
import { redact, truncateOutput } from "@/lib/redact";

describe("redact()", () => {
  it("redacts TestSprite-style API keys", () => {
    expect(redact("key=sk-live-abcdef1234567890")).not.toContain("abcdef1234567890");
  });

  it("redacts GitHub tokens", () => {
    expect(redact("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(redact("github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890")).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890");
  });

  it("redacts authorization headers", () => {
    expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).not.toContain("eyJhbGciOiJIUzI1NiIs");
  });

  it("redacts key=value secrets", () => {
    expect(redact('password: "hunter2hunter"')).not.toContain("hunter2hunter");
    expect(redact("api_key=0123456789abcdef")).not.toContain("0123456789abcdef");
  });

  it("redacts AWS access keys", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).not.toContain("IOSFODNN7EXAMPLE");
  });

  it("leaves normal text alone", () => {
    expect(redact("run failed on commit abc1234: assertion error")).toBe("run failed on commit abc1234: assertion error");
  });
});

describe("truncateOutput()", () => {
  it("keeps small output intact", () => {
    const { text, truncated } = truncateOutput("hello");
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("truncates with a visible marker", () => {
    const { text, truncated } = truncateOutput("x".repeat(300 * 1024), 256 * 1024);
    expect(truncated).toBe(true);
    expect(text).toContain("OUTPUT TRUNCATED");
    expect(Buffer.byteLength(text)).toBeLessThan(260 * 1024);
  });
});

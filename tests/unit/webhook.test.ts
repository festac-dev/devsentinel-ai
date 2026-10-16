import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyGithubSignature, parsePrEvent, isRunnablePrAction, splitFullName } from "@/modules/github/webhook";

const SECRET = "whsec_test_12345";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const BODY = JSON.stringify({
  action: "opened",
  number: 1,
  repository: { full_name: "octocat/hello", name: "hello", owner: { login: "octocat" } },
  pull_request: { head: { sha: "a".repeat(40), ref: "feature" }, base: { ref: "main" }, title: "Test PR" },
});

describe("webhook signature verification", () => {
  it("accepts a valid signature", () => {
    expect(verifyGithubSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyGithubSignature(BODY, sign(BODY, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = BODY.replace("opened", "reopened");
    expect(verifyGithubSignature(tampered, sign(BODY), SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyGithubSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyGithubSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyGithubSignature(BODY, "sha1=deadbeef", SECRET)).toBe(false);
    expect(verifyGithubSignature(BODY, "sha256=not-hex!", SECRET)).toBe(false);
    expect(verifyGithubSignature(BODY, "sha256=" + "0".repeat(64), SECRET)).toBe(false);
  });
});

describe("payload parsing", () => {
  it("parses a valid pull_request event", () => {
    const p = parsePrEvent(BODY);
    expect(p).not.toBeNull();
    expect(p!.number).toBe(1);
    expect(p!.pull_request.head.sha).toBe("a".repeat(40));
  });

  it("rejects unparseable or wrong-shaped payloads", () => {
    expect(parsePrEvent("not json")).toBeNull();
    expect(parsePrEvent("{}")).toBeNull();
    expect(parsePrEvent(JSON.stringify({ action: "opened" }))).toBeNull();
  });

  it("recognizes runnable actions", () => {
    for (const a of ["opened", "synchronize", "reopened", "ready_for_review"]) expect(isRunnablePrAction(a)).toBe(true);
    for (const a of ["closed", "labeled", "assigned"]) expect(isRunnablePrAction(a)).toBe(false);
  });

  it("splits full repository names strictly", () => {
    expect(splitFullName("octocat/hello")).toEqual({ owner: "octocat", repo: "hello" });
    expect(splitFullName("octocat/hello/extra")).toBeNull();
    expect(splitFullName("justone")).toBeNull();
  });
});

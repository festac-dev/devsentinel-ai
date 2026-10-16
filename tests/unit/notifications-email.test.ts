import { afterEach, describe, expect, it, vi } from "vitest";
import { emailConfigured, sendEmail } from "@/modules/notifications/email";

function configured(provider?: string, from = "devsentinel@example.com") {
  process.env.EMAIL_PROVIDER_API_KEY = "test_key";
  process.env.EMAIL_PROVIDER_FROM = from;
  if (provider) process.env.EMAIL_PROVIDER = provider;
}
function cleanup() {
  delete process.env.EMAIL_PROVIDER;
  delete process.env.EMAIL_PROVIDER_API_KEY;
  delete process.env.EMAIL_PROVIDER_FROM;
  vi.unstubAllGlobals();
}
const message = { to: "u@example.com", subject: "s", text: "b" };

describe("email provider", () => {
  afterEach(cleanup);

  it("reports not_configured without env credentials and never calls the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendEmail(message)).toEqual({ state: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(emailConfigured()).toBe(false);
  });

  it("uses Brevo by default and marks delivered only when a messageId is returned", async () => {
    configured(undefined, "DevSentinel <devsentinel@example.com>");
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.brevo.com/v3/smtp/email");
      expect((init!.headers as Record<string, string>)["api-key"]).toBe("test_key");
      const body = JSON.parse(String(init!.body));
      expect(body.sender).toEqual({ name: "DevSentinel", email: "devsentinel@example.com" });
      expect(body.to).toEqual([{ email: "u@example.com" }]);
      expect(body.textContent).toBe("b");
      return new Response(JSON.stringify({ messageId: "<abc@smtp-relay>" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendEmail(message)).resolves.toEqual({ state: "delivered", providerId: "<abc@smtp-relay>" });
  });

  it("supports Resend when EMAIL_PROVIDER=resend", async () => {
    configured("resend");
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.resend.com/emails");
      expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test_key");
      const body = JSON.parse(String(init!.body));
      expect(body.from).toBe("devsentinel@example.com");
      expect(body.to).toEqual(["u@example.com"]);
      return new Response(JSON.stringify({ id: "email-123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendEmail(message)).resolves.toEqual({ state: "delivered", providerId: "email-123" });
  });

  it("fails when the provider accepts the request but returns no id", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    expect((await sendEmail(message)).state).toBe("failed");
  });

  it("records the provider's failure reason without leaking the key", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"code":"unauthorized","message":"Key not found (sk-user-XXXXXXXX)"}', { status: 401 })));
    const outcome = await sendEmail(message);
    expect(outcome.state).toBe("failed");
    if (outcome.state === "failed") {
      expect(outcome.error).toMatch(/401/);
      expect(outcome.error).not.toContain("test_key");
    }
  });

  it("fails on a network error instead of claiming delivery", async () => {
    configured();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const outcome = await sendEmail(message);
    expect(outcome.state).toBe("failed");
    if (outcome.state === "failed") expect(outcome.error).toContain("ECONNREFUSED");
  });
});

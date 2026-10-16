/**
 * Email delivery via a provider's HTTP API. No SDK or extra dependency.
 *
 * Supported providers (set EMAIL_PROVIDER):
 *  - "brevo"  (default) Free tier: 300 emails/day. A single verified sender
 *             address is enough, no custom domain required.
 *             https://developers.brevo.com/reference/sendtransacemail
 *  - "resend" https://resend.com/docs/api-reference/emails/send-email
 *
 * A message counts as "delivered" only when the provider accepts it and
 * returns a message id; otherwise the outcome is "failed" with the provider's
 * reason. When email is not configured, in-app notifications continue to work.
 */

import { redact } from "@/lib/redact";

export type EmailOutcome =
  | { state: "delivered"; providerId: string }
  | { state: "failed"; error: string }
  | { state: "not_configured" };

type EmailInput = { to: string; subject: string; text: string };
type EmailProviderName = "brevo" | "resend";

export function emailProviderName(): EmailProviderName {
  return process.env.EMAIL_PROVIDER?.trim().toLowerCase() === "resend" ? "resend" : "brevo";
}

export function emailConfigured(): boolean {
  return Boolean(process.env.EMAIL_PROVIDER_API_KEY && process.env.EMAIL_PROVIDER_FROM);
}

/** Accepts "name@example.com" or "DevSentinel <name@example.com>". */
function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || undefined, email: match[2].trim() };
  return { email: from.trim() };
}

type ProviderRequest = { url: string; headers: Record<string, string>; body: unknown; idOf: (json: Record<string, unknown>) => string | undefined };

function buildRequest(provider: EmailProviderName, input: EmailInput): ProviderRequest {
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY as string;
  const from = process.env.EMAIL_PROVIDER_FROM as string;
  if (provider === "resend") {
    return {
      url: "https://api.resend.com/emails",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: { from, to: [input.to], subject: input.subject, text: input.text },
      idOf: (json) => (typeof json.id === "string" ? json.id : undefined),
    };
  }
  const sender = parseSender(from);
  return {
    url: "https://api.brevo.com/v3/smtp/email",
    headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: {
      sender: sender.name ? { name: sender.name, email: sender.email } : { email: sender.email },
      to: [{ email: input.to }],
      subject: input.subject,
      textContent: input.text,
    },
    idOf: (json) => (typeof json.messageId === "string" ? json.messageId : undefined),
  };
}

export async function sendEmail(input: EmailInput): Promise<EmailOutcome> {
  if (!emailConfigured()) return { state: "not_configured" };
  try {
    const req = buildRequest(emailProviderName(), input);
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = redact((await res.text()).slice(0, 300));
      return { state: "failed", error: `Email provider responded ${res.status}: ${detail}` };
    }
    const id = req.idOf((await res.json()) as Record<string, unknown>);
    return id
      ? { state: "delivered", providerId: id }
      : { state: "failed", error: "Email provider accepted the message but returned no id." };
  } catch (err) {
    return { state: "failed", error: `Email provider request failed: ${redact(String(err)).slice(0, 200)}` };
  }
}

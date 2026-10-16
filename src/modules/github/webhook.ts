import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook verification (spec 9.2/9.3).
 * HMAC-SHA256 over the RAW body with the webhook secret, constant-time compare.
 */

export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (received.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
  } catch {
    return false;
  }
}

/** Zod-free light validation of the pull_request event payload fields we need. */
export type PrEventPayload = {
  action: string;
  number: number;
  repository: { full_name: string; name: string; owner: { login: string }; default_branch?: string };
  pull_request: {
    head: { sha: string; ref: string };
    base: { ref: string };
    title?: string;
    user?: { login: string };
    merged?: boolean;
  };
  installation?: { id: number };
};

export function parsePrEvent(raw: string): PrEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = parsed as PrEventPayload;
  if (
    typeof p?.action !== "string" ||
    typeof p?.number !== "number" ||
    !p?.repository?.full_name ||
    typeof p?.pull_request?.head?.sha !== "string" ||
    typeof p?.pull_request?.head?.ref !== "string" ||
    typeof p?.pull_request?.base?.ref !== "string"
  ) {
    return null;
  }
  return p;
}

/** PR events that should start a run (spec 9.2 step 2). */
export function isRunnablePrAction(action: string): boolean {
  return ["opened", "synchronize", "reopened", "ready_for_review"].includes(action);
}

export function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

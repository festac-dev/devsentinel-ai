/**
 * GitHub App authentication (docs/github-app-setup.md). Used to publish commit
 * statuses via an installation access token when no per-project PAT exists:
 *   1. Sign a short-lived RS256 JWT with the app's private key (GITHUB_APP_ID).
 *   2. Exchange it for an installation token (POST /app/installations/:id/access_tokens).
 *   3. Use that token for repository API calls.
 * Tokens are cached in memory until 5 minutes before expiry and never logged.
 */

import { createSign } from "node:crypto";
import { redact } from "@/lib/redact";

const GITHUB_API = "https://api.github.com";

export function githubAppConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

function privateKey(): string {
  // A PEM pasted as a single env line uses literal "\n" escapes; an already
  // multiline PEM contains no "\n" two-character sequences, so this is a no-op.
  return (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
}

/** RS256 JWT per GitHub's App authentication docs (10-minute expiry). */
export function createAppJwt(nowMs = Date.now()): string {
  const appId = process.env.GITHUB_APP_ID;
  if (!appId || !process.env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: Math.floor(nowMs / 1000) - 30, exp: Math.floor(nowMs / 1000) + 540, iss: appId };
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey()).toString("base64url");
  return `${unsigned}.${signature}`;
}

type CachedToken = { token: string; expiresAtMs: number };
const tokenCache = new Map<string, CachedToken>();

/** Fetch (or reuse) an installation access token. Throws with a redacted message on failure. */
export async function getInstallationToken(installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs > Date.now() + 5 * 60_000) return cached.token;

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devsentinel-ai",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`GitHub App token request failed: ${redact(String(err)).slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = redact(await res.text()).slice(0, 300);
    throw new Error(`GitHub App token request responded ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error("GitHub App token response had no token.");
  const expiresAtMs = body.expires_at ? new Date(body.expires_at).getTime() : Date.now() + 55 * 60_000;
  tokenCache.set(installationId, { token: body.token, expiresAtMs });
  // Evict expired entries: a long-running worker would otherwise keep expired
  // access tokens resident for every installation ever seen.
  for (const [id, cached] of tokenCache) {
    if (cached.expiresAtMs < Date.now()) tokenCache.delete(id);
  }
  return body.token;
}

// Test hook: clear the in-memory token cache.
export function resetTokenCacheForTests() {
  tokenCache.clear();
}

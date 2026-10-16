/**
 * GitHub App connection flow — per account.
 *
 *  1. "Connect GitHub" sends the user to GitHub sign-in (user authorization) with a
 *     signed, short-lived `state` that binds the flow to one user and one project.
 *  2. GitHub redirects to /api/github/callback with a `code`. We exchange it and ask
 *     GitHub which installations of this App the user can access
 *     (GET /user/installations); only those are recorded for the user.
 *  3. If the user has none yet, they are sent to the App's install page; GitHub
 *     returns to the same callback, which repeats step 1 to verify and record it.
 *
 * Repository lists and links only ever use installations recorded for the signed-in
 * user, so accounts never see each other's repositories.
 */

import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/crypto";
import { redact } from "@/lib/redact";
import { createAppJwt, getInstallationToken, githubAppConfigured } from "@/modules/github/app-auth";

const GITHUB_API = "https://api.github.com";
const STATE_TTL_MS = 15 * 60_000;

export function githubInstallEnabled(): boolean {
  return githubAppConfigured() && /^[A-Za-z0-9-]+$/.test(process.env.GITHUB_APP_SLUG ?? "");
}

export function githubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET);
}

/**
 * Per-account GitHub connection needs the App install flow AND GitHub user
 * authorization (the App's client id/secret). The OAuth step is what proves the
 * signed-in DevSentinel user can actually access an installation, so repositories
 * are never listed or linked across accounts.
 */
export function githubConnectEnabled(): boolean {
  return githubInstallEnabled() && githubOAuthConfigured();
}

/**
 * Test-only escape hatch: the browser E2E suite has no real GitHub to prove repository
 * access against. Honored only with this exact value and never on Vercel/Railway; it must
 * not be set in any real deployment.
 */
export function repoProofBypassedForTests(): boolean {
  return (
    process.env.DEVSENTINEL_E2E_SKIP_REPO_PROOF === "i-understand-this-disables-access-checks" &&
    !process.env.VERCEL &&
    !process.env.RAILWAY_ENVIRONMENT
  );
}

/** Names (never values) of the settings that are missing for per-account GitHub connection. */
export function githubConnectMissing(): string[] {
  const missing: string[] = [];
  if (!process.env.GITHUB_APP_ID) missing.push("GITHUB_APP_ID");
  if (!process.env.GITHUB_APP_PRIVATE_KEY) missing.push("GITHUB_APP_PRIVATE_KEY");
  if (!/^[A-Za-z0-9-]+$/.test(process.env.GITHUB_APP_SLUG ?? "")) missing.push("GITHUB_APP_SLUG");
  if (!process.env.GITHUB_APP_CLIENT_ID) missing.push("GITHUB_APP_CLIENT_ID");
  if (!process.env.GITHUB_APP_CLIENT_SECRET) missing.push("GITHUB_APP_CLIENT_SECRET");
  return missing;
}

function sign(body: string): string {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error("ENCRYPTION_KEY is not configured.");
  return createHmac("sha256", secret).update(`github-install-state.${body}`).digest("base64url");
}

export function signInstallState(input: { projectId: string; userId: string; installed?: boolean }, nowMs = Date.now()): string {
  const payload: { p: string; u: string; e: number; i?: 1 } = { p: input.projectId, u: input.userId, e: nowMs + STATE_TTL_MS };
  if (input.installed) payload.i = 1; // set once the user has been sent through GitHub's install page
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifyInstallState(state: string, nowMs = Date.now()): { projectId: string; userId: string; installed: boolean } | null {
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined) return null;
  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: unknown; u?: unknown; e?: unknown; i?: unknown };
    if (typeof data.p !== "string" || typeof data.u !== "string" || typeof data.e !== "number") return null;
    if (data.e < nowMs) return null;
    return { projectId: data.p, userId: data.u, installed: data.i === 1 };
  } catch {
    return null;
  }
}

export function buildInstallUrl(input: { projectId: string; userId: string }): string {
  const slug = process.env.GITHUB_APP_SLUG ?? "";
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(signInstallState({ ...input, installed: true }))}`;
}

/** GitHub sign-in (user authorization) URL; the callback proves which installations this user can access. */
export function buildAuthorizeUrl(input: { projectId: string; userId: string; installed?: boolean }, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_APP_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    state: signInstallState(input),
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export type InstallationCheck = { ok: true } | { ok: false; reason: "not_installed" | "mismatch" | "error"; detail?: string };

/** Confirms the App is installed on owner/repo and that installation id is the one GitHub reported. */
export async function verifyInstallationCoversRepo(installationId: string, owner: string, repo: string): Promise<InstallationCheck> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devsentinel-ai",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, reason: "error", detail: redact(String(err)).slice(0, 200) };
  }
  if (res.status === 404) return { ok: false, reason: "not_installed" };
  if (!res.ok) return { ok: false, reason: "error", detail: `GitHub responded ${res.status}` };
  const body = (await res.json()) as { id?: number };
  return String(body.id) === installationId ? { ok: true } : { ok: false, reason: "mismatch" };
}

export type RepoInstallation =
  | { ok: true; installationId: string }
  | { ok: false; reason: "not_installed" | "error"; detail?: string };

/**
 * Asks GitHub whether the App is already installed on owner/repo and returns that
 * installation's id. Lets a repository be linked without sending the user through
 * the install/uninstall round trip when the App already has access to it.
 */
export async function findRepoInstallation(owner: string, repo: string): Promise<RepoInstallation> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devsentinel-ai",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, reason: "error", detail: redact(String(err)).slice(0, 200) };
  }
  if (res.status === 404) return { ok: false, reason: "not_installed" };
  if (!res.ok) return { ok: false, reason: "error", detail: `GitHub responded ${res.status}` };
  const body = (await res.json()) as { id?: number };
  return typeof body.id === "number" ? { ok: true, installationId: String(body.id) } : { ok: false, reason: "error", detail: "No installation id returned" };
}

const GH_HEADERS_JSON = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "devsentinel-ai",
} as const;

export type AvailableRepo = { owner: string; repo: string; installationId: string; defaultBranch: string; private: boolean };

export type AvailableRepos =
  | { ok: true; repos: AvailableRepo[] }
  | { ok: false; reason: "not_available" | "error"; detail?: string };

/**
 * Repositories visible through the given installations — callers pass ONLY the
 * installation ids the signed-in user has proven access to (see the callback
 * route), so one account never sees another account's repositories. A plain
 * HTTPS call (not the TestSprite CLI), so it is safe to run in the web role (ADR-010).
 */
export async function listInstallationRepos(installationIds: string[]): Promise<AvailableRepos> {
  if (!githubInstallEnabled()) return { ok: false, reason: "not_available" };
  if (installationIds.length === 0) return { ok: true, repos: [] };

  const CAP = 300;
  const seen = new Set<string>();
  const repos: AvailableRepo[] = [];
  let anyToken = false;
  for (const installationId of installationIds) {
    if (!/^\d{1,20}$/.test(installationId)) continue;
    let token: string;
    try {
      token = await getInstallationToken(installationId);
      anyToken = true;
    } catch {
      continue; // skip an installation we cannot mint a token for (e.g. uninstalled); others may still work
    }
    for (let page = 1; page <= 3 && repos.length < CAP; page++) {
      let body: { repositories?: Array<{ name?: string; owner?: { login?: string }; default_branch?: string; private?: boolean }> };
      try {
        const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, ...GH_HEADERS_JSON },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) break;
        body = (await res.json()) as typeof body;
      } catch {
        break;
      }
      const batch = body.repositories ?? [];
      for (const r of batch) {
        const owner = r.owner?.login;
        const repo = r.name;
        if (!owner || !repo) continue;
        const key = `${owner}/${repo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        repos.push({ owner, repo, installationId, defaultBranch: r.default_branch || "main", private: Boolean(r.private) });
        if (repos.length >= CAP) break;
      }
      if (batch.length < 100) break; // last page
    }
  }
  if (!anyToken) return { ok: false, reason: "error", detail: "GitHub did not accept the App credentials for any of your installations." };

  repos.sort((a, b) => a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo));
  return { ok: true, repos };
}

export type UserInstallation = { id: string; account: string | null };

/** Exchanges the OAuth `code` from GitHub's redirect for a user access token. Never logs the token. */
export async function exchangeUserCode(code: string, redirectUri: string): Promise<{ ok: true; token: string } | { ok: false; detail?: string }> {
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { ...GH_HEADERS_JSON, "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_APP_CLIENT_ID,
        client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, detail: `GitHub responded ${res.status}` };
    const body = (await res.json()) as { access_token?: string; error?: string };
    if (!body.access_token) return { ok: false, detail: body.error ?? "No access token returned" };
    return { ok: true, token: body.access_token };
  } catch (err) {
    return { ok: false, detail: redact(String(err)).slice(0, 200) };
  }
}

/** Installations of this App that the signed-in GitHub user can access (GET /user/installations). */
export async function listUserInstallations(userToken: string): Promise<{ ok: true; installations: UserInstallation[] } | { ok: false; detail?: string }> {
  try {
    const res = await fetch(`${GITHUB_API}/user/installations?per_page=100`, {
      headers: { Authorization: `Bearer ${userToken}`, ...GH_HEADERS_JSON },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, detail: `GitHub responded ${res.status}` };
    const body = (await res.json()) as { installations?: Array<{ id?: number; account?: { login?: string } | null }> };
    const installations: UserInstallation[] = [];
    for (const inst of body.installations ?? []) {
      if (typeof inst.id === "number") installations.push({ id: String(inst.id), account: inst.account?.login ?? null });
    }
    return { ok: true, installations };
  } catch (err) {
    return { ok: false, detail: redact(String(err)).slice(0, 200) };
  }
}

/**
 * Proof of access for connecting a repository by name with a personal token:
 * the token must be valid AND have push permission on the repository (reading a
 * public repository proves nothing, and push is what status publishing needs anyway).
 */
export async function verifyTokenCanPush(token: string, owner: string, repo: string): Promise<{ ok: true } | { ok: false; reason: "denied" | "error" }> {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { Authorization: `Bearer ${token}`, ...GH_HEADERS_JSON },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, reason: "denied" };
    if (!res.ok) return { ok: false, reason: "error" };
    const body = (await res.json()) as { permissions?: { push?: boolean } };
    return body.permissions?.push === true ? { ok: true } : { ok: false, reason: "denied" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

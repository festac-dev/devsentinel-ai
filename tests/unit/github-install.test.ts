import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoProofBypassedForTests, buildInstallUrl, githubInstallEnabled, listInstallationRepos, listUserInstallations, signInstallState, verifyInstallationCoversRepo, verifyInstallState, verifyTokenCanPush } from "@/modules/github/install";
import { resetTokenCacheForTests } from "@/modules/github/app-auth";

const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("github install flow", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKeyPem;
    process.env.GITHUB_APP_SLUG = "devsentinel-ai";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ["ENCRYPTION_KEY", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG"]) delete process.env[k];
  });

  it("round-trips a signed state", () => {
    const state = signInstallState({ projectId: "p1", userId: "u1" });
    expect(verifyInstallState(state)).toEqual({ projectId: "p1", userId: "u1", installed: false });
    expect(verifyInstallState(signInstallState({ projectId: "p1", userId: "u1", installed: true }))).toEqual({ projectId: "p1", userId: "u1", installed: true });
  });

  it("rejects tampered, expired, and malformed state", () => {
    const now = Date.now();
    const state = signInstallState({ projectId: "p1", userId: "u1" }, now);
    const [body, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "other", u: "u1", e: now + 60_000 })).toString("base64url");
    expect(verifyInstallState(`${forged}.${sig}`)).toBeNull();
    expect(verifyInstallState(`${body}.AAAA`)).toBeNull();
    expect(verifyInstallState("nonsense")).toBeNull();
    expect(verifyInstallState(state, now + 16 * 60_000)).toBeNull();
  });

  it("builds the GitHub installation URL and is enabled only with a valid slug", () => {
    expect(githubInstallEnabled()).toBe(true);
    expect(buildInstallUrl({ projectId: "p1", userId: "u1" })).toMatch(/^https:\/\/github\.com\/apps\/devsentinel-ai\/installations\/new\?state=/);
    process.env.GITHUB_APP_SLUG = "bad slug/../";
    expect(githubInstallEnabled()).toBe(false);
  });

  it("accepts an installation that covers the repository", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://api.github.com/repos/octo/hello/installation");
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    }));
    await expect(verifyInstallationCoversRepo("4242", "octo", "hello")).resolves.toEqual({ ok: true });
  });

  it("rejects a mismatched id, a missing installation, and GitHub errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 })));
    await expect(verifyInstallationCoversRepo("2", "octo", "hello")).resolves.toMatchObject({ ok: false, reason: "mismatch" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(verifyInstallationCoversRepo("2", "octo", "hello")).resolves.toMatchObject({ ok: false, reason: "not_installed" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    await expect(verifyInstallationCoversRepo("2", "octo", "hello")).resolves.toMatchObject({ ok: false, reason: "error" });
  });

  it("lists repositories only for the installation ids it is given", async () => {
    resetTokenCacheForTests();
    const tokenRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        tokenRequests.push(u);
        return new Response(JSON.stringify({ token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200 });
      }
      if (u.includes("/installation/repositories")) {
        return new Response(JSON.stringify({ repositories: [
          { name: "hello", owner: { login: "octo" }, default_branch: "main", private: false },
          { name: "secret", owner: { login: "octo" }, default_branch: "dev", private: true },
        ] }), { status: 200 });
      }
      throw new Error(`unexpected url ${u}`);
    }));
    const res = await listInstallationRepos(["42"]);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toContain("/app/installations/42/access_tokens");
    expect(res).toEqual({
      ok: true,
      repos: [
        { owner: "octo", repo: "hello", installationId: "42", defaultBranch: "main", private: false },
        { owner: "octo", repo: "secret", installationId: "42", defaultBranch: "dev", private: true },
      ],
    });
  });

  it("lists nothing (and calls GitHub not at all) for an account with no installations", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listInstallationRepos([])).resolves.toEqual({ ok: true, repos: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the user's own installations from GitHub with their token", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/user/installations");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ghu_user");
      return new Response(JSON.stringify({ installations: [{ id: 7, account: { login: "me" } }, { id: 8, account: null }] }), { status: 200 });
    }));
    await expect(listUserInstallations("ghu_user")).resolves.toEqual({
      ok: true,
      installations: [{ id: "7", account: "me" }, { id: "8", account: null }],
    });
  });

  it("accepts a token only when it can push to the repository", async () => {
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", reply(200, { permissions: { push: true } }));
    await expect(verifyTokenCanPush("t", "octo", "hello")).resolves.toEqual({ ok: true });
    vi.stubGlobal("fetch", reply(200, { permissions: { push: false, pull: true } }));
    await expect(verifyTokenCanPush("t", "octo", "hello")).resolves.toEqual({ ok: false, reason: "denied" });
    vi.stubGlobal("fetch", reply(401, { message: "Bad credentials" }));
    await expect(verifyTokenCanPush("bad", "octo", "hello")).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("reports not_available without a valid app slug", async () => {
    process.env.GITHUB_APP_SLUG = "bad slug/../";
    await expect(listInstallationRepos(["42"])).resolves.toEqual({ ok: false, reason: "not_available" });
  });

  it("only bypasses the repository proof with the exact test value outside Vercel/Railway", () => {
    expect(repoProofBypassedForTests()).toBe(false);
    process.env.DEVSENTINEL_E2E_SKIP_REPO_PROOF = "1";
    expect(repoProofBypassedForTests()).toBe(false);
    process.env.DEVSENTINEL_E2E_SKIP_REPO_PROOF = "i-understand-this-disables-access-checks";
    expect(repoProofBypassedForTests()).toBe(true);
    process.env.VERCEL = "1";
    expect(repoProofBypassedForTests()).toBe(false);
    delete process.env.VERCEL;
    delete process.env.DEVSENTINEL_E2E_SKIP_REPO_PROOF;
  });
});

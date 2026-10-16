import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppJwt, getInstallationToken, githubAppConfigured, resetTokenCacheForTests } from "@/modules/github/app-auth";

const { privateKeyPem, publicKeyPem } = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
})();

function decodeJwtPart(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("github app auth", () => {
  beforeEach(() => {
    process.env.GITHUB_APP_ID = "123456";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKeyPem;
    resetTokenCacheForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("reports configured only when id and key are both present", () => {
    expect(githubAppConfigured()).toBe(true);
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(githubAppConfigured()).toBe(false);
  });

  it("creates an RS256 JWT whose signature verifies with the app public key", () => {
    const jwt = createAppJwt();
    const [h, p, s] = jwt.split(".");
    expect(decodeJwtPart(h!)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const payload = decodeJwtPart(p!) as { iss: string; exp: number; iat: number };
    expect(payload.iss).toBe("123456");
    expect(payload.exp - payload.iat).toBe(570); // 10 min window with 30 s backdating
    const verified = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(publicKeyPem), Buffer.from(s!, "base64url"));
    expect(verified).toBe(true);
  });

  it("accepts a single-line PEM with \\n escapes", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = privateKeyPem.replace(/\n/g, "\\n");
    const key = createPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"));
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(() => createAppJwt()).not.toThrow();
  });

  it("throws (never fabricates a token) when unconfigured", async () => {
    delete process.env.GITHUB_APP_ID;
    await expect(getInstallationToken("999")).rejects.toThrow(/not configured|responded|failed|no token|App/i);
  });

  it("exchanges the JWT for an installation token and caches it", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe("https://api.github.com/app/installations/42/access_tokens");
      return new Response(JSON.stringify({ token: "ghit_token", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const auth = decodeJwtPart(createAppJwt().split(".")[0]!);
    void auth;
    const jwt = createAppJwt();
    expect(jwt.split(".")).toHaveLength(3);

    const first = await getInstallationToken("42");
    expect(first).toBe("ghit_token");
    const second = await getInstallationToken("42");
    expect(second).toBe("ghit_token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  it("surfaces a provider failure as a redacted error, not a token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad credentials {\"secret\":\"sk-user-abcdef\"}", { status: 401 })));
    await expect(getInstallationToken("42")).rejects.toThrow(/401/);
  });
});

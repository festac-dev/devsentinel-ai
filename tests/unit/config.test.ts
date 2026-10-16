/**
 * Startup configuration validation (ADR-010): invalid values fail loudly with
 * messages that name the variable and expected format but never echo values.
 */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, requireDatabaseUrl } from "@/lib/config";

const SAVED = { ...process.env };

afterEach(() => {
  process.env = { ...SAVED };
});

describe("APP_ROLE", () => {
  it("defaults to all (web + worker in one process)", () => {
    delete process.env.APP_ROLE;
    expect(loadConfig().role).toBe("all");
    expect(loadConfig().inProcessWorker).toBe(true);
  });

  it("accepts web, worker and all", () => {
    for (const role of ["web", "worker", "all"]) {
      process.env.APP_ROLE = role;
      expect(loadConfig().role).toBe(role);
    }
    process.env.APP_ROLE = "WEB";
    expect(loadConfig().role).toBe("web"); // case-insensitive
  });

  it("rejects unknown roles without echoing the value", () => {
    process.env.APP_ROLE = "s3cr3t-value";
    expect(() => loadConfig()).toThrow(/APP_ROLE/);
    expect(() => loadConfig()).toThrow(/"web", "worker", "all"/);
    try {
      loadConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cr3t-value");
    }
  });

  it("never boots the worker in-process for the web role", () => {
    process.env.APP_ROLE = "web";
    expect(loadConfig().inProcessWorker).toBe(false);
  });
});

describe("WORKER_IN_PROCESS (deprecated alias)", () => {
  it("rejects values other than 0/1", () => {
    process.env.WORKER_IN_PROCESS = "yes";
    expect(() => loadConfig()).toThrow(/WORKER_IN_PROCESS/);
  });

  it("is accepted as 0/1 without changing an explicit role", () => {
    process.env.APP_ROLE = "web";
    process.env.WORKER_IN_PROCESS = "0";
    expect(loadConfig().inProcessWorker).toBe(false);
    process.env.WORKER_IN_PROCESS = "1";
    // An explicit APP_ROLE=web still never runs the worker.
    expect(loadConfig().inProcessWorker).toBe(false);
  });
});

describe("numeric variables", () => {
  it("use documented defaults", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    delete process.env.WORKER_CONCURRENCY;
    delete process.env.RETENTION_DAYS;
    delete process.env.TESTSPRITE_WAIT_TIMEOUT_SECONDS;
    expect(loadConfig()).toMatchObject({ pollIntervalMs: 3000, concurrency: 2, retentionDays: 90, waitTimeoutSeconds: 600 });
  });

  it("reject out-of-range integers", () => {
    process.env.WORKER_CONCURRENCY = "0";
    expect(() => loadConfig()).toThrow(/WORKER_CONCURRENCY/);
    process.env.WORKER_CONCURRENCY = "2";
    process.env.TESTSPRITE_WAIT_TIMEOUT_SECONDS = "10";
    expect(() => loadConfig()).toThrow(/TESTSPRITE_WAIT_TIMEOUT_SECONDS/);
  });
});

describe("APP_BASE_URL (the only public-URL setting)", () => {
  it("accepts http(s) URLs and trims a trailing slash", () => {
    process.env.APP_BASE_URL = "https://dev.example.com/";
    expect(loadConfig().baseUrl).toBe("https://dev.example.com");
    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(loadConfig().baseUrl).toBe("http://localhost:3000");
  });

  it("rejects non-http(s) or malformed URLs without echoing them", () => {
    process.env.APP_BASE_URL = "postgres://user:pw@host/db";
    expect(() => loadConfig()).toThrow(/APP_BASE_URL/);
    try {
      loadConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain("pw@host");
    }
    process.env.APP_BASE_URL = "not a url";
    expect(() => loadConfig()).toThrow(/APP_BASE_URL/);
  });

  it("is optional (null until set)", () => {
    delete process.env.APP_BASE_URL;
    expect(loadConfig().baseUrl).toBeNull();
  });
});

describe("requireDatabaseUrl", () => {
  it("accepts postgres URLs", () => {
    process.env.DATABASE_URL = "postgresql://u:p@h:5432/d";
    expect(requireDatabaseUrl()).toContain("postgresql://");
    process.env.DATABASE_URL = "postgres://u:p@h:5432/d";
    expect(requireDatabaseUrl()).toBeDefined();
  });

  it("rejects missing or non-Postgres URLs and never echoes them", () => {
    delete process.env.DATABASE_URL;
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
    process.env.DATABASE_URL = "file:./dev.db";
    expect(() => requireDatabaseUrl()).toThrow(/postgres/);
    try {
      requireDatabaseUrl();
    } catch (err) {
      expect((err as Error).message).not.toContain("file:./dev.db");
    }
  });
});

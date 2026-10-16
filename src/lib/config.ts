/**
 * Runtime configuration (ADR-010): every setting comes from the environment and
 * is validated once at process start with clear, secret-free errors — a
 * mistyped value must never echo credentials back into logs.
 *
 * One codebase, role by env:
 *   APP_ROLE=web    Next.js UI + API routes + webhook endpoint only.
 *   APP_ROLE=worker background worker entrypoint only (no inbound port).
 *   APP_ROLE=all    both in one process (single-container hosts, local dev).
 */

export type AppRole = "web" | "worker" | "all";

export type AppConfig = {
  role: AppRole;
  /** True when the worker loop boots inside the web process (APP_ROLE=all). */
  inProcessWorker: boolean;
  pollIntervalMs: number;
  concurrency: number;
  retentionDays: number;
  waitTimeoutSeconds: number;
  /** The only public-URL setting; used for links and the documented webhook URL. */
  baseUrl: string | null;
};

const ROLES: readonly AppRole[] = ["web", "worker", "all"];

function fail(name: string, expected: string): never {
  // Values are deliberately never included: URLs and keys can carry secrets.
  throw new Error(`Invalid configuration: ${name} ${expected}`);
}

function intVar(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(name, `must be an integer between ${min} and ${max}`);
  }
  return value;
}

function roleVar(): AppRole {
  const raw = (process.env.APP_ROLE ?? "").trim().toLowerCase();
  if (raw === "") {
    // Default role: web + worker in one process (single-container hosts, local
    // dev). The legacy WORKER_IN_PROCESS=1 alias lands here too; see
    // workerInProcessVar and DEPLOYMENT.md.
    return "all";
  }
  if (!ROLES.includes(raw as AppRole)) fail("APP_ROLE", 'must be one of "web", "worker", "all"');
  return raw as AppRole;
}

function workerInProcessVar(): void {
  const raw = process.env.WORKER_IN_PROCESS;
  if (raw !== undefined && raw !== "" && raw !== "0" && raw !== "1") {
    fail("WORKER_IN_PROCESS", 'must be "0" or "1" (deprecated; use APP_ROLE=all instead)');
  }
}

export function loadConfig(): AppConfig {
  workerInProcessVar();
  const role = roleVar();

  const rawBaseUrl = (process.env.APP_BASE_URL ?? "").trim();
  let baseUrl: string | null = null;
  if (rawBaseUrl !== "") {
    try {
      const parsed = new URL(rawBaseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
      baseUrl = parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, ""));
    } catch {
      fail("APP_BASE_URL", "must be a valid http(s) URL, e.g. https://devsentinel.example.com");
    }
  }

  return {
    role,
    inProcessWorker: role === "all",
    pollIntervalMs: intVar("WORKER_POLL_INTERVAL_MS", 3000, 100, 600_000),
    concurrency: intVar("WORKER_CONCURRENCY", 2, 1, 16),
    retentionDays: intVar("RETENTION_DAYS", 90, 1, 3650),
    waitTimeoutSeconds: intVar("TESTSPRITE_WAIT_TIMEOUT_SECONDS", 600, 60, 900),
    baseUrl,
  };
}

/** Database URL guard: PostgreSQL everywhere (ADR-010); never echo the URL. */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") fail("DATABASE_URL", "is required (a PostgreSQL connection string)");
  if (!/^postgres(ql)?:\/\//i.test(url.trim())) {
    fail("DATABASE_URL", "must be a postgres:// or postgresql:// connection string");
  }
  return url;
}

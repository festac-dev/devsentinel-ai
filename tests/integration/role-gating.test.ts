/**
 * Role gating (ADR-010): APP_ROLE decides what a process is allowed to do.
 *   - web:  instrumentation never boots the worker loop; the standalone worker
 *           entrypoint refuses to start.
 *   - worker: the standalone entrypoint runs, heartbeats, and drains on
 *           SIGTERM — with no HTTP server listening.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareTestDatabase, TEST_DATABASE_URL } from "./helpers/testdb";
import { FAKE_TESTSPRITE_CLI } from "./helpers/fake-cli";

type Db = typeof import("@/lib/db");

let db: Db;
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
const root = join(process.cwd());

beforeAll(async () => {
  prepareTestDatabase();
  db = await import("@/lib/db");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

function workerEnv(role: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ROLE: role,
    DATABASE_URL: TEST_DATABASE_URL,
    DIRECT_URL: TEST_DATABASE_URL,
    ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    TESTSPRITE_CLI_PATH: FAKE_TESTSPRITE_CLI, // even a misconfigured spawn can't reach the real provider
    WORKER_POLL_INTERVAL_MS: "200",
    WORKER_CONCURRENCY: "1",
  };
}

describe("instrumentation role gating", () => {
  // register() only boots on the Node runtime (src/instrumentation.ts); Next sets
  // NEXT_RUNTIME itself, vitest does not.
  beforeAll(() => {
    process.env.NEXT_RUNTIME = "nodejs";
  });
  afterAll(() => {
    delete process.env.NEXT_RUNTIME;
  });

  it("APP_ROLE=web never boots the worker loop", async () => {
    vi.resetModules();
    process.env.APP_ROLE = "web";
    const startWorker = vi.fn(async () => {});
    vi.doMock("@/worker/loop", () => ({ startWorker }));
    const { register } = await import("@/instrumentation");
    await register();
    expect(startWorker).not.toHaveBeenCalled();
    delete process.env.APP_ROLE;
  });

  it("APP_ROLE=all boots the worker loop in-process", async () => {
    vi.resetModules();
    (globalThis as { __devsentinelWorkerStarted?: boolean }).__devsentinelWorkerStarted = undefined;
    process.env.APP_ROLE = "all";
    const startWorker = vi.fn(async () => {});
    vi.doMock("@/worker/loop", () => ({ startWorker }));
    const { register } = await import("@/instrumentation");
    await register();
    expect(startWorker).toHaveBeenCalledTimes(1);
    delete process.env.APP_ROLE;
  });
});

/** Count LISTEN sockets owned by a pid via /proc (worker must start none). */
async function listeningSockets(pid: number): Promise<number> {
  const fs = await import("node:fs");
  const fds = await fs.promises.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  const inodes = new Set<string>();
  for (const fd of fds) {
    const link = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const m = link.match(/^socket:\[(\d+)\]$/);
    if (m) inodes.add(m[1]);
  }
  let listening = 0;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await fs.promises.readFile(table, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // Column 4 is the connection state; "0A" = LISTEN. Column 10 is the inode.
      if (cols[3] === "0A" && cols[9] && inodes.has(cols[9])) listening++;
    }
  }
  return listening;
}

describe("standalone worker entrypoint", () => {
  it("refuses to start with APP_ROLE=web (no worker code may run)", async () => {
    const child = spawn(tsx, [join(root, "worker", "index.ts")], { env: workerEnv("web"), stdio: ["ignore", "pipe", "pipe"] });
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let err = "";
      child.stderr.on("data", (d) => (err += String(d)));
      child.on("close", (c) => resolve({ code: c, stderr: err }));
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("APP_ROLE=web");
    // Nothing touched the database.
    expect(await db.prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } })).toBeNull();
  });

  it("runs with APP_ROLE=worker: heartbeats, starts no HTTP server, exits cleanly on SIGTERM", async () => {
    const child = spawn(tsx, [join(root, "worker", "index.ts")], { env: workerEnv("worker"), stdio: ["ignore", "pipe", "pipe"] });
    // Wait for the first heartbeat (poll the DB like the readiness endpoint does).
    await expect
      .poll(async () => Boolean(await db.prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } })), { timeout: 30_000, interval: 1_000 })
      .toBe(true);

    // No inbound port: the worker owns zero LISTEN sockets.
    expect(await listeningSockets(child.pid!)).toBe(0);

    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c ?? null)));
    expect(code).toBe(0); // graceful shutdown, not a crash
    const hb = await db.prisma.workerHeartbeat.findUnique({ where: { id: "singleton" } });
    expect(hb).not.toBeNull();
  });
});

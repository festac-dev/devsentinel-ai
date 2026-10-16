/**
 * Database-backed rate limiting (ADR-011): limits are shared across instances
 * via the RateLimitWindow table, not per-process memory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareTestDatabase } from "./helpers/testdb";

type Db = typeof import("@/lib/db");
type Rl = typeof import("@/lib/ratelimit");

let db: Db;
let rl: Rl;

beforeAll(async () => {
  prepareTestDatabase();
  db = await import("@/lib/db");
  rl = await import("@/lib/ratelimit");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

describe("rateLimit (Postgres-backed)", () => {
  it("allows up to the limit inside a window, then blocks with a retry hint", async () => {
    const key = `test-allow:${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      expect(await rl.rateLimit(key, 3, 60_000)).toMatchObject({ ok: true, retryAfterSec: 0 });
    }
    const blocked = await rl.rateLimit(key, 3, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("counts keys independently (one key's burst never blocks another)", async () => {
    const a = `test-a:${Date.now()}-${Math.random()}`;
    const b = `test-b:${Date.now()}-${Math.random()}`;
    for (let i = 0; i < 2; i++) expect((await rl.rateLimit(a, 2, 60_000)).ok).toBe(true);
    expect((await rl.rateLimit(a, 2, 60_000)).ok).toBe(false);
    expect((await rl.rateLimit(b, 2, 60_000)).ok).toBe(true);
  });

  it("persists rows so a second instance sees the same counter", async () => {
    const key = `test-shared:${Date.now()}-${Math.random()}`;
    await rl.rateLimit(key, 2, 60_000);
    const row = await db.prisma.rateLimitWindow.findFirst({ where: { key } });
    expect(row).not.toBeNull();
    expect(row!.count).toBe(1);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

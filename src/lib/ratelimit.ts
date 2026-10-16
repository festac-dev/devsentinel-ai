import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Database-backed fixed-window rate limiter (ADR-011): counters live in the
 * RateLimitWindow table, so every web instance enforces ONE shared limit
 * instead of a per-process in-memory bucket (stateless deployment rule 3).
 *
 * Fixed windows are deliberately simple: exact enough for abuse damping, one
 * upsert per request, no read-modify-write races (the increment is atomic).
 * Expired windows are pruned opportunistically here and by the worker's
 * retention cleanup.
 */

export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + 2 * windowMs);

  let row;
  try {
    row = await prisma.rateLimitWindow.upsert({
      where: { key_windowStart: { key, windowStart } },
      create: { key, windowStart, count: 1, expiresAt },
      update: { count: { increment: 1 } },
    });
  } catch (err) {
    // Only a concurrent first hit racing the INSERT is recoverable here; the
    // row exists by now, so count this request with a plain atomic increment.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    row = await prisma.rateLimitWindow.update({
      where: { key_windowStart: { key, windowStart } },
      data: { count: { increment: 1 } },
    });
  }

  // First hit in a fresh window: sweep expired rows (bounded table, no cron
  // dependency for web-only deployments).
  if (row.count === 1) {
    prisma.rateLimitWindow
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => {});
  }

  if (row.count > limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true, retryAfterSec: 0 };
}

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashToken, randomToken } from "@/lib/crypto";

export const SESSION_COOKIE = "ds_session";
export const SESSION_IDLE_SECONDS = 60 * 60 * 12; // 12 h idle timeout
export const SESSION_ABSOLUTE_SECONDS = 60 * 60 * 24 * 7; // 7 d absolute

export async function createSession(userId: string, userAgent?: string, ip?: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_SECONDS * 1000);
  const session = await prisma.session.create({
    data: { id: hashToken(token), userId, expiresAt, userAgent: userAgent ?? null, ip: ip ?? null },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return session;
}

/** Returns the session's user, or null. Also enforces the idle timeout. */
export async function getSessionUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { id: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() < now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - session.lastSeenAt.getTime() > SESSION_IDLE_SECONDS * 1000) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  await prisma.session
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
  return session.user;
}

export async function requireUser(): Promise<NonNullable<Awaited<ReturnType<typeof getSessionUser>>>> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function destroyCurrentSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.delete({ where: { id: hashToken(token) } }).catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
}

export async function destroyAllSessions(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    // Proxies APPEND to X-Forwarded-For: the leftmost entry is whatever the
    // client sent (trivially spoofed to rotate rate-limit keys), while the
    // rightmost was set by the trusted proxy in front of the app.
    const entries = fwd.split(",");
    return entries[entries.length - 1]!.trim();
  }
  return h.get("x-real-ip") ?? "unknown";
}

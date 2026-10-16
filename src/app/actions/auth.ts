"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword, passwordPolicyError, hashToken, randomToken } from "@/lib/crypto";
import { createSession, destroyCurrentSession, destroyAllSessions, getSessionUser, clientIp } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { csrfFromForm, CSRF_BLOCKED_MESSAGE } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { emailConfigured, sendEmail } from "@/modules/notifications/email";

const RegisterSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(200).toLowerCase(),
  password: z.string().min(1).max(200),
});

export type ActionState = { error?: string; success?: string } | null;

export async function registerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const ip = await clientIp();
  const rl = await rateLimit(`register:${ip}`, 5, 15 * 60_000);
  if (!rl.ok) return { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` };

  const parsed = RegisterSchema.safeParse({
    name: form.get("name"),
    email: form.get("email"),
    password: form.get("password"),
  });
  if (!parsed.success) return { error: "Please provide a name, a valid email, and a password." };

  const policyError = passwordPolicyError(parsed.data.password);
  if (policyError) return { error: policyError };

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Generic message: no account enumeration.
  if (existing) {
    await audit({ action: "register_duplicate", detail: { email: parsed.data.email }, ip });
    return { error: "Could not create the account with the provided details." };
  }

  const user = await prisma.user.create({
    data: { name: parsed.data.name, email: parsed.data.email, passwordHash: await hashPassword(parsed.data.password) },
  });
  // No session is created here: the user must sign in to get access.
  await audit({ userId: user.id, action: "register", ip });
  let welcomeSent = false;
  if (emailConfigured()) {
    // sendEmail never throws; awaited so the request is not cut short on serverless hosts.
    const outcome = await sendEmail({
      to: user.email,
      subject: "Welcome to DevSentinel AI",
      text: `Hi ${user.name},\n\nYour DevSentinel AI account is ready. Sign in to connect a repository and start testing pull requests:\n\n${process.env.APP_BASE_URL ?? ""}/login\n\nIf you did not create this account, you can ignore this email.`,
    });
    welcomeSent = outcome.state === "delivered";
  }
  redirect(welcomeSent ? "/login?registered=sent" : "/login?registered=1");
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const ip = await clientIp();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const rl = await rateLimit(`login:${ip}:${email}`, 8, 15 * 60_000);
  if (!rl.ok) return { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` };

  const password = String(form.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    if (user) {
      const rlAccount = await rateLimit(`login-acct:${user.id}`, 10, 15 * 60_000);
      if (!rlAccount.ok) return { error: `Too many attempts. Try again in ${rlAccount.retryAfterSec}s.` };
    }
    await audit({ userId: user?.id, action: "login_failed", detail: { email }, ip });
    return { error: "Invalid email or password." };
  }

  const h = await headers();
  await createSession(user.id, h.get("user-agent") ?? undefined, ip);
  await audit({ userId: user.id, action: "login", ip });
  redirect("/app");
}

export async function logoutAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const user = await getSessionUser();
  if (user) await audit({ userId: user.id, action: "logout" });
  await destroyCurrentSession();
  redirect("/");
}

export async function forgotPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const ip = await clientIp();
  const rl = await rateLimit(`forgot:${ip}`, 5, 15 * 60_000);
  if (!rl.ok) return { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` };

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  let emailed = false;
  if (user) {
    const token = randomToken(32);
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    await audit({ userId: user.id, action: "password_reset_requested", ip });
    if (emailConfigured()) {
      const base = process.env.APP_BASE_URL ?? "";
      const outcome = await sendEmail({
        to: user.email,
        subject: "[DevSentinel] Reset your password",
        text: `A password reset was requested for your DevSentinel AI account. This link is single-use and expires in 60 minutes:\n\n${base}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
      });
      emailed = outcome.state === "delivered";
    }
  }
  // Always the same generic response (no enumeration).
  return emailed
    ? { success: "If that account exists, a reset link has been emailed (check your inbox). The link is single-use and expires in 60 minutes." }
    : { success: "If that account exists, a reset has been initiated. Email delivery is not configured on this server. Please contact your administrator." };
}

export async function resetPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const ip = await clientIp();
  const rl = await rateLimit(`reset:${ip}`, 5, 15 * 60_000);
  if (!rl.ok) return { error: `Too many attempts. Try again in ${rl.retryAfterSec}s.` };

  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const policyError = passwordPolicyError(password);
  if (policyError) return { error: policyError };

  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return { error: "This reset link is invalid, already used, or expired." };
  }
  // Claim the token atomically: two concurrent submissions of the same link
  // must not both rotate the password (single-use contract).
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { error: "This reset link is invalid, already used, or expired." };
  }
  await prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password) } });
  await destroyAllSessions(record.userId); // session invalidation on password change
  await audit({ userId: record.userId, action: "password_reset_completed", ip });
  redirect("/login?reset=1");
}

export async function changePasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  if (!(await verifyPassword(current, user.passwordHash))) return { error: "Current password is incorrect." };
  const policyError = passwordPolicyError(next);
  if (policyError) return { error: policyError };
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(next) } });
  await destroyAllSessions(user.id);
  await audit({ userId: user.id, action: "password_changed" });
  redirect("/login?changed=1");
}

export async function revokeSessionAction(form: FormData) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!(await csrfFromForm(form))) return;
  const sessionId = String(form.get("sessionId") ?? "");
  await prisma.session.deleteMany({ where: { id: sessionId, userId: user.id } });
  await audit({ userId: user.id, action: "session_revoked" });
}

export async function deleteAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  if (String(form.get("confirm") ?? "") !== "DELETE") {
    return { error: 'Type "DELETE" exactly to confirm account deletion.' };
  }
  await destroyAllSessions(user.id);
  await prisma.user.delete({ where: { id: user.id } }); // cascades to projects, runs, etc.
  await destroyCurrentSession();
  redirect("/?deleted=1");
}

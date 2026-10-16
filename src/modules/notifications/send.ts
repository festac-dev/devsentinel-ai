/**
 * In-app notifications with dedup via a unique notification key
 * (event type + entity + state) so retries can never create duplicates.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/modules/notifications/email";

export const NOTIFICATION_TYPES = [
  "test_run_completed",
  "test_run_failed",
  "test_run_error",
  "monitoring_down",
  "monitoring_recovered",
  "incident_opened",
  "incident_resolved",
  "github_integration_failed",
  "testsprite_start_failed",
  "testsprite_verify_result",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export async function notify(input: {
  projectId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  entityRef?: string;
  dedupKey: string;
}) {
  const recipients = input.projectId
    ? await prisma.project.findUnique({ where: { id: input.projectId }, select: { ownerId: true } }).then((p) => (p ? [p.ownerId] : []))
    : [];

  for (const userId of recipients) {
    // Per-user preference check (global defaults only in this build).
    const pref = await prisma.notificationPreference.findFirst({
      where: { userId, eventType: input.type, OR: [{ projectId: input.projectId }, { projectId: null }] },
      orderBy: { projectId: "desc" },
    });
    if (pref && !pref.inApp && !pref.email) continue;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const wantEmail = Boolean(pref?.email && user?.email);

    await prisma.notification
      .create({
        data: {
          userId,
          projectId: input.projectId,
          type: input.type,
          title: input.title,
          body: input.body.slice(0, 1000),
          entityRef: input.entityRef,
          dedupKey: `${input.dedupKey}:${userId}`,
        },
      })
      .catch((err) => {
        // Only a unique-constraint violation is a benign duplicate; anything
        // else (DB down, etc.) must surface — the caller records the failure.
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
      });

    if (wantEmail) {
      // Re-read the row this call owns; a duplicate (catch above) is never re-emailed.
      const created = await prisma.notification.findUnique({ where: { dedupKey: `${input.dedupKey}:${userId}` } });
      if (created && !created.emailedAt) {
        const outcome = await sendEmail({
          to: user!.email,
          subject: `[DevSentinel] ${input.title}`,
          text: input.body.slice(0, 2000),
        });
        await prisma.notification.update({
          where: { id: created.id },
          data:
            outcome.state === "delivered"
              ? { emailStatus: "delivered", emailProviderId: outcome.providerId, emailedAt: new Date() }
              : outcome.state === "failed"
                ? { emailStatus: "failed", emailError: outcome.error, emailedAt: new Date() }
                : { emailStatus: "not_configured" },
        });
      }
    }
  }
}

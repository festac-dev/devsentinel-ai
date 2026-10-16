"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma, withAdvisoryLock } from "@/lib/db";
import { requireOwnedIncident } from "@/lib/ownership";
import { csrfFromForm, CSRF_BLOCKED_MESSAGE } from "@/lib/csrf";
import { rateLimit } from "@/lib/ratelimit";
import { getSessionUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notify, NOTIFICATION_TYPES } from "@/modules/notifications/send";
import { investigate } from "@/modules/investigation/provider";
import type { ActionState } from "@/app/actions/auth";

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  open: ["investigating", "resolved", "closed"],
  investigating: ["identified", "resolved", "closed"],
  identified: ["resolved", "closed"],
  resolved: ["closed", "open"],
  closed: [],
};

export async function transitionIncidentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const incidentId = String(form.get("incidentId") ?? "");
  const incident = await requireOwnedIncident(incidentId);
  const user = await getSessionUser();
  const next = String(form.get("status") ?? "");
  const allowed = ALLOWED_TRANSITIONS[incident.status] ?? [];
  if (!allowed.includes(next)) {
    return { error: `Transition ${incident.status} → ${next} is not allowed. Allowed: ${allowed.join(", ") || "none"}.` };
  }
  const note = String(form.get("note") ?? "").trim().slice(0, 1000);
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      status: next,
      resolvedAt: next === "resolved" ? new Date() : next === "open" ? null : incident.resolvedAt,
      resolutionNotes: next === "resolved" ? note || incident.resolutionNotes : incident.resolutionNotes,
    },
  });
  await prisma.incidentEvent.create({
    data: { incidentId: incident.id, actor: user!.id, type: "status_change", note: `Status set to ${next}${note ? `: ${note}` : ""}` },
  });
  await audit({ userId: user!.id, projectId: incident.projectId, action: "incident_status_changed", detail: { incidentId, from: incident.status, to: next } });
  if (next === "resolved") {
    await notify({
      projectId: incident.projectId,
      type: "incident_resolved",
      title: `Incident resolved: ${incident.title}`,
      body: note || "Resolved with recorded evidence.",
      entityRef: `incident:${incident.id}`,
      dedupKey: `incident_resolved:${incident.id}:${Date.now() - (Date.now() % 3600_000)}`,
    });
  }
  revalidatePath(`/app/incidents/${incident.id}`);
  return { success: `Status updated to ${next}.` };
}

export async function addIncidentNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const incidentId = String(form.get("incidentId") ?? "");
  const incident = await requireOwnedIncident(incidentId);
  const user = await getSessionUser();
  const note = String(form.get("note") ?? "").trim().slice(0, 1000);
  if (!note) return { error: "Note cannot be empty." };
  await prisma.incidentEvent.create({
    data: { incidentId: incident.id, actor: user!.id, type: "note", note },
  });
  revalidatePath(`/app/incidents/${incident.id}`);
  return { success: "Note added." };
}

export async function investigateIncidentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const incidentId = String(form.get("incidentId") ?? "");
  const incident = await requireOwnedIncident(incidentId);
  const user = await getSessionUser();
  const rl = await rateLimit(`investigate:${incident.projectId}`, 5, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };

  const result = await investigate(incident.id);
  if (result.status === "unavailable") {
    return { error: result.reason };
  }
  if (result.status === "rejected") {
    const record = await prisma.investigation.create({
      data: { incidentId: incident.id, userId: user!.id, provider: "ai", model: result.model, status: "rejected" },
    });
    void record;
    return { error: `AI output rejected and not displayed: ${result.reason}` };
  }

  await prisma.investigation.create({
    data: {
      incidentId: incident.id,
      userId: user!.id,
      provider: "ai",
      model: result.model,
      status: "completed",
      sections: JSON.stringify(result.sections),
      evidenceSnapshot: JSON.stringify(result.evidenceSnapshot),
    },
  });
  revalidatePath(`/app/incidents/${incident.id}`);
  return { success: "Investigation completed and stored." };
}

export async function markNotificationReadAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const user = await getSessionUser();
  if (!user) return;
  const id = String(form.get("id") ?? "");
  await prisma.notification.updateMany({ where: { id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/app/notifications");
}

export async function markAllNotificationsReadAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const user = await getSessionUser();
  if (!user) return;
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  revalidatePath("/app/notifications");
}

/** Global (per-user, all-projects) notification preferences. */
export async function saveNotificationPrefsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // Serialize the whole save: global defaults have projectId = null, and SQL
  // unique indexes treat NULLs as distinct, so concurrent saves could create
  // duplicate rows that no constraint would prevent.
  await withAdvisoryLock(`notification-prefs:${user.id}`, async (tx) => {
    for (const eventType of NOTIFICATION_TYPES) {
      const values = {
        inApp: form.get(`inApp:${eventType}`) === "on",
        email: form.get(`email:${eventType}`) === "on",
      };
      const existing = await tx.notificationPreference.findFirst({
        where: { userId: user.id, projectId: null, eventType },
      });
      if (existing) {
        await tx.notificationPreference.update({ where: { id: existing.id }, data: values });
      } else {
        await tx.notificationPreference.create({
          data: { userId: user.id, projectId: null, eventType, ...values },
        });
      }
    }
  });
  await audit({ userId: user.id, action: "notification_preferences_updated" });
  revalidatePath("/app/notifications");
  return { success: "Notification preferences saved." };
}

import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmptyState, Time, Card, Badge } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import {
  markNotificationReadAction,
  markAllNotificationsReadAction,
  saveNotificationPrefsAction,
} from "@/app/actions/incidents";
import { NOTIFICATION_TYPES } from "@/modules/notifications/send";
import { emailConfigured } from "@/modules/notifications/email";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const unread = notifications.filter((n) => !n.readAt).length;
  const prefs = await prisma.notificationPreference.findMany({ where: { userId: user.id, projectId: null } });
  const prefByType = new Map(prefs.map((p) => [p.eventType, p]));
  const emailOn = emailConfigured();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-slate-500 dark:text-slate-400">
            {unread} unread of {notifications.length} shown.
            {emailOn && " Email delivery is configured; per-event email toggles are below."}
          </p>
        </div>
        {unread > 0 && (
          <form action={markAllNotificationsReadAction}>
            <button type="submit" className="rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
              Mark all as read
            </button>
          </form>
        )}
      </div>

      {notifications.length === 0 ? (
        <EmptyState title="No notifications">You will see test results, monitoring alerts, and incident updates here.</EmptyState>
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <Card key={n.id} className={n.readAt ? "opacity-70" : ""}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{n.title}{!n.readAt && <span className="ml-2 inline-flex h-2 w-2 rounded-full bg-rose-600" aria-label="unread" />}</p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{n.body}</p>
                  <p className="text-xs text-slate-400">
                    <Time date={n.createdAt} /> · {n.type}
                    {n.emailStatus === "delivered" && <> · <Badge status="published">emailed</Badge></>}
                    {n.emailStatus === "failed" && <> · <Badge status="failed">email failed</Badge></>}
                    {n.emailStatus === "not_configured" && <> · email not configured</>}
                  </p>
                </div>
                {!n.readAt && (
                  <form action={markNotificationReadAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <button type="submit" className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Mark as read</button>
                  </form>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Preferences (all projects)</h2>
        <Card>
          <FormShell action={saveNotificationPrefsAction} submitLabel="Save preferences">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 dark:text-slate-400">
                  <th scope="col" className="py-1 font-medium">Event</th>
                  <th scope="col" className="py-1 font-medium">In-app</th>
                  <th scope="col" className="py-1 font-medium">Email{!emailOn && " (not configured)"}</th>
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_TYPES.map((t) => (
                  <tr key={t} className="border-t border-slate-100 dark:border-slate-900">
                    <td className="py-1.5 font-mono text-xs">{t}</td>
                    <td className="py-1.5">
                      <input type="checkbox" name={`inApp:${t}`} defaultChecked={prefByType.get(t)?.inApp ?? true} aria-label={`In-app for ${t}`} />
                    </td>
                    <td className="py-1.5">
                      <input type="checkbox" name={`email:${t}`} defaultChecked={prefByType.get(t)?.email ?? false} disabled={!emailOn} aria-label={`Email for ${t}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </FormShell>
        </Card>
      </section>
    </div>
  );
}

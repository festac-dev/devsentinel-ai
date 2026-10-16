import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, Time, SectionTitle } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import { SystemStatus } from "@/components/system-status";
import { changePasswordAction, deleteAccountAction, revokeSessionAction } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  const sessions = await prisma.session.findMany({ where: { userId: user.id }, orderBy: { lastSeenAt: "desc" } });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-slate-500 dark:text-slate-400">Account: {user.email} (created <Time date={user.createdAt} />)</p>
      </div>

      <section>
        <SectionTitle action={<Link href="/app/integrations" className="text-sm underline">Full integration details</Link>}>
          System status
        </SectionTitle>
        <SystemStatus />
      </section>

      <section>
        <SectionTitle>Change password</SectionTitle>
        <Card>
          <FormShell action={changePasswordAction} submitLabel="Change password">
            <label htmlFor="current" className="block text-sm font-medium">Current password</label>
            <input id="current" name="current" type="password" required autoComplete="current-password"
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
            <label htmlFor="next" className="block text-sm font-medium">New password (10+ chars, mixed case, digit)</label>
            <input id="next" name="next" type="password" required autoComplete="new-password"
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
          </FormShell>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">Changing the password invalidates all sessions, including this one.</p>
        </Card>
      </section>

      <section>
        <SectionTitle>Active sessions</SectionTitle>
        <Card>
          <ul className="space-y-2 text-sm">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-900 pb-2">
                <span>
                  {s.userAgent ? s.userAgent.slice(0, 60) : "Unknown client"} · last seen <Time date={s.lastSeenAt} /> · expires <Time date={s.expiresAt} />
                  {s.ip && <> · IP <span className="font-mono text-xs">{s.ip}</span></>}
                </span>
                <form action={revokeSessionAction}>
                  <input type="hidden" name="sessionId" value={s.id} />
                  <button type="submit" className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">Revoke</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section>
        <SectionTitle>Delete account</SectionTitle>
        <Card className="border-rose-300 dark:border-rose-900">
          <FormShell action={deleteAccountAction} submitLabel="Delete account permanently" danger>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Deletes your account and every project, run, incident, and notification you own. This cannot be undone.
            </p>
            <label htmlFor="confirm" className="block text-sm font-medium">Type DELETE to confirm</label>
            <input id="confirm" name="confirm" required
              className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
          </FormShell>
        </Card>
      </section>

      <section>
        <SectionTitle>Audit trail (recent)</SectionTitle>
        <Card>
          <AuditList userId={user.id} />
        </Card>
      </section>
    </div>
  );
}

async function AuditList({ userId }: { userId: string }) {
  const events = await prisma.auditEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 });
  if (events.length === 0) return <p className="text-sm text-slate-500 dark:text-slate-400">No audit events yet.</p>;
  return (
    <ul className="text-sm space-y-1">
      {events.map((e) => (
        <li key={e.id}>
          <Time date={e.createdAt} /> · <Badge status="unknown">{e.action}</Badge>
          {e.detail && <span className="text-slate-500 dark:text-slate-400"> {e.detail.slice(0, 120)}</span>}
        </li>
      ))}
    </ul>
  );
}

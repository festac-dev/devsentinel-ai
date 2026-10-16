import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmptyState, Badge, Time, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function IncidentsPage() {
  const user = await requireUser();
  const incidents = await prisma.incident.findMany({
    where: { project: { ownerId: user.id } },
    orderBy: [{ status: "asc" }, { openedAt: "desc" }],
    include: { project: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Incidents</h1>
        <p className="text-slate-500 dark:text-slate-400">
          Created from verified events only: monitoring threshold breaches and test-run failures on a PR&apos;s current head. Duplicates are folded into the same incident by fingerprint.
        </p>
      </div>

      {incidents.length === 0 ? (
        <EmptyState title="No incidents">Incidents appear when monitoring targets breach their failure threshold or a run fails on the current head.</EmptyState>
      ) : (
        <div className="space-y-2">
          {incidents.map((i) => (
            <Link key={i.id} href={`/app/incidents/${i.id}`} className="block">
              <Card className="hover:bg-slate-50 dark:hover:bg-slate-900 focus-within:outline-none focus-within:ring-2 focus-within:ring-sky-500">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{i.title}</p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {i.project.name} · {i.sourceType} · opened <Time date={i.openedAt} />
                      {i.resolvedAt && <> · resolved <Time date={i.resolvedAt} /></>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Badge status={i.severity}>{i.severity}</Badge>
                    <Badge status={i.status}>{i.status}</Badge>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Card, Badge, Time, SectionTitle } from "@/components/ui";
import { FormShell } from "@/components/form-shell";
import { transitionIncidentAction, addIncidentNoteAction, investigateIncidentAction } from "@/app/actions/incidents";
import { aiConfigured } from "@/modules/investigation/provider";

export const dynamic = "force-dynamic";

const TRANSITIONS: Record<string, string[]> = {
  open: ["investigating", "resolved", "closed"],
  investigating: ["identified", "resolved", "closed"],
  identified: ["resolved", "closed"],
  resolved: ["closed", "open"],
  closed: [],
};

const inputCls = "w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) notFound();
  const incident = await prisma.incident.findFirst({
    where: { id: id, project: { ownerId: user.id } },
    include: { project: true, events: { orderBy: { createdAt: "asc" } }, investigations: { orderBy: { createdAt: "desc" } } },
  });
  if (!incident) notFound();

  let evidence: Array<{ kind: string; id?: string; commitSha?: string; url?: string; outcome?: string; errorClass?: string }> = [];
  try {
    evidence = incident.evidence ? JSON.parse(incident.evidence) : [];
  } catch {
    evidence = [];
  }

  const latestInvestigation = incident.investigations.find((i) => i.status === "completed" && i.sections);

  return (
    <div className="space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{incident.title}</h1>
          <Badge status={incident.severity}>{incident.severity}</Badge>
          <Badge status={incident.status}>{incident.status}</Badge>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {incident.project.name} · {incident.sourceType} · opened <Time date={incident.openedAt} /> · updated <Time date={incident.updatedAt} />
          {incident.resolvedAt && <> · resolved <Time date={incident.resolvedAt} /></>}
        </p>
      </div>

      <section>
        <SectionTitle>Evidence</SectionTitle>
        <Card>
          <ul className="text-sm space-y-1 list-disc pl-5">
            {evidence.map((e, idx) => (
              <li key={idx}>
                {e.kind}
                {e.id && <> <span className="font-mono text-xs">{e.id}</span></>}
                {e.commitSha && <> · commit <span className="font-mono text-xs">{e.commitSha.slice(0, 12)}</span></>}
                {e.url && <> · <span className="font-mono text-xs">{e.url}</span></>}
                {e.outcome && <> · outcome {e.outcome}</>}
                {e.errorClass && <> · class <span className="text-rose-600 dark:text-rose-400">{e.errorClass}</span></>}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section>
        <SectionTitle>Timeline</SectionTitle>
        <Card>
          <ol className="space-y-2 text-sm">
            {incident.events.map((ev) => (
              <li key={ev.id}>
                <span className="text-slate-500 dark:text-slate-400"><Time date={ev.createdAt} /> · {ev.type}</span>
                {ev.note && <p>{ev.note}</p>}
              </li>
            ))}
          </ol>
          <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-4">
            <FormShell action={addIncidentNoteAction} submitLabel="Add note">
              <input type="hidden" name="incidentId" value={incident.id} />
              <label htmlFor="note" className="block text-sm font-medium">Add a note to the timeline</label>
              <textarea id="note" name="note" rows={2} maxLength={1000} className={inputCls} />
            </FormShell>
          </div>
        </Card>
      </section>

      <section>
        <SectionTitle>Change status</SectionTitle>
        <Card>
          <FormShell action={transitionIncidentAction} submitLabel="Apply transition">
            <input type="hidden" name="incidentId" value={incident.id} />
            <label htmlFor="status" className="block text-sm font-medium">
              Allowed transitions from <strong>{incident.status}</strong>: {TRANSITIONS[incident.status]?.join(", ") || "none (closed is final)"}
            </label>
            <select id="status" name="status" className={`${inputCls} max-w-xs`}>
              {(TRANSITIONS[incident.status] ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label htmlFor="tnote" className="block text-sm font-medium">Note (required when resolving)</label>
            <textarea id="tnote" name="note" rows={2} maxLength={1000} className={inputCls} />
          </FormShell>
        </Card>
      </section>

      <section>
        <SectionTitle>AI investigation</SectionTitle>
        <Card>
          {!aiConfigured() && (
            <p role="note" className="text-sm text-slate-500 dark:text-slate-400 mb-3">
              AI investigation unavailable — provider not configured. Set AI_PROVIDER_API_KEY and AI_PROVIDER_MODEL to enable it.
            </p>
          )}
          {aiConfigured() && (
            <FormShell action={investigateIncidentAction} submitLabel="Investigate with AI">
              <input type="hidden" name="incidentId" value={incident.id} />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Sends a redacted evidence snapshot (incident, timeline, recent runs and checks) to the configured provider.
                Each fact must cite recorded evidence; output that does not is rejected.
              </p>
            </FormShell>
          )}

          {latestInvestigation?.sections && (() => {
            let sections: { confirmedFacts: Array<{ text: string; evidenceRef: string }>; possibleCause: string[]; unknown: string[]; recommendedAction: string[] };
            try {
              sections = JSON.parse(latestInvestigation.sections);
            } catch {
              return null;
            }
            return (
              <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-4 space-y-4 text-sm">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Investigation by {latestInvestigation.provider} ({latestInvestigation.model ?? "unknown model"}) at <Time date={latestInvestigation.createdAt} />. Hypotheses are unproven; recommendations become “verified” only after a later real run or check confirms them.
                </p>
                <div>
                  <h3 className="font-semibold">Confirmed facts</h3>
                  <ul className="list-disc pl-5">
                    {sections.confirmedFacts.map((f, i) => (
                      <li key={i}>{f.text} <span className="text-xs font-mono text-slate-500 dark:text-slate-400">[{f.evidenceRef}]</span></li>
                    ))}
                  </ul>
                </div>
                <div><h3 className="font-semibold">Possible cause (unproven)</h3><ul className="list-disc pl-5">{sections.possibleCause.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                <div><h3 className="font-semibold">Unknown</h3><ul className="list-disc pl-5">{sections.unknown.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                <div><h3 className="font-semibold">Recommended action</h3><ul className="list-disc pl-5">{sections.recommendedAction.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
              </div>
            );
          })()}
        </Card>
      </section>
    </div>
  );
}

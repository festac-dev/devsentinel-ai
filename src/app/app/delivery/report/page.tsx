import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getDeliverySnapshot } from "@/modules/delivery/service";
import {
  buildDeliveryReport,
  evaluateSubmissionReadiness,
  overallStats,
  sourceRevisionFromEnv,
} from "@/modules/delivery/model";
import { Card, SectionTitle } from "@/components/ui";
import { ProgressBar } from "@/components/delivery/progress";
import { ReadinessBadge } from "@/components/delivery/status";
import { PrintButton } from "@/components/print-button";

export const dynamic = "force-dynamic";

export default async function DeliveryReportPage() {
  const user = await requireUser();
  const snapshot = await getDeliverySnapshot(user.id);
  const generatedAt = new Date();
  const sourceRevision = sourceRevisionFromEnv();
  const report = buildDeliveryReport(snapshot, { generatedAt, sourceRevision });
  const readiness = evaluateSubmissionReadiness(snapshot);
  const stats = overallStats(snapshot);

  return (
    <div className="space-y-8">
      <header>
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link href="/app/delivery" className="underline">
            Delivery Tracker
          </Link>{" "}
          <span aria-hidden="true">/</span> <span>Project report</span>
        </nav>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Delivery and verification report</h1>
            <p className="mt-1 text-slate-500 dark:text-slate-400">
              Generated from the current database state. Reported completion and evidence verification are reported
              separately.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ReadinessBadge ready={readiness.ready} />
            <a
              href="/api/delivery/report"
              className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              Download Markdown
            </a>
            <PrintButton />
          </div>
        </div>
      </header>

      <section aria-labelledby="report-summary">
        <SectionTitle>
          <span id="report-summary">Current record summary</span>
        </SectionTitle>
        <Card>
          <div className="grid gap-6 sm:grid-cols-2">
            <ProgressBar
              value={stats.completionPercent}
              label={`Reported completion (${stats.completed} of ${stats.total})`}
            />
            <ProgressBar
              value={stats.verificationPercent}
              label={`Evidence verified (${stats.verified} of ${stats.total})`}
              tone="verified"
            />
          </div>
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            Source revision: <span className="font-mono">{sourceRevision ?? "not recorded in this environment"}</span>{" "}
            · Generated at <time dateTime={generatedAt.toISOString()}>{generatedAt.toISOString()}</time>
          </p>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            The download route regenerates the report at request time, so it can differ from this preview if records
            change. External URLs and CI/provider references are not re-fetched.
          </p>
        </Card>
      </section>

      <section aria-labelledby="report-content">
        <SectionTitle>
          <span id="report-content">Report</span>
        </SectionTitle>
        <Card className="print:border-0 print:p-0">
          <pre className="max-h-[75vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-4 text-sm leading-6 text-slate-800 dark:bg-slate-950 dark:text-slate-200 print:max-h-none print:overflow-visible print:bg-white print:text-black">
            {report}
          </pre>
        </Card>
      </section>
    </div>
  );
}

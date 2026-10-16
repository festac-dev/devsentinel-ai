import Link from "next/link";
import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-lg font-semibold">{children}</h2>
      {action}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  passed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  healthy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  success: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
  down: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
  error: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
  open: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
  degraded: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  investigating: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  identified: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  queued: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  running: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  unknown: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  closed: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  not_configured: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  skipped_stale: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  unconfigured: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function Badge({ status, tooltip, children }: { status: string; tooltip?: string; children?: ReactNode }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.unknown;
  return (
    <span title={tooltip} className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium capitalize ${style}`}>
      {children ?? status.replace(/_/g, " ")}
    </span>
  );
}

const SOURCE_STYLES: Record<string, string> = {
  testsprite: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-300",
  local: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  demo: "bg-orange-100 text-orange-900 dark:bg-orange-900/50 dark:text-orange-300",
};

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${SOURCE_STYLES[source] ?? SOURCE_STYLES.demo}`}>
      {source === "testsprite" ? "TestSprite execution" : source === "local" ? "Local automated" : "Simulated demonstration"}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
      <p className="font-medium text-slate-700 dark:text-slate-300">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-500 dark:text-slate-400">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300 p-4 text-sm">
      {children}
    </div>
  );
}

export function StaleBadge({ runSha, headSha }: { runSha: string; headSha: string }) {
  return (
    <span title={`Tested commit ${runSha.slice(0, 7)}; current head is ${headSha.slice(0, 7)}`} className="inline-flex items-center rounded bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-300 px-2 py-0.5 text-xs font-medium">
      Stale
    </span>
  );
}

export function Time({ date }: { date: Date | null }) {
  if (!date) return <span className="text-slate-400">—</span>;
  return <time dateTime={date.toISOString()}>{date.toISOString().replace("T", " ").slice(0, 16)} UTC</time>;
}

export function ShortSha({ sha }: { sha: string }) {
  return (
    <a
      href={`https://github.com/search?q=${sha}&type=commits`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs underline decoration-dotted"
    >
      {sha.slice(0, 7)}
    </a>
  );
}

export function LinkButton({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  const cls =
    variant === "primary"
      ? "bg-slate-900 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
      : "border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800";
  return (
    <Link href={href} className={`inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${cls}`}>
      {children}
    </Link>
  );
}

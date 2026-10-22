export function ProgressBar({
  value,
  label,
  tone = "reported",
}: {
  value: number;
  label: string;
  tone?: "reported" | "verified";
}) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  const bar = tone === "verified" ? "bg-emerald-600 dark:bg-emerald-400" : "bg-indigo-600 dark:bg-indigo-400";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="font-semibold tabular-nums">{clamped}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
      >
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

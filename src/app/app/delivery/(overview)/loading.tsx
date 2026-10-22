export default function DeliveryLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading delivery tracker…</span>
      <div className="h-8 w-64 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
      <div className="rounded-lg border border-slate-200 p-5 dark:border-slate-800">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="h-8 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="h-8 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-20 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-56 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
        ))}
      </div>
    </div>
  );
}

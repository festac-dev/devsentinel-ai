"use client";

export default function DeliveryError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Delivery Tracker could not load</h1>
      <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
        The tracker request failed. No status or verification data was changed. Try again; if the failure persists,
        check the application logs and database connectivity.
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        Try again
      </button>
    </div>
  );
}

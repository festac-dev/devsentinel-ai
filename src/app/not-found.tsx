import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="text-sm uppercase tracking-wide text-slate-500 dark:text-slate-400">404</p>
        <h1 className="text-3xl font-bold mt-2 mb-4">Page not found</h1>
        <p className="text-slate-600 dark:text-slate-400 mb-8">
          The page you requested does not exist. If you followed a link from the app, the resource may have been deleted or belongs to another account.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link href="/" className="rounded-md bg-slate-900 px-5 py-2.5 font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
            Go home
          </Link>
          <Link href="/login" className="rounded-md border border-slate-300 dark:border-slate-700 px-5 py-2.5 font-medium hover:bg-slate-100 dark:hover:bg-slate-800">
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}

import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Nav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const unread = await prisma.notification.count({ where: { userId: user.id, readAt: null } });

  return (
    <div className="min-h-screen lg:flex">
      <Nav user={{ name: user.name, email: user.email }} unreadCount={unread} />
      <div className="flex-1 min-w-0">
        <header className="lg:hidden sticky top-0 z-40 border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur px-4 py-3 flex items-center justify-between">
          <Link href="/app" className="font-semibold">DevSentinel</Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/app/notifications"
              aria-label={`Notifications, ${unread} unread`}
              className="relative inline-flex h-[34px] w-[34px] items-center justify-center rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              {unread > 0 && (
                <span aria-hidden="true" className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-rose-600 ring-2 ring-white dark:ring-slate-950" />
              )}
            </Link>
          </div>
        </header>
        <main id="main" className="max-w-6xl mx-auto px-4 py-6">{children}</main>
      </div>
    </div>
  );
}

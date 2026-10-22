"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { logoutAction } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/theme-toggle";

const ITEMS = [
  { href: "/app", label: "Overview" },
  { href: "/app/delivery", label: "Delivery Tracker" },
  { href: "/app/projects", label: "Projects" },
  { href: "/app/pull-requests", label: "Pull Requests" },
  { href: "/app/runs", label: "Test Runs" },
  { href: "/app/deployments", label: "Deployments" },
  { href: "/app/incidents", label: "Incidents" },
  { href: "/app/monitoring", label: "Monitoring" },
  { href: "/app/notifications", label: "Notifications" },
  { href: "/app/integrations", label: "Integrations" },
  { href: "/app/settings", label: "Settings" },
];

export function Nav({ user, unreadCount }: { user: { name: string; email: string }; unreadCount: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = (
    <nav aria-label="Main" className="space-y-1">
      {ITEMS.map((item) => {
        const active = item.href === "/app" ? pathname === "/app" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={`block rounded-md px-3 py-2 text-sm ${
              active
                ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-medium"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            } focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500`}
          >
            {item.label}
            {item.href === "/app/notifications" && unreadCount > 0 && (
              <span className="float-right inline-flex min-w-5 justify-center rounded-full bg-rose-600 px-1.5 text-xs font-semibold text-white">{unreadCount}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <>
      <button
        className="lg:hidden fixed bottom-4 right-4 z-50 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-3 text-sm font-medium shadow-lg"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="sidebar"
      >
        {open ? "Close" : "Menu"}
      </button>
      <aside
        id="sidebar"
        className={`${
          open ? "fixed inset-0 z-40 bg-white dark:bg-slate-950 p-4 pt-16" : "hidden"
        } lg:static lg:block lg:w-60 lg:shrink-0 border-r border-slate-200 dark:border-slate-800 p-4`}
      >
        <div className="hidden lg:block mb-6">
          <Link href="/app" className="font-semibold">DevSentinel AI</Link>
        </div>
        {links}
        <div className="mt-8 border-t border-slate-200 dark:border-slate-800 pt-4 text-sm">
          <p className="font-medium truncate" title={user.email}>{user.name}</p>
          <p className="text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
          <div className="mt-2 flex items-center gap-3">
            <ThemeToggle />
            <form action={logoutAction}>
              <button type="submit" className="text-sm underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}

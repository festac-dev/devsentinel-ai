"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

const NAV_MIN_WIDTH = 680;

const SECTION_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#workflow", label: "How it works" },
  { href: "#security", label: "Security" },
  { href: "#faq", label: "FAQ" },
];

/**
 * Landing page header.
 * - 680px and up: the original inline row of links, unchanged. The row needs
 *   ~665px to sit on one line, so 680px is the smallest width where it is safe.
 * - below 680px: brand + theme toggle + menu button; the links and CTAs live in a
 *   dropdown so the row can never be wider than the screen.
 * Keep NAV_MIN_WIDTH in sync with the `min-[680px]:` classes below (Tailwind
 * needs the full class names written out, so they can't be built from the constant).
 */
export function LandingHeader() {
  const [open, setOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // While the menu is open: Escape closes it (and returns focus to the button),
  // tapping outside closes it, and growing past the desktop breakpoint closes it.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setOpen(false);
    }
    const desktop = window.matchMedia(`(min-width: ${NAV_MIN_WIDTH}px)`);
    function onBreakpointChange(e: MediaQueryListEvent) {
      if (e.matches) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    desktop.addEventListener("change", onBreakpointChange);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      desktop.removeEventListener("change", onBreakpointChange);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header ref={headerRef} className="relative border-b border-slate-200 dark:border-slate-800">
      <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
        <span className="font-semibold whitespace-nowrap">DevSentinel AI</span>

        {/* 680px and up: unchanged inline navigation */}
        <nav aria-label="Main" className="hidden min-[680px]:flex items-center gap-4 text-sm">
          {SECTION_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="hover:underline">{l.label}</a>
          ))}
          <Link href="/login" className="hover:underline">Sign in</Link>
          <Link href="/register" className="rounded-md bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">Get Started</Link>
          <ThemeToggle />
        </nav>

        {/* below 680px: compact controls */}
        <div className="flex items-center gap-2 min-[680px]:hidden">
          <ThemeToggle iconOnly className="min-h-10 min-w-10 justify-center" />
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
              {open ? (
                <path d="M4 4l10 10M14 4L4 14" />
              ) : (
                <path d="M2.5 5h13M2.5 9h13M2.5 13h13" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {open && (
        <div
          id="landing-menu"
          className="min-[680px]:hidden absolute inset-x-0 top-full z-40 border-b border-slate-200 bg-white shadow-lg dark:border-slate-800 dark:bg-slate-950"
        >
          <nav aria-label="Main" className="max-w-6xl mx-auto px-4">
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {SECTION_LINKS.map((l) => (
                <li key={l.href}>
                  <a
                    href={l.href}
                    onClick={close}
                    className="block py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-200 py-4 dark:border-slate-800">
              <Link
                href="/login"
                onClick={close}
                className="rounded-md border border-slate-300 px-4 py-2.5 text-center font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                onClick={close}
                className="rounded-md bg-slate-900 px-4 py-2.5 text-center font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
              >
                Get Started
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

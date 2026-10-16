"use client";

import { useSyncExternalStore } from "react";

/** Subscribe to <html> class changes so the toggle always reflects the real theme. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
function isDark() {
  return document.documentElement.classList.contains("dark");
}

/** Light/dark theme toggle (spec 5: dark and light themes). Persists to localStorage. */
export function ThemeToggle({ className = "", iconOnly = false }: { className?: string; iconOnly?: boolean }) {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);

  function toggle() {
    const next = !isDark();
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("ds-theme", next ? "dark" : "light");
    } catch {
      // storage unavailable (private mode); theme still applies for this session
    }
  }

  const label = dark ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={dark}
      title={label}
      className={`inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${className}`}
    >
      <span aria-hidden="true">{dark ? "☀" : "☾"}</span>
      <span className={iconOnly ? "sr-only" : undefined}>{dark ? "Light" : "Dark"}</span>
    </button>
  );
}

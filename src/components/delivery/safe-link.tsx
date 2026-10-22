import type { ReactNode } from "react";
import { validateMonitorUrl } from "@/modules/monitoring/ssrf";

/**
 * Render an external reference only when it passes the same URL policy used by
 * monitoring. This never fetches the URL; it prevents unsafe schemes,
 * credentials, internal hosts, and unexpected ports from becoming links.
 */
export function SafeExternalLink({ href, children }: { href: string | null; children?: ReactNode }) {
  if (!href) return <span className="text-slate-400">Not recorded</span>;
  const checked = validateMonitorUrl(href);
  if (!checked.ok) {
    return <span className="text-slate-500 dark:text-slate-400">Reference withheld: invalid or unsafe URL</span>;
  }
  return (
    <a
      href={checked.url.toString()}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-dotted break-all focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {children ?? checked.url.toString()}
    </a>
  );
}

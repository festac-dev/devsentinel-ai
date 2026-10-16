import { headers } from "next/headers";

/**
 * CSRF protection for cookie-authenticated mutations: cross-site form posts are
 * rejected by checking that the Origin matches the request host (browsers send
 * Origin on all mutating requests), falling back to Sec-Fetch-Site when Origin
 * is absent. Combined with SameSite=Lax session cookies this blocks
 * cross-site request forgery without inline tokens.
 *
 * Behind a reverse proxy the public host arrives in X-Forwarded-Host (the
 * Host header may be an internal name), so the forwarded value is preferred
 * when the platform provides it.
 */

/** Single user-facing message for a rejected mutation (origin/site check, not a token). */
export const CSRF_BLOCKED_MESSAGE = "Request blocked: this submission did not come from this site. Reload the page and try again.";

export async function verifyCsrf(): Promise<boolean> {
  const h = await headers();
  const forwardedHost = h.get("x-forwarded-host");
  const host = forwardedHost?.split(",")[0]?.trim() || h.get("host");
  const origin = h.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = h.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** Server-action helper (same check for form posts). */
export async function csrfFromForm(_form: FormData): Promise<boolean> {
  return verifyCsrf();
}

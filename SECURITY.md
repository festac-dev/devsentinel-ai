# Security Policy

## Reporting a vulnerability

Report security issues to the maintainers via a GitHub security advisory on this
repository ("Report a vulnerability"). Do not open public issues for exploitable bugs.
Please include reproduction steps and affected areas. You can expect an initial response
within 7 days.

## Security posture (what is implemented)

- **Authentication**: scrypt password hashing (N=16384, per-user salt), httpOnly +
  SameSite=Lax + Secure-in-production session cookies, 12 h idle / 7 d absolute session
  timeouts, session list with revoke, session invalidation on password change.
- **Authorization**: centralized `requireProjectAccess` / `requireOwnedRun` /
  `requireOwnedIncident`; resources belonging to other users return **404**, never 403.
  Server actions and API handlers check ownership server-side.
- **CSRF**: mutating server actions verify the request Origin against the request host
  (browsers always send Origin on mutations), with Sec-Fetch-Site as a fallback;
  session cookies are SameSite=Lax, blocking cross-site form forgery.
- **Rate limiting**: sliding-window limits on login, registration, reset, webhook
  deliveries, run triggers, verification, and AI investigations.
- **Webhooks**: HMAC-SHA256 over the raw body, constant-time compared **before** JSON
  parsing; delivery-ID deduplication with a persisted delivery log; size and content-type
  checks; 1 MB body cap.
- **Secrets**: integration credentials encrypted with AES-256-GCM (key from
  `ENCRYPTION_KEY`, versioned for rotation); write-only in the UI (last four characters
  at most); central `redact()` applied to stored run output and error paths; secrets are
  never sent to the browser.
- **SSRF protection** for monitoring: http/https only, credential-free URLs, port
  allowlist (80, 443, 8080, 8443), DNS resolved and validated against
  loopback/private/CGNAT/link-local/multicast/reserved ranges (including IPv4-mapped
  IPv6 and decimal/octal/hex encodings), connection pinned to the validated IP,
  redirects revalidated (max 4), response-body cap, no cookies forwarded.
- **Run binding integrity**: runs are created once with their commit SHA and are never
  updated to a different SHA — enforced in application code and, on PostgreSQL
  (ADR-010), by a database trigger (`test_run_commit_binding`) that rejects any
  UPDATE changing `repoOwner`/`repoName`/`commitSha`; statuses are published only
  after re-reading the PR's current head and only against the run's own SHA.
- **Security headers**: CSP (no inline scripts in production), X-Content-Type-Options,
  Referrer-Policy, Permissions-Policy, frame-ancestors 'none', HSTS in production.

## Known limitations (honest)

- **Dependency advisories (as of build date)**: `npm audit --omit=dev` reports
  **0 vulnerabilities** (Next.js 16.4, React 19, Prisma 6.12). The dev-only audit
  shows a brace-glob stack-exhaustion advisory reachable only from the Tailwind 3
  build toolchain (not shipped to production); closing it requires a Tailwind 4
  migration, tracked as follow-up work.
- The rate limiter is database-backed (a shared `RateLimitWindow` table), so
  limits hold across web instances. Windows are fixed-length; bursts at a
  window boundary can admit up to 2x the limit briefly.
- Email delivery (notifications and password-reset links) uses a provider HTTP API
  (Brevo by default, Resend optional via `EMAIL_PROVIDER`). Without `EMAIL_PROVIDER_API_KEY`/`EMAIL_PROVIDER_FROM`
  the channel reports `not_configured` honestly: reset links are never displayed or
  logged, and an operator must retrieve tokens from the database. Configure a provider
  before relying on email flows.
- There is no account enumeration protection issue: reset/login responses are generic,
  but login rate limiting is keyed partly by email, which leaks nothing beyond timing.
- Monitoring checks run from the worker process; network-layer egress restrictions
  (firewalling the worker) are recommended defense-in-depth and are not configurable
  from the app.
- No CSP nonces are used; the policy is origin-based. Inline `<script>` is disallowed,
  which is verified by the build (Next injects no inline scripts in production).

## Scope

DevSentinel AI is a hackathon project. It implements real defenses, but no software is
absolutely secure. Do not deploy it with production secrets without reviewing the
limitations above.

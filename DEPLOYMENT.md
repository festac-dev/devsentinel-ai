# DEPLOYMENT.md — deploy DevSentinel AI on any platform

One codebase, one database engine (PostgreSQL), one Docker image. Every
platform difference is **configuration** (`APP_ROLE` + environment variables),
never a code fork.

```
Pick your path:

  Vercel for the web tier + any container host for the worker   → deploy/vercel/
  One container host (Railway / Render / Fly) with managed PG   → deploy/single-container/
  Any VPS with Docker Compose                                   → deploy/vps-compose/
  Bare VPS without Docker (systemd/pm2 + nginx/Caddy)           → deploy/bare-vps/
```

## The five invariants (true on every path)

1. **PostgreSQL everywhere.** `DATABASE_URL` is the pooled connection the app
   queries with; `DIRECT_URL` is the direct connection migrations use. Without
   a pooler, set both to the same URL. Size the pool explicitly on busy
   deployments: Prisma's default is `num_cpus * 2 + 1` connections per
   process, which can starve a worker running `WORKER_CONCURRENCY` up to 16
   on a small container (symptom: 10 s `pool_timeout` job failures). Append
   `?connection_limit=N` to `DATABASE_URL` with `N` ≥ `WORKER_CONCURRENCY + 4`
   for `APP_ROLE=worker/all`.
2. **Role by env.** `APP_ROLE=web` (UI + API + webhook, never the worker, never
   CLI processes), `APP_ROLE=worker` (queue consumer, TestSprite CLI runs,
   monitoring checks, notifications, retention — no inbound port),
   `APP_ROLE=all` (both in one process; single-container hosts and local dev).
   Web and worker coordinate **only** through the PostgreSQL-backed queue.
3. **Stateless by default.** No local disk, no in-memory sessions (DB-backed),
   DB-backed rate limiting shared across instances, structured JSON logs on
   stdout. Restart-safe at any time.
4. **Configuration is environment variables,** validated at startup with
   clear, secret-free errors (`.env.example` documents every variable, who sets
   it, and whether a restart is needed). `APP_BASE_URL` is the only public-URL
   setting; proxy headers (`X-Forwarded-*`) are trusted for host/proto. The
   proxy in front of the app must **append** (never overwrite)
   `X-Forwarded-For` — the rightmost entry is treated as the client IP for
   rate limiting, so a proxy that passes the client's own header through
   would let attackers rotate that key — and must **set/override**
   `X-Forwarded-Host` (e.g. nginx `proxy_set_header X-Forwarded-Host $host;`),
   since a pass-through value would be attacker-controlled for the CSRF host
   check.
5. **Migrations are a release step.** `prisma migrate deploy` runs once per
   release (compose `migrate` service, Render `preDeployCommand`, CI job, or a
   manual command) — never on every web boot. CI fails if
   `prisma/schema.prisma` and the versioned migrations drift apart.

## Exact steps (any path)

1. **Provision PostgreSQL.** Keep both pooled and direct URLs if your provider
   distinguishes them.
2. **Migrate (release step).**
   `DATABASE_URL="<direct>" DIRECT_URL="<direct>" npx prisma migrate deploy`
3. **Set environment variables** per `.env.example`, grouped by role. On web
   and worker, `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION` and the database URLs
   must be identical; only `APP_ROLE` and the worker tuning differ.
4. **Deploy** per the chosen recipe in `deploy/`.
5. **Verify:**
   - `curl -f https://<your-url>/api/health` → `{"status":"ok"}` (liveness)
   - `curl -f https://<your-url>/api/health/ready` → `{"status":"ready"}`;
     while no worker heartbeat has been seen recently a web instance reports
     `"status":"degraded"` with `checks.worker: "stale"` (the staleness window
     is max(2 min, 4× `WORKER_POLL_INTERVAL_MS`); APP_ROLE=all degrades too —
     its worker runs in-process, and a dead in-process worker means the queue
     is down)
   - Bad-signature webhook returns **401**:
     `curl -s -o /dev/null -w '%{http_code}' -X POST https://<your-url>/api/webhooks/github -H 'content-type: application/json' -d '{}'`
   - Open the **Integrations** page: "Background worker: running" with a fresh
     heartbeat timestamp (the same heartbeat the readiness endpoint checks).
   - Open **Delivery Tracker**: the four phases and 16 tasks load, reported
     completion and evidence verification are shown separately, and
     `/api/delivery/report` downloads Markdown while signed in (401 when not).
     `20261022023749_delivery_tracker` is additive; no tracker rows are created
     until the first authenticated visit. See
     [`docs/delivery-tracker.md`](./docs/delivery-tracker.md).

## Graceful shutdown

- **web:** SIGTERM stops the HTTP listener (Next.js standalone); Next drains
  in-flight requests and the database pool closes after a short grace window
  (`src/instrumentation.ts`, `src/server-boot.ts`), so draining requests do
  not fail with connection errors. Container platforms kill after their grace
  period.
- **all:** SIGTERM stops the worker from claiming new jobs; in-flight jobs
  finish before the process exits (the shared pool stays connected until
  then). Give it up to 60 s (`TimeoutStopSec=60` in the provided systemd
  unit). A worker that dies *fatally* in this mode is restarted with backoff
  by `src/server-boot.ts` instead of leaving the container with a dead queue.
- **worker:** same SIGTERM contract as all, plus its own pool close
  (`src/worker/loop.ts`).

## Free-domain note

A platform subdomain (`*.vercel.app`, `*.up.railway.app`, `*.onrender.com`,
`*.fly.dev`) is a perfectly good `APP_BASE_URL` — GitHub accepts it for the
webhook, TestSprite accepts it as a test target, and HTTPS is automatic. The
**worker needs no domain and no inbound port at all**; only the web role is
reachable.

## Delivery tracker rollout note

The delivery tracker migration creates new tables and adds optional relations to
`User`; existing projects, runs, incidents, and accounts are untouched. Apply it
with the normal `prisma migrate deploy` step. Initialization is lazy and
idempotent per owner, so no seed command is required. Roll back code in the
usual way; the additive tables can remain in place. Do not drop them while the
current release is serving traffic.

## Rollback

- Code: redeploy the previous image/commit (Vercel: previous deployment;
  compose: `git checkout <tag> && docker compose build && docker compose run --rm migrate && docker compose up -d`).
- Migrations are additive and applied as a separate release step; rolling back
  code does not require rolling back the database. If a migration must be
  undone, restore the database from a backup first.

## Backups

- Managed Postgres: enable automated backups/PITR at the provider.
- Self-hosted: `pg_dump` cron (commands in `deploy/vps-compose/README.md` and
  `deploy/bare-vps/README.md`). The database holds everything (sessions, queue,
  run results); no instance-local state exists to back up.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Invalid configuration: APP_ROLE …` at boot | Set `APP_ROLE` to `web`, `worker`, or `all`. |
| `DATABASE_URL must be a postgres:// …` | The variable is missing or still a `file:` SQLite URL; migrations are Postgres-only. |
| `/api/health/ready` → `database_unreachable` | Wrong URL/password, or Postgres not up yet. Check the database first. |
| `/api/health/ready` → `migrations_not_applied` | The release migration step has not run; execute `npx prisma migrate deploy` with `DIRECT_URL`. |
| Web shows `degraded`, `worker: stale` | No worker heartbeat for 2+ minutes — start the worker service; the web instance itself is fine. |
| Webhook returns 503 `not_configured` | `GITHUB_WEBHOOK_SECRET` is not set on the **web** role. |
| Webhook returns 401 | Signature verification failed — check the webhook secret. |
| Runs stay `queued` | Worker not running (`APP_ROLE=worker`), or its database URL points at a different database than the web's. URLs and `ENCRYPTION_KEY` must match. |
| Verification says "queued" but nothing happens | Same as above — credential verification is performed by the worker (the web role never spawns the CLI). |

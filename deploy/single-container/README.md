# Recipe b — Single container host (Railway / Render / Fly / similar)

`APP_ROLE=all`: one container runs the web app and the worker in-process
(src/instrumentation.ts), pointed at a persistent (managed) PostgreSQL.
Configuration only — no code changes.

## 1. Provision PostgreSQL

Use the platform's managed Postgres (Railway/Render/Fly all provide one) or an
external provider. Railway/Render expose a single connection string → set both
`DATABASE_URL` and `DIRECT_URL` to it. If the provider distinguishes pooled vs
direct URLs, use the pooled one for `DATABASE_URL` and the direct one for
`DIRECT_URL`.

## 2. Configure the service

Deploy the repo with this Dockerfile (the platform builds it) and set env vars:

| Variable | Value |
| --- | --- |
| `APP_ROLE` | `all` |
| `WORKER_IN_PROCESS` | `0` (superseded by APP_ROLE; keep unset or 0) |
| `DATABASE_URL` | pooled/managed Postgres URL |
| `DIRECT_URL` | direct Postgres URL |
| `APP_BASE_URL` | the platform's public URL (e.g. `https://devsentinel.up.railway.app`) — a platform subdomain is enough |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `ENCRYPTION_KEY_VERSION` | `1` |
| `GITHUB_WEBHOOK_SECRET` | GitHub App webhook secret |
| `GITHUB_APP_SLUG` | App slug (`github.com/apps/<slug>`); Setup URL is `<APP_BASE_URL>/api/github/callback` |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | from the GitHub App (docs/github-app-setup.md) |
| `TESTSPRITE_WAIT_TIMEOUT_SECONDS` | `600` |
| `WORKER_POLL_INTERVAL_MS` | `3000` |
| `WORKER_CONCURRENCY` | `2` |
| `RETENTION_DAYS` | `90` |
| `EMAIL_PROVIDER` / `EMAIL_PROVIDER_API_KEY` / `EMAIL_PROVIDER_FROM` | optional; provider is `brevo` (default) or `resend` |
| `AI_PROVIDER_API_KEY` / `AI_PROVIDER_MODEL` / `AI_PROVIDER_BASE_URL` | optional |

Health check path: `/api/health/ready`. Port: the platform injects `PORT`; the
image listens on `$PORT` (default 3000).

## 3. Migrations as a release command (never on web boot)

Run migrations as the platform's **release/pre-deploy command**, which runs
before the new process starts and only on deploy:

- **Railway**: Service → Settings → *Custom Start Command* stays default; add a
  *Pre-deploy command*: `node_modules/.bin/prisma migrate deploy`
- **Render**: `preDeployCommand: npx prisma migrate deploy` (see `render.yaml`)
- **Fly**: add a release command in `fly.toml`:
  `[deploy] release_command = "npx prisma migrate deploy"` (needs `DIRECT_URL`)

If the platform has no release command, run the migration from your machine/CI
once per release:

```bash
DATABASE_URL="<direct-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
```

## 4. Verify

1. `curl -f https://<your-url>/api/health` → `{"status":"ok"}`.
2. `curl -f https://<your-url>/api/health/ready` → `{"status":"ready"}`,
   `checks.worker: "live"` (in-process worker heartbeats itself; also visible on
   the Integrations page).
3. Bad-signature webhook → HTTP `401`:
   `curl -s -o /dev/null -w '%{http_code}' -X POST https://<your-url>/api/webhooks/github -H 'content-type: application/json' -d '{}'`

## Rollback

Redeploy the previous image/commit. If a migration must be undone, restore the
database from a backup (see DEPLOYMENT.md → Backups) and deploy the matching
older release.

## Scale-out note

`APP_ROLE=all` is intentionally single-instance (the in-process worker assumes
one process). To scale web horizontally, run a second service from the same
image with `APP_ROLE=web` and a dedicated `APP_ROLE=worker` service — same
variables, same database, coordination through the queue.

# Recipe a — Vercel (web) + container host (worker) + any Postgres

The web tier runs on Vercel (`APP_ROLE=web`, no worker, no CLI processes); the
worker runs on any container host with the same image and talks to the same
PostgreSQL through the queue. No code changes, configuration only.

## 1. Provision PostgreSQL

Use any provider (Neon, Supabase, RDS, self-hosted). Copy BOTH connection
strings it gives you:

- pooled URL (usually port 6543 / `-pooler` host) → `DATABASE_URL`
- direct URL (usually port 5432) → `DIRECT_URL`

## 2. Run the migration release step (once per release)

From your machine or a CI job (never on web boot):

```bash
DATABASE_URL="<direct-url>" DIRECT_URL="<direct-url>" npx prisma migrate deploy
```

CI option: a workflow step that runs `npx prisma migrate deploy` before
deploying. Keep it a separate release command.

## 3. Deploy the web role on Vercel

Import the repo into Vercel, then set **Environment Variables** (Project →
Settings → Environment Variables):

| Variable | Value |
| --- | --- |
| `APP_ROLE` | `web` |
| `WORKER_IN_PROCESS` | `0` (explicit: nothing in-process) |
| `DATABASE_URL` | pooled URL |
| `DIRECT_URL` | direct URL (unused by the app; keeps tooling consistent) |
| `APP_BASE_URL` | your final public URL, e.g. `https://devsentinel.vercel.app` — a platform subdomain is enough; the worker needs no domain |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` — **same value on the worker** |
| `ENCRYPTION_KEY_VERSION` | `1` |
| `GITHUB_WEBHOOK_SECRET` | the GitHub App webhook secret |
| `GITHUB_APP_SLUG` | App slug (`github.com/apps/<slug>`); Setup URL is `<APP_BASE_URL>/api/github/callback` |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | from the GitHub App (see `docs/github-app-setup.md`) |
| `EMAIL_PROVIDER` / `EMAIL_PROVIDER_API_KEY` / `EMAIL_PROVIDER_FROM` | optional; provider is `brevo` (default) or `resend` |
| `AI_PROVIDER_API_KEY` / `AI_PROVIDER_MODEL` / `AI_PROVIDER_BASE_URL` | optional |

Notes:

- Do **not** set worker-only variables (`WORKER_POLL_INTERVAL_MS`,
  `WORKER_CONCURRENCY`, `RETENTION_DAYS`, `TESTSPRITE_*`) on Vercel — they are
  ignored by the web role.
- Deploy, then verify: `curl -f https://<app>.vercel.app/api/health/ready` →
  `{"status":"ready",...}` (worker shows `not_running`/`degraded` until step 4).

## 4. Deploy the worker on a container host

Build the image (locally or in CI) and run it on any container host (Fly,
Railway, Render, a VPS with Docker — see `../vps-compose/README.md` for the
compose variant):

```bash
docker build -t devsentinel-worker .
docker run -d --name devsentinel-worker --restart unless-stopped \
  -e APP_ROLE=worker \
  -e DATABASE_URL="<pooled-or-direct-url>" \
  -e DIRECT_URL="<direct-url>" \
  -e ENCRYPTION_KEY="<identical to web>" \
  -e ENCRYPTION_KEY_VERSION=1 \
  -e TESTSPRITE_WAIT_TIMEOUT_SECONDS=600 \
  -e WORKER_POLL_INTERVAL_MS=3000 \
  -e WORKER_CONCURRENCY=2 \
  -e RETENTION_DAYS=90 \
  devsentinel-worker
```

The worker needs **no inbound port and no domain** — set the platform's port
mapping off / TCP closed. It logs structured JSON to stdout.

## 5. Verify

1. `GET https://<app>.vercel.app/api/health` → `{"status":"ok"}` (liveness).
2. `GET https://<app>.vercel.app/api/health/ready` → `{"status":"ready"}` with
   `checks.worker: "live"` once the worker's heartbeat is < 2 minutes old
   (visible on the app's **Integrations** page too).
3. Send a bad-signature webhook:
   `curl -s -o /dev/null -w '%{http_code}' -X POST https://<app>.vercel.app/api/webhooks/github -H 'content-type: application/json' -d '{}'`
   → `401` (signature verification failed).

## Rollback

Vercel: redeploy the previous deployment from the dashboard (migrations are
separate; roll back code only). Worker: redeploy the previous image tag.

## Changing a variable

Every variable requires a restart (redeploy) except none — all configuration is
read at process start.

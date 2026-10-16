# Recipe c — Plain VPS with Docker Compose

Works on any VPS with Docker + the Docker Compose plugin. One command brings up
Postgres (with a volume), a one-shot migration, the web role and the worker role.

## 1. Prepare

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
git clone https://github.com/festac-dev/devsentinel-ai.git && cd devsentinel-ai
cp .env.example .env
```

Edit `.env`:

- `APP_BASE_URL=https://devsentinel.example.com` (your DNS name; a platform or
  free subdomain is fine)
- `ENCRYPTION_KEY` → `openssl rand -base64 32` (the compose file shares the
  same value with both roles via this file)
- `GITHUB_WEBHOOK_SECRET`, GitHub App variables, optional email/AI variables
- `POSTGRES_PASSWORD` → a strong password (used by the compose wiring only)
- Leave `DATABASE_URL`/`DIRECT_URL` in `.env` as-is — compose injects the
  Postgres service URLs.

## 2. Start

```bash
docker compose up -d --build
```

Services: `postgres` (volume `pgdata`), `migrate` (one-shot
`prisma migrate deploy` — runs to completion before web/worker start), `web`
(`APP_ROLE=web`, port `${WEB_PORT:-3000}`), `worker` (`APP_ROLE=worker`, no
ports).

## 3. HTTPS (optional but recommended)

Point a reverse proxy at `127.0.0.1:3000` and keep `APP_BASE_URL` on the public
https URL. Caddy (automatic certificates):

```
devsentinel.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## 4. Verify

```bash
curl -f http://127.0.0.1:3000/api/health           # liveness
curl -f http://127.0.0.1:3000/api/health/ready     # readiness (worker live)
docker compose ps                                   # all services up, migrate exited 0
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/webhooks/github \
  -H 'content-type: application/json' -d '{}'       # 401 (bad signature)
```

Then open `https://<your-domain>` → Integrations page shows the worker
heartbeat ("running", last heartbeat seconds ago).

## 5. Releases

```bash
git pull
docker compose build
docker compose run --rm migrate     # migration release step (explicit, never on web boot)
docker compose up -d                # recreate web + worker
```

## 6. Backups

```bash
docker compose exec postgres pg_dump -U devsentinel devsentinel | gzip > backup-$(date +%F).sql.gz
```

## Rollback

```bash
git checkout <previous-tag>
docker compose build && docker compose run --rm migrate && docker compose up -d
```

## Troubleshooting

- `migrate` exits non-zero → `docker compose logs migrate` (usually wrong
  `POSTGRES_PASSWORD` or Postgres not healthy yet; re-run `docker compose run --rm migrate`).
- Web 503 on `/api/health/ready` with `database_unreachable` → Postgres not up
  yet or wrong password; `docker compose logs postgres`.
- Worker not running on the Integrations page → `docker compose logs worker`.

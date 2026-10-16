# deploy/ — recipes for every hosting shape

All recipes use the same image / codebase and the same environment variables
(see `.env.example`); the only per-host difference is configuration. Pick one:

| Recipe | Path | Use when |
| --- | --- | --- |
| a) Vercel (web) + container host (worker) | [`vercel/`](./vercel/README.md) | Serverless web, worker elsewhere |
| b) Single container host (Railway / Render / Fly …) | [`single-container/`](./single-container/README.md) | One app + managed Postgres |
| c) Plain VPS with Docker Compose | [`vps-compose/`](./vps-compose/README.md) | Any VPS with Docker |
| d) Bare VPS without Docker (systemd/pm2 + nginx/Caddy) | [`bare-vps/`](./bare-vps/README.md) | No Docker available |

Shared invariants (true on every path):

- Database engine is **PostgreSQL** (`DATABASE_URL` pooled + `DIRECT_URL` for migrations).
- **Migrations are a release step** (`prisma migrate deploy`), never run on web boot.
- `APP_ROLE` selects the process role: `web` | `worker` | `all`.
- Health: `/api/health` (liveness), `/api/health/ready` (readiness; `degraded`
  when no worker heartbeat for 2 minutes on a web instance).
- Verify a deployment: `curl -f https://<your-url>/api/health/ready`.

# DevSentinel AI

**Build confidently. Deploy safely. Know what broke.**

DevSentinel AI is a developer operations and automated testing platform built for the
TestSprite Hackathon Season 4. It connects GitHub repositories, automatically tests pull
requests through **genuine TestSprite runs** (via the official
[@testsprite/testsprite-cli](https://www.npmjs.com/package/@testsprite/testsprite-cli)),
binds every result to the **exact commit SHA** it tested, and monitors deployed
applications, with incidents, evidence, and honest integration status throughout.

DevSentinel AI is a **standalone** project. It shares no code, data, secrets, or
infrastructure with any other application.

## The core chain

```
open PR → GitHub webhook (HMAC-verified) → delivery dedup → job queued
        → TestSprite run (official CLI) → result bound to head SHA
        → status published to the same SHA (re-checked at publish time)
```

A result for commit A is **never** shown as validating commit B. When a PR's head moves,
earlier runs are marked **Stale** with a tooltip naming both SHAs, and statuses are only
published after re-reading the current head SHA.

## Architecture

One codebase, two runtime roles, selected by `APP_ROLE`:

| Role     | Runs                                                                                     | Typical host                   |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `web`    | Next.js UI, API, GitHub webhook endpoint. Never runs the worker.                         | Vercel                         |
| `worker` | Job queue, TestSprite CLI runs, monitoring checks, notifications, retention. No inbound port. | Railway / your machine / VPS / container |
| `all`    | Both in one process. Single-container hosts and local dev only.                          | Local dev                      |

```
GitHub ──webhook──▶ Vercel (web) ──▶ Neon Postgres ◀── Worker (polls queue)
   ▲                                                      │
   └────────── commit status on the tested SHA ◀──────────┴──▶ TestSprite CLI
```

The web app and the worker communicate **only through the database**. If the worker is
offline, jobs wait in the queue and run when it comes back.

A graphical walkthrough is available as `devsentinel-ai-deployment-guide.pdf`.

## What is real, what is a boundary

Every test run carries a source label shown in the UI:

| Label                       | Meaning                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| **TestSprite execution**    | A genuine provider run started through the official TestSprite CLI                    |
| **Local automated**         | (reserved; not used in this build)                                                    |
| **Simulated demonstration** | Only produced by the optional demo seed (`npm run db:seed`); never by the running app |

Honest boundaries are implemented instead of silent omissions:

- **TestSprite not configured** → runs end in `error` with the real reason; the UI and Integrations page show the exact missing prerequisite.
- **GitHub webhook secret missing** → the webhook endpoint responds `503` and processes nothing.
- **AI provider not configured** → incident pages show "AI investigation unavailable — provider not configured." Analysis is never simulated.
- **Email provider not configured** → in-app notifications only, stated in the UI.
- **No publishing credential** → a status publication is recorded as `not_configured` and never claimed as published.
- **GitHub App not registered** → repositories can be connected by name with webhook instructions; see `docs/github-app-setup.md`.

## Two GitHub integrations

This build deliberately keeps **two GitHub integrations separate**:

1. **The TestSprite GitHub App**, installed by the repository owner from the
   [TestSprite 3.0 portal](https://docs.testsprite.com/web-portal/integrations/github-integration).
   It listens for the repo's deployment events, runs the generated suite, and posts the
   **TestSprite PR comment / commit check**. It is owner-managed portal configuration;
   DevSentinel does not trigger it and never impersonates it.
2. **DevSentinel's own GitHub App**, which feeds the HMAC-verified webhook into
   DevSentinel's pipeline and publishes DevSentinel's **own** commit statuses. A status
   DevSentinel publishes is always labeled as DevSentinel's; it never claims a TestSprite
   check exists on a PR unless it observed one through a documented mechanism.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript strict + Tailwind CSS
- Prisma ORM over **PostgreSQL** (Neon recommended): pooled `DATABASE_URL` for the app, direct `DIRECT_URL` for migrations
- Auth: scrypt password hashing, httpOnly session cookies, idle + absolute timeouts, CSRF double-submit tokens, shared database-backed rate limiting
- Credentials: integration secrets encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`, versioned for rotation)
- Background jobs: persisted `Job` table, retried with exponential backoff + jitter, dead-letter state, run by `npm run worker`
- TestSprite integration: the official CLI, driven through its documented commands and exit codes
- Tests: Vitest unit tests, DB-backed integration tests (including the TestSprite adapter driven through the real pinned CLI against a local backend stub), and a Playwright E2E suite (TestSprite CLI mocked in E2E)

## Quick start (local)

Prerequisites: Node.js 20.19+ / 22.13+ / 24+, and a PostgreSQL database (a free
[Neon](https://neon.tech) project or branch works well).

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL, DIRECT_URL, ENCRYPTION_KEY
npx prisma migrate dev   # applies migrations to your database
npm run dev              # web app on http://localhost:3000
npm run worker           # second terminal: processes the job queue
```

With `APP_ROLE=all` (the `.env.example` default) the web app and worker can share one
process. Use separate terminals with `APP_ROLE=web` / `APP_ROLE=worker` to mirror production.

Open <http://localhost:3000>, register an account, create a project, and follow the
onboarding checklist on the Overview page.

For real TestSprite runs, per project you need:

1. A [TestSprite API key](https://www.testsprite.com/dashboard/settings/apikey), saved on the project page (encrypted, write-only).
2. A TestSprite project ID (`testsprite project list`).
3. A deployed target URL that TestSprite should test.
4. A webhook on your GitHub repository/App pointing to `https://<host>/api/webhooks/github` with `GITHUB_WEBHOOK_SECRET` set.

Without those, the app still works: runs are queued and end with an honest
"TestSprite not configured" error you can inspect on the run page.

## Configuration

Everything comes from the environment (see `.env.example` for descriptions and where to get each value).

| Variable | Web | Worker | Notes |
| --- | :-: | :-: | --- |
| `APP_ROLE` | ✓ | ✓ | `web`, `worker`, or `all` |
| `DATABASE_URL` | ✓ | ✓ | Pooled Postgres URL the app queries with. **Identical on both.** |
| `DIRECT_URL` | ✓ | | Direct (non-pooled) URL, used by `prisma migrate deploy` |
| `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION` | ✓ | ✓ | `openssl rand -base64 32`. **Identical on both**: the worker decrypts what the web app stored |
| `APP_BASE_URL` | ✓ | ✓ | Public URL of the web deployment |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | ✓ | * | Private key as one line with `\n` escapes. *Also set on the worker if it publishes statuses via the App installation token |
| `GITHUB_APP_SLUG` | ✓ | | Last part of the App URL (`github.com/apps/<slug>`). Enables the Install GitHub App flow; set the App's **Setup URL** to `<APP_BASE_URL>/api/github/callback` |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | ✓ | | From the GitHub App page |
| `GITHUB_WEBHOOK_SECRET` | ✓ | | Webhook is disabled (503) until set |
| `EMAIL_PROVIDER`, `EMAIL_PROVIDER_API_KEY`, `EMAIL_PROVIDER_FROM` | ✓ | ✓ | Optional. `EMAIL_PROVIDER` is `brevo` (default, free tier, verified sender address only) or `resend`. `EMAIL_PROVIDER_FROM` must be a sender verified with the provider. Set on the worker too, which sends notification emails |
| `AI_PROVIDER_API_KEY`, `AI_PROVIDER_MODEL`, `AI_PROVIDER_BASE_URL` | ✓ | | Optional; OpenAI-compatible |
| `TESTSPRITE_API_KEY` | | ✓ | Fallback when a project has no stored credential |
| `TESTSPRITE_CLI_PATH`, `TESTSPRITE_WAIT_TIMEOUT_SECONDS` | | ✓ | Optional overrides |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `RETENTION_DAYS` | | ✓ | Tuning |

## Deployment: Vercel + Neon + worker (Railway or your own machine)

The web app is deployed **twice**: once to obtain a URL for the GitHub webhook, and again
after the GitHub App exists.

### 1. Neon

Create a project. Use the pooled connection string (host contains `-pooler`) as
`DATABASE_URL` and the direct one as `DIRECT_URL`, both with `?sslmode=require`. Use a
separate Neon branch for local testing.

Confirm the migrations were generated for Postgres, then apply them once:

```bash
head -3 prisma/migrations/migration_lock.toml    # must say: postgresql
DATABASE_URL="<direct url>" DIRECT_URL="<direct url>" npx prisma migrate deploy
```

If the lock file says `sqlite`, delete `prisma/migrations` and run
`npx prisma migrate dev --name init` against a Neon dev branch.

### 2. Vercel (web)

Import the repository and set the build command:

```
prisma generate && prisma migrate deploy && next build
```

Set `APP_ROLE=web`, `DATABASE_URL`, `DIRECT_URL`, `ENCRYPTION_KEY`,
`ENCRYPTION_KEY_VERSION=1`, then deploy once to get the URL. Set `APP_BASE_URL` to that URL.
Do not set `TESTSPRITE_*` or `APP_ROLE=all` on Vercel: serverless functions cannot run the worker.

### 3. GitHub App

Create it at <https://github.com/settings/apps/new> (full details in `docs/github-app-setup.md`):

| Field | Value |
| --- | --- |
| Homepage URL | your Vercel URL |
| Request user authorization (OAuth) | unchecked |
| Webhook | Active, `https://<your-app>.vercel.app/api/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` (same value as `GITHUB_WEBHOOK_SECRET`) |
| Subscribe to events | `pull_request` |

Permissions (least privilege, everything else **No access**):

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read-only | Resolve repo names and default branches |
| Pull requests | Read-only | Receive `pull_request` events and head SHAs |
| Commit statuses | Read & write | Publish DevSentinel's own results to the tested SHA |

Generate a private key and convert it to one line:

```bash
awk 'NF {sub(/\r/,""); printf "%s\\n",$0}' your-key.pem
```

Add `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` to Vercel and set the App's **Setup URL** to
`<APP_BASE_URL>/api/github/callback`. **Redeploy**, then connect the repo by owner/name on the
project page; you are sent to GitHub to install the App and returned automatically.

### 4. Worker

On any machine with Node, create a `.env`:

```bash
APP_ROLE=worker
DATABASE_URL=<same pooled URL as Vercel>
ENCRYPTION_KEY=<IDENTICAL to Vercel>
APP_BASE_URL=https://<your-app>.vercel.app
TESTSPRITE_API_KEY=<from the TestSprite dashboard>
```

```bash
npm install && npx prisma generate && npm run worker
```

Keep it running (pm2, systemd, or a container with a restart policy). Never run migrations
from the worker.

- If runs finish but statuses show `not_configured`, also set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` on the worker, or save a per-project token on the project page.
- The worker polls the queue, which keeps Neon's compute awake. On a free plan this can use up monthly compute hours; check your plan or run the worker only while testing.
- On Termux/Android, Prisma's native engine may not run; use a laptop or VPS.

#### Worker on Railway

Railway runs the worker as its own service from the same repository.

1. **New Project → Deploy from GitHub repo** and select this repository.
2. **Settings → Build / Deploy**:
   - Build command: `npm install && npx prisma generate`
   - Start command: `npm run worker`
   - **Pre-deploy command: leave empty.** The worker must never run migrations; Vercel's build does that.
   - **Healthcheck path: leave empty.** The worker opens no HTTP port, so a healthcheck can never pass.
   - Do not generate a public domain.
3. **Variables** (service variables):

   | Variable | Value |
   | --- | --- |
   | `APP_ROLE` | `worker` |
   | `DATABASE_URL` | Same pooled Neon URL as Vercel |
   | `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION` | Identical to Vercel |
   | `APP_BASE_URL` | Your Vercel URL |
   | `TESTSPRITE_API_KEY` | From the TestSprite dashboard |
   | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | Same values as Vercel (needed to publish statuses) |
   | `WORKER_CONCURRENCY` | `2` |
   | `WORKER_POLL_INTERVAL_MS` | `10000` recommended on free Neon plans |
   | `NODE_VERSION` | `22` if the default Node is older than 20.19 |

   `DIRECT_URL` is not needed on the worker.
4. **Prisma engine on Railway**: `prisma/schema.prisma` sets
   `binaryTargets = ["native", "debian-openssl-3.0.x"]` in the generator so the client
   includes the OpenSSL 3 engine Railway's Debian image needs. Without it the worker crashes
   at startup.
5. Success is judged by the web app, not Railway: `GET /api/health/ready` on your Vercel URL
   must show a green **worker heartbeat**.

### 5. Verify

- `GET /api/health` returns ok; `GET /api/health/ready` is green (database, migrations, worker heartbeat).
- A webhook POST with a bad signature is rejected with `401`.
- Open a test PR: a run appears, binds to the head SHA, and a status lands on that SHA. Push a new commit and the earlier run becomes **Stale**.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Webhook returns 503 | `GITHUB_WEBHOOK_SECRET` not set on Vercel |
| Real deliveries return 401 | Secret in the GitHub App differs from `GITHUB_WEBHOOK_SECRET` |
| Ready check: no worker heartbeat | Worker not running, or different `DATABASE_URL` |
| Worker cannot decrypt credentials | `ENCRYPTION_KEY` differs between Vercel and worker |
| Vercel build fails at migrate | `DIRECT_URL` missing or set to the pooled URL |
| Prepared-statement errors on the pooled URL | Append `&pgbouncer=true` to `DATABASE_URL` |
| Railway: "Pre-deploy command failed" (`migrate deploy`) | Clear the pre-deploy command; only Vercel runs migrations |
| Railway: healthcheck never passes | Clear the healthcheck path; the worker has no HTTP port |
| Railway: worker crashes at startup with a Prisma engine error | Add `debian-openssl-3.0.x` to `binaryTargets` in `prisma/schema.prisma` and redeploy |

Single-container hosts can instead run `APP_ROLE=all` with a long-running process.

## Hackathon submission (TestSprite Hackathon Season 4)

What DevSentinel AI is, per the rules: a real app under test, whose own PR flow carries a
TestSprite check generated in the TestSprite 3.0 portal.

- **What the app does**: connects GitHub repositories, tests pull requests through genuine
  TestSprite runs, binds every result to the exact commit SHA, monitors deployed URLs with
  SSRF-hardened checks, and manages evidence-based incidents.
- **Live URL**: <https://devsentinel-ai-festac.vercel.app> (`/api/health` responds ok; readiness
  is confirmed by `/api/health/ready` once the worker is running). It must be reachable for the whole
  build window, and the TestSprite PR trigger needs the PR to produce a preview deployment whose
  URL the suite can test.
- **What the automated test suite covers**: the Playwright suite (`tests/e2e/pr-flow.spec.ts`)
  drives registration, project creation, repository connection, encrypted TestSprite
  credential setup, signed GitHub webhook → commit-bound run → staleness on a new commit,
  failing run → auto-incident → notification read state, real HTTP monitoring check, and
  webhook-signature rejection (401) for tampered payloads. Unit and DB-backed integration
  suites cover auth, cross-tenant isolation (IDOR), SSRF classes, run-state legality, dedup
  constraints, and secret redaction.
- **Order of operations** (the suite must exist before the PR): deploy → generate the suite in
  the TestSprite 3.0 portal against the live URL → connect the TestSprite GitHub App →
  (optional) enable "Block PR until tests pass" → open PRs. Details in
  `docs/testsprite-integration.md`.

**Submission checklist** (owner tasks are listed, not claimed):

- [x] Public repository `devsentinel-ai` (no committed secrets; `.env.example` only)
- [x] Live public URL verified reachable (`/api/health/ready` green)
- [x] TestSprite suite generated in the 3.0 portal against the live URL
- [x] TestSprite GitHub App installed on the repository; PR trigger active
- [x] PR link(s) opened during the build window carrying a TestSprite comment/check
- [x] Team members listed in the submission; one member submits

## Commands

| Command                       | What it does                                                               |
| ----------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                 | Start the app in dev mode                                                  |
| `npm run build` / `npm start` | Production build / serve                                                   |
| `npm run worker`              | Start the background worker (job queue + monitoring scheduler + retention) |
| `npm test`                    | Unit and integration tests (Vitest)                                        |
| `npm run test:e2e`            | Playwright end-to-end suite                                                |
| `npm run typecheck`           | TypeScript strict check                                                    |
| `npm run lint`                | ESLint                                                                     |
| `npm run db:migrate`          | Apply migrations (`prisma migrate deploy`)                                 |
| `npm run db:seed`             | Seed representative demo data (demo login, sample project, runs, incident) into the database from `DATABASE_URL` |

## Health endpoints

- `GET /api/health`: liveness.
- `GET /api/health/ready`: database reachability, migrations applied, worker heartbeat. Reports what is actually true; never fakes readiness.

## Documentation

- [`docs/decisions.md`](./docs/decisions.md): architecture decision records
- [`docs/testsprite-integration.md`](./docs/testsprite-integration.md): research behind the TestSprite adapter, with links to official docs; undocumented behavior is marked unverified
- [`docs/github-app-setup.md`](./docs/github-app-setup.md): GitHub App registration, permissions, and webhook configuration
- [`docs/demo-guide.md`](./docs/demo-guide.md): timed hackathon demonstration script with fallbacks
- [`docs/api.md`](./docs/api.md): HTTP API surface and server actions
- [`docs/troubleshooting.md`](./docs/troubleshooting.md): common setup problems
- [`SECURITY.md`](./SECURITY.md): security posture, known limitations, vulnerability reporting
- [`CONTRIBUTING.md`](./CONTRIBUTING.md): development workflow

## License

Apache-2.0. See [`LICENSE`](./LICENSE)

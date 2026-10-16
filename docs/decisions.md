# Architecture Decision Records

## ADR-001 — SQLite via Prisma instead of PostgreSQL (superseded by ADR-010)

- **Context**: The spec prefers PostgreSQL. This build must run reliably in a sandboxed
  environment with no PostgreSQL server available, and must be deployable by a single
  operator for the hackathon.
- **Decision**: SQLite through Prisma (`prisma/schema.prisma`, provider `"sqlite"`), with
  versioned migrations. Switching to PostgreSQL is a one-line datasource change plus a
  fresh migration; all access goes through Prisma, so no raw SQL depends on SQLite
  behavior.
- **Consequences**: Single-writer limitations under heavy concurrency; the job queue
  claims jobs via `updateMany` compare-and-set, which is safe but does not use
  `FOR UPDATE SKIP LOCKED`. Documented in SECURITY.md and README.

## ADR-002 — TestSprite integration via the official CLI

- **Context**: The verified, documented programmatic surface available for TestSprite is
  the official CLI (`@testsprite/testsprite-cli`), which authenticates via the
  `TESTSPRITE_API_KEY` environment variable and emits machine-readable JSON
  (`--output json`) for every command. No public REST API is documented for direct
  third-party calls (research in `docs/testsprite-integration.md`).
- **Decision**: `src/modules/testsprite/provider.ts` implements `TestExecutionProvider`
  strictly on top of documented CLI commands (`test create --plan-from … --run --wait`,
  `test run`, `test result`, `project list`) and exit codes. The CLI binary is resolved
  from `TESTSPRITE_CLI_PATH` or the app's own `node_modules/.bin/testsprite`.
- **Consequences**: One subprocess per run (bounded, timeout-enforced); result parsing is
  defensive — unparseable output becomes `unknown`/`error`, never `passed`.

## ADR-003 — Custom session auth instead of a third-party library

- **Context**: Auth libraries (NextAuth, Lucia, etc.) add flexibility but their session
  primitives are simple in this application's single-user-owner model, and every
  dependency must be justified for a security-sensitive hackathon build.
- **Decision**: Node's `scrypt` for password hashing and first-party session records
  (SHA-256-hashed random tokens in httpOnly cookies) with idle + absolute timeouts.
- **Consequences**: Full control and auditability; no OAuth flows are supported
  (documented limitation).

## ADR-004 — In-process job queue table + dedicated worker process

- **Context**: The spec requires a persistent queue that survives restarts, with
  retries, backoff, and dead-letter visibility. pg-boss needs PostgreSQL.
- **Decision**: A `jobs` table (status machine: queued → running → done/failed/dead),
  claimed with compare-and-set updates by `worker/index.ts` (tsx entrypoint) with
  bounded concurrency, exponential backoff with jitter, and a heartbeat row surfaced in
  the Integrations UI.
- **Consequences**: The worker must run (`npm run worker`) for runs to execute or
  monitoring to check. The UI never implies the worker is alive without a fresh
  heartbeat.

## ADR-005 — No runtime demo mode; simulated data only via the labeled seed

- **Context**: The spec permits demo data only when unmistakably labeled and excluded
  from real statistics. Fresh environments (UI verification, demos without
  credentials) also need representative records to show.
- **Decision**: No runtime demo mode exists. All data produced by the running app
  comes from real webhooks, real checks, or real CLI invocations — the application
  code never creates a `demo`-source run. The one exception is the explicit, opt-in
  demo seed (`npm run db:seed`): it creates `demo`-source runs and the matching
  incident for its own sample project, and every surface that shows a source badge
  renders them as `Simulated demonstration`, so they can never pass as provider
  results (see `docs/demo-guide.md`).
- **Consequences**: Demonstrations without credentials show honest boundaries or the
  clearly-labeled seeded sample project (see `docs/demo-guide.md` fallbacks).

## ADR-006 — Automated test strategy: unit, DB-backed integration, and Playwright E2E

- **Context**: The spec lists unit tests, DB-backed integration tests ("real
  Postgres"), and Playwright E2E as part of the test strategy. An earlier revision
  of this build shipped unit tests only (documented as ADR-006 "E2E suite not
  included"); that boundary has since been closed.
- **Decision**: Three suites, all runnable locally and in CI:
  - `tests/unit` — security-critical pure logic (crypto, redaction, webhook
    signatures, SSRF classes, run state machine, provider output interpretation,
    GitHub App JWT, email provider).
  - `tests/integration` — real Prisma + PostgreSQL (ADR-010) with the project's
    versioned migrations applied to a throwaway database per run (`prisma migrate
    reset`); covers unique-constraint dedup (webhook delivery, notification dedup key,
    incident fingerprint, job idempotency), cross-tenant query isolation,
    commit binding + staleness (including the database-level immutability trigger),
    cascading cleanup, encrypted credentials at rest, DB-backed rate limiting,
    the notification pipeline end-to-end, and the TestSprite adapter driven
    through the REAL pinned CLI (`@testsprite/testsprite-cli` from node_modules)
    against a local stub of the documented `/api/cli/v1` backend — the CLI's own
    argument handling, HTTP client, response schemas, polling and exit codes are
    genuine, so wire-shape drift between the app and the CLI fails in CI.
  - `tests/e2e` — Playwright driving the production build (`next start` + worker)
    through the real UI and the real webhook endpoint: register → project → repo
    connect → credentials → signed `pull_request` events → commit-bound run →
    staleness on new commit → failing run → auto-incident → notification read
    state → real HTTP monitoring check → webhook signature rejection. Per spec 20
    ("full PR→run→result flow against mocks"), the TestSprite CLI is a mock
    fixture selected via `TESTSPRITE_CLI_PATH`; the production path is identical
    code.
- **Consequences**: `npm test` runs unit + integration; `npm run test:e2e` runs
  Playwright. E2E is labeled mocked for the TestSprite boundary; no test claims
  real TestSprite execution (the integration suite runs the real CLI binary, but
  its backend is a local stub — a real api.testsprite.com execution still
  requires live credentials).

## ADR-007 — Framework/dependency posture: Next.js 16 + React 19, zero production advisories

- **Context**: The initial build pinned Next.js 14.2.x, which accumulated
  production advisories (image optimizer, rewrites SSRF, Server Action limits,
  PostCSS transitive issues) whose fixes require Next ≥ 16.4.
- **Decision**: Upgraded to Next.js 16.4 + React 19 (async request APIs, `proxy.ts`
  replacing `middleware.ts`, ESLint 9 flat config). `npm audit --omit=dev` reports
  0 vulnerabilities. Tailwind stays on 3.4.x (`^3.4.1`): a transient resolution to
  Tailwind 4 appeared during the dependency-audit recovery while
  `postcss.config.mjs`/`globals.css` were still v3-era (v3 plugin, `@tailwind`
  directives); it was reverted to the version the UI is built and browser-verified
  on. The Tailwind 4 migration — which would also clear the remaining dev-only
  advisories (brace-glob stack exhaustion reachable only from the Tailwind 3 build
  toolchain) — remains tracked follow-up work, never bundled into deployment work.
- **Consequences**: The app runs on the current major of the framework; the CSP
  nonce middleware is now `src/proxy.ts`; ESLint runs via `eslint .` (Next 16
  removed `next lint`).

## ADR-008 — GitHub App installation tokens and the email channel are implemented

- **Context**: The spec's commit-status publication works per-project via an
  encrypted PAT; the spec also expects email delivery to be real when configured.
  An earlier revision documented both as boundaries.
- **Decision**:
  - Status publishing now resolves credentials in order: per-project PAT → GitHub
    App installation token (RS256 app JWT → `POST /app/installations/:id/access_tokens`,
    cached until near-expiry) when `RepositoryConnection.installationId` and
    `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` are set. Without either, the outcome
    is recorded as `not_configured` — never claimed as published.
  - Email delivery uses a provider HTTP API behind a typed adapter (Brevo by
    default, which has a free tier and needs no custom domain; Resend is
    selectable with `EMAIL_PROVIDER=resend`): `delivered` only when the provider accepts and returns an id,
    `failed` with the real reason otherwise, `not_configured` when env vars are
    absent. Per-user/event preferences gate it (Notifications page), notification
    dedup is respected, and password-reset emails are sent through the same
    adapter when configured.
- **Consequences**: Live verification of both channels requires real credentials
  (GitHub App private key, email provider key); unit and integration tests cover
  the logic with mocked HTTP, and the UI surfaces honest states.

## ADR-009 — Deployment as a Render Blueprint with an in-process worker (superseded by ADR-010)

- **Context**: The spec requires production deployment configuration, migrations
  on release, health endpoints, and a persistent worker with a restart policy —
  with every credential supplied by the environment, never committed. The
  default deployment target is Render, whose Blueprint model (`render.yaml`)
  defines services, disks, release commands, and environment variables as code
  with `generateValue` (Render-managed secrets) and `sync: false` (Dashboard-
  entered values).
- **Decision**:
  - `render.yaml` defines the single-instance production deployment: Node web
    service, persistent disk for the SQLite file, `preDeployCommand` running
    `prisma migrate deploy` on every release, `healthCheckPath` pointing at
    `/api/health/ready`, and all env vars managed by Render.
  - The worker loop moved to `src/worker/loop.ts` (exporting `startWorker()`);
    `worker/index.ts` remains the standalone entry (`npm run worker`), and
    `src/instrumentation.ts` boots the same loop inside the web server when
    `WORKER_IN_PROCESS=1`. One service therefore runs the whole product — a
    background worker cannot share a persistent disk with another service, so
    SQLite deployments must be single-instance. A CI fallback encryption key
    was removed; CI now generates a throwaway key per run.
- **Consequences**: Horizontal scaling requires switching the Prisma datasource
  to PostgreSQL, adding a `databases:` resource to the Blueprint, and running a
  separate background worker service (the loop module makes that a config
  change, not a rewrite). The in-process worker shares the web service's CPU;
  `maxShutdownDelaySeconds` gives it time to drain on redeploy.

## ADR-010 — PostgreSQL everywhere; deployable anywhere with configuration only

- **Context**: ADR-001 shipped SQLite for the sandboxed build and ADR-009 tied
  deployment to a single-instance Render service with a persistent disk. The
  deployment goal widened: DevSentinel must deploy on ANY platform (Vercel,
  Railway/Render/Fly, any VPS, bare Node) with configuration only — no
  platform-specific code paths and no per-host forks.
- **Decision**:
  - One database engine on every host: PostgreSQL. `prisma/schema.prisma` uses
    `provider = "postgresql"` with `url = env("DATABASE_URL")` (pooled) and
    `directUrl = env("DIRECT_URL")` (migrations; equal to DATABASE_URL without
    a pooler). SQLite migrations were replaced by a fresh PostgreSQL baseline
    migration; the `TestRun` commit binding is now enforced by a database
    trigger (`test_run_commit_binding`) in addition to application code.
  - One codebase, role by env: `APP_ROLE=web | worker | all` (validated at
    startup in `src/lib/config.ts`). `web` never runs the worker and never
    spawns CLI processes — the "Verify credential" action now enqueues a
    `verify_testsprite` job whose result arrives as a notification.
    `APP_ROLE=worker` is a standalone entrypoint (`npm run worker`) with no
    inbound port; `APP_ROLE=all` boots the worker loop in-process
    (supersedes the `WORKER_IN_PROCESS` alias, kept for compatibility). Web
    and worker communicate only through the PostgreSQL-backed queue, now
    claimed with `FOR UPDATE SKIP LOCKED` (removing the ADR-001
    single-writer caveat).
  - Stateless by default: rate limiting moved into the database
    (`RateLimitWindow`, ADR-011), sessions were always DB-backed, logs go to
    stdout as structured JSON (`src/lib/logger.ts`). The only per-process
    cache that remains is the GitHub installation-token cache (ADR-008),
    documented as a per-instance cache.
  - Graceful shutdown on SIGTERM in web (pool close) and worker (drain
    current jobs, then close); `/api/health` (liveness) and
    `/api/health/ready` (database, migrations, worker heartbeat — `degraded`
    when the heartbeat is older than 2 minutes and `APP_ROLE=web`).
  - Deployment assets: multi-stage `Dockerfile` (pinned Node 22, standalone
    output, non-root, pinned `@testsprite/testsprite-cli`, HEALTHCHECK, one
    image for every role), `docker-compose.yml` (web, worker, postgres with
    volume, one-shot `migrate` service), `deploy/` recipes (Vercel,
    single-container, VPS Compose, bare VPS), and `DEPLOYMENT.md`.
- **Consequences**: Any host works with configuration only. Migrations stay a
  separate release command; CI fails on schema/migration drift. The ADR-001
  and ADR-009 single-instance/SQLite consequences are superseded by this ADR.

## ADR-011 — Database-backed rate limiting instead of in-memory buckets

- **Context**: The in-process sliding-window limiter (ADR-003/SECURITY
  limitation) enforced a separate limit per instance; behind more than one web
  replica the effective limit multiplied, and serverless platforms recycle
  instances constantly.
- **Decision**: `src/lib/ratelimit.ts` keeps its interface but stores counters
  in the `RateLimitWindow` table: fixed windows keyed by `(key, windowStart)`,
  atomically incremented via upsert, expired rows pruned opportunistically and
  by the worker's retention cleanup.
- **Consequences**: One shared limit across all web instances with no new
  infrastructure; the cost is one upsert per rate-limited request. Fixed
  windows are slightly coarser than the previous sliding window (a burst
  straddling a boundary can admit up to 2x the limit once) — accepted for
  abuse damping, documented in SECURITY.md.

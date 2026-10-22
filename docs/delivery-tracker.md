# Delivery and verification tracker

The delivery tracker records the project's four-phase implementation plan next
to the evidence that supports each task. It is designed around one rule:
**reported completion is not verification**. A task can be reported complete by
the owner while its evidence remains unverified, and the UI and report say so.

## Where it lives

- UI: `/app/delivery` (overview), `/app/delivery/phases/[phaseKey]`,
  `/app/delivery/tasks/[taskKey]`, `/app/delivery/report`
- Download: `GET /api/delivery/report` (authenticated Markdown attachment,
  `Cache-Control: no-store`)
- Domain logic: `src/modules/delivery/model.ts` (pure, unit tested)
- Persistence and ownership checks: `src/modules/delivery/service.ts`
- Server actions: `src/app/actions/delivery.ts`
- Versioned initial content: `src/modules/delivery/initial-data.ts`

The tracker is owned by the signed-in account. The app has no multi-user
project concept for DevSentinel's own delivery history, so there is no
cross-account sharing, assignment, or role model. Every read and mutation is
scoped to `ownerId` and every server action re-checks the session server-side.

## Initial state

The first authenticated visit initializes the tracker idempotently:

- 4 phases and 16 tasks with stable keys.
- All tasks are stored as `completed` (reported complete) and `unverified`.
- `completedAt` is `null`: the supplied checklist did not include timestamps,
  so none were invented.
- Each task receives one `initial_state_recorded` audit event with a `null`
  actor and a note that the state was supplied, not independently verified.

Initialization is serialized with a PostgreSQL advisory lock and only inserts
missing rows. Re-running it never overwrites status, notes, evidence, or audit
history.

## States and transitions

Task status: `pending`, `in_progress`, `blocked`, `completed`.
Verification status: `unverified`, `pending_review`, `verified`, `rejected`.

| From          | Allowed transitions                              |
| ------------- | ------------------------------------------------ |
| `pending`     | `in_progress`, `blocked`, `completed`            |
| `in_progress` | `completed`, `blocked`, `pending`                |
| `blocked`     | `in_progress`, `pending`                         |
| `completed`   | `in_progress`, `pending`                         |

Same-state writes and any transition not listed are rejected. Setting
`blocked` requires a short reason.

Adding evidence moves the task to `pending_review`; it never verifies the task.
If any evidence record is verified, the task is `verified`. If every evidence
record was rejected, the task is `rejected`.

Changing a verified task's status or completion notes **invalidates prior
verification**: verified evidence returns to `pending_review`, its
`verificationBasis` is cleared, and a `verification_invalidated` audit event is
written. The new claim must be reviewed again.

## Evidence policy

Evidence types are validated in `evaluateEvidencePolicy`. The important rules:

| Evidence type          | Required support                                                                 |
| ---------------------- | -------------------------------------------------------------------------------- |
| `test_run`             | An existing account-owned `TestRun`, final passed/failed, not `source=demo`, commit must match when supplied |
| `testsprite_execution` | An existing account-owned run whose source is `testsprite` and which has a provider execution id |
| `monitoring_check`     | An existing account-owned monitoring check                                      |
| `deployment_health`    | An existing account-owned monitoring check whose outcome is `success`           |
| `incident`             | An existing account-owned incident record                                       |
| `github_pr`            | A real `https://github.com/owner/repo/pull/N` URL or an imported pull request    |
| `github_check`         | GitHub URL, full 40-character commit SHA, and the observed conclusion in the review note |
| `ci_run`, `build_report` | CI URL or repository-relative artifact, full commit SHA, and observed result   |
| `security_review`      | URL/artifact plus scope, method, date, result, and reviewer (manual review, not an independent audit) |
| `documentation`, `demo` | Safe HTTPS URL or repository-relative path                                     |
| `review_note`          | A dated owner review note of at least 20 characters                             |

External URLs, GitHub checks, CI systems, and TestSprite records are **not
re-fetched** when generating the report. They are stored references; acceptance
is an explicit owner review recorded with actor, timestamp, and basis
(`internal_record`, `reference_review`, or `manual_review`). Reports label this
boundary instead of implying a live re-check.

Artifact references must be repository-relative paths; absolute paths,
traversal, and URLs are rejected. Reference URLs use the same SSRF-safe URL
validator as monitoring targets.

## Readiness

Submission readiness requires all five criteria; 100% reported completion alone
is never enough:

1. All tasks are reported complete.
2. No task is blocked.
3. Every task has at least one evidence record.
4. Every task has evidence-verified completion.
5. No evidence is awaiting review.

The overview displays each criterion with its actual counts. The report repeats
the same criteria and does not describe the project as verified when any is
open.

## Report

The Markdown report is generated from the current database state and includes:

- Executive summary with separate completion and verification percentages.
- Project and source revision (from `VERCEL_GIT_COMMIT_SHA`, `GIT_COMMIT_SHA`,
  or `SOURCE_COMMIT_SHA` when present; otherwise "not recorded").
- One section per phase and task, with descriptions, statuses, timestamps,
  completion notes, evidence, and audit-event counts.
- Security context explicitly separated from security-review evidence.
- Testing, integration, and verification gaps based only on stored evidence.
- Known limitations and the five readiness criteria.
- A conclusion that names outstanding work instead of claiming success.

To produce a PDF, open `/app/delivery/report` and use the browser's print
dialog. There is no server-side PDF pipeline. The download route regenerates
the report at request time.

## Migration and rollout

The feature adds the `20261022023749_delivery_tracker` migration. It is additive:
new tables and new optional relations on `User`; no existing table is rewritten.
Apply it as part of the normal release step:

```bash
DATABASE_URL="<direct>" DIRECT_URL="<direct>" npx prisma migrate deploy
```

No new environment variables are required. After deploying, sign in and visit
`/app/delivery`; the first visit initializes that account's tracker. Verify the
report download and the authenticated 401 response described in `docs/api.md`.

## Local testing

```bash
npm run typecheck
npm run lint
npm test                         # unit + integration
npm run test:e2e                 # Playwright; requires a throwaway database
```

Integration tests reset the database named by `TEST_DATABASE_URL` and re-apply
every migration. Never point `TEST_DATABASE_URL` at production or at the
database in `.env`.

## Known limitations

- Single-owner verification is an owner review, not an independent third-party
  audit. Reports say this explicitly.
- External evidence availability and GitHub/provider state are not re-queried.
- The initial completion statuses are preserved as supplied and are not
  upgraded to verified.
- Attachments are references, not uploaded binaries; no file storage is added.
- There is no assignee model, workflow engine, or cross-project tracker.
- Browser print-to-PDF is the only PDF path.

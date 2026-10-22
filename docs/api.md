# HTTP API surface

All responses from API routes use a consistent error shape:
`{ code, message, requestId }`. List-shaped UI data is queried server-side (React
Server Components); mutations use either API routes or **server actions** (Next.js
encoded endpoints with CSRF protection) — both are documented here.

## API routes

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | public | Liveness. Always 200 when the process answers. |
| GET | `/api/health/ready` | public | Readiness: database, migrations, worker heartbeat. 503 when degraded. Reports only real state. |
| POST | `/api/webhooks/github` | HMAC signature | GitHub webhook receiver. Verifies signature before parsing; dedups by delivery ID; 1 MB cap; processes `pull_request` events. |
| GET | `/api/delivery/report` | Session | Regenerates the delivery/verification report from current records and returns it as a Markdown attachment (`Cache-Control: no-store`). 401 unauthenticated; 429 rate limited; 500 if generation fails. |

### Webhook responses

- `200 { ok: true }` — processed, or duplicate delivery (`{ ok: true, duplicate: true }`).
- `200 { ok: true, ignored: "<event>" }` — event type ignored.
- `401 { code: "invalid_signature", ... }` — bad/missing signature.
- `413` payload too large · `415` wrong content type · `400` missing delivery id / bad payload.
- `503 { code: "not_configured", ... }` — `GITHUB_WEBHOOK_SECRET` unset (endpoint disabled).
- `429` rate limited.

## Server actions (cookie-authenticated, CSRF-protected)

Actions live in `src/app/actions/*.ts` and are invoked by the app's forms:

- **auth**: `registerAction`, `loginAction`, `logoutAction`, `forgotPasswordAction`,
  `resetPasswordAction`, `changePasswordAction`, `revokeSessionAction`,
  `deleteAccountAction`
- **projects**: `createProjectAction`, `updateProjectAction`, `deleteProjectAction`,
  `connectRepoAction`, `disconnectRepoAction`, `saveTestspriteKeyAction`,
  `verifyTestspriteAction`, `runTestsForPrAction`, `retryRunAction`,
  `createMonitoringTargetAction`, `deleteMonitoringTargetAction`, `runCheckNowAction`
- **incidents**: `transitionIncidentAction`, `addIncidentNoteAction`,
  `investigateIncidentAction`, `markNotificationReadAction`,
  `markAllNotificationsReadAction`
- **delivery tracker**: `updateDeliveryTaskStatusAction`,
  `updateDeliveryTaskNotesAction`, `addDeliveryEvidenceAction`,
  `reviewDeliveryEvidenceAction`. These enforce owner scoping, the task state
  machine, the evidence policy, and verification invalidation. Attaching
  evidence only produces `pending_review`; verification requires an explicit
  `verify` decision recorded with an actor and basis.

Authorization: every action re-checks session and resource ownership server-side and
returns 404-equivalent for foreign resources. A public REST surface mirroring these
actions is planned follow-up work (see `docs/decisions.md`).

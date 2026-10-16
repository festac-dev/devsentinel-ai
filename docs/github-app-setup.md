# GitHub App Setup

DevSentinel AI integrates with GitHub through webhooks. The production-recommended
method is a **GitHub App** you own; until one is registered, projects can connect a
repository by owner/name and receive webhooks from any source that signs with
`GITHUB_WEBHOOK_SECRET`. Both paths use the same verified endpoint.

## Two GitHub integrations — do not confuse them

DevSentinel's build involves **two separate GitHub integrations** with different owners
and different jobs:

1. **The TestSprite GitHub App** — installed by the repository owner from the
   TestSprite 3.0 portal (Portal → Settings → GitHub App; setup guide:
   https://docs.testsprite.com/web-portal/integrations/github-integration). It is
   what generates the **TestSprite comment/status check on pull requests**. It is
   configured entirely in the TestSprite portal; DevSentinel does not manage it,
   cannot trigger it, and does not impersonate it.
2. **DevSentinel's own GitHub App / token** — registered by you (below). It delivers
   `pull_request` events to DevSentinel's webhook and lets DevSentinel publish **its
   own** commit statuses. A status published by DevSentinel is labeled as
   DevSentinel's in the dashboard; it is never presented as a TestSprite check, and
   DevSentinel never claims a TestSprite check exists on a PR unless it observed one
   through a documented mechanism.

For the hackathon submission requirement (a PR carrying a TestSprite comment/status),
integration 1 is the one that matters; integration 2 is DevSentinel's own feature.

## Endpoint

```
POST https://<your-host>/api/webhooks/github
```

Behavior (all implemented and unit-tested):

- HMAC-SHA256 signature verification (`X-Hub-Signature-256`) over the **raw** body with
  constant-time comparison, **before** JSON parsing;
- `X-GitHub-Delivery` deduplication with a persisted delivery log (replays are
  acknowledged, not reprocessed);
- 1 MB body cap and `application/json` content-type check;
- `pull_request` events processed; `ping`, `installation`, `installation_repositories`
  accepted; all other events logged as ignored;
- fast acknowledgment after durable enqueue; 5xx only when processing genuinely failed
  (GitHub will retry; handlers are idempotent).

## Recommended: register a GitHub App

1. Create the App at https://github.com/settings/apps/new (documentation:
   https://docs.github.com/en/apps/creating-github-apps).
2. **Webhook URL**: `https://<your-host>/api/webhooks/github`; content type
   `application/json`; set a strong secret and put the same value in
   `GITHUB_WEBHOOK_SECRET`.
3. **Permissions (least privilege)**:

   | Permission | Level | Why |
   | --- | --- | --- |
   | Repository metadata | Read-only | Resolve repository full names, default branches |
   | Pull requests | Read-only | Receive `pull_request` events (title, branches, head SHA) |
   | Commit statuses | Read & write | Publish **DevSentinel's own** results as commit statuses |
   | Contents | Read-only | Only if you later extend tests to read repo files — not required today |

   No administration, no secrets read, no workflows write.
4. **Subscribe to events**: `pull_request` only (add `push` only if you later want
   default-branch run triggering; add `installation` / `installation_repositories` to
   auto-track access changes).
5. Record the App ID (`GITHUB_APP_ID`), client ID/secret
   (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`), and private key
   (`GITHUB_APP_PRIVATE_KEY`, PEM) in your environment. **Restart/redeploy is required
   after changing any of these.**
6. Install the App on the repositories you want monitored; then use **Connect GitHub** on
   the project page in DevSentinel to pick the repository.

## Per-account connection (Connect GitHub)

Every DevSentinel account sees and links **only its own** repositories. Nothing is shared
between accounts, even though they all use the same GitHub App.

Set `GITHUB_APP_SLUG` (the last part of `https://github.com/apps/<slug>`) together with
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`. Then, in the GitHub App settings:

1. Set **Callback URL** to `https://<your-host>/api/github/callback` (and keep the
   **Setup URL** at the same address). Tick **Request user authorization (OAuth) during
   installation** if you like — the callback handles both flows.
2. On a project page, **Connect GitHub** sends the user to GitHub sign-in. DevSentinel
   exchanges the returned `code` and asks GitHub which installations of the App that user
   can access (`GET /user/installations`); only those are stored for the account.
3. If the user has no installation yet they are sent to the App's install page, and GitHub
   returns to the same callback, which repeats step 2.
4. The repository picker lists repositories **only from the installations stored for the
   signed-in account**. Linking re-checks with GitHub that the repository is covered by one
   of them, ignoring anything the browser submits. A repository can belong to only one
   account at a time.
5. Connecting by name is allowed only with a token that has push access to the repository
   (typing a name alone never links anything).

The `state` is signed, 15 minutes long, and bound to the user and project. Organization
installs that need an owner's approval return `setup_action=request`; the project page
explains this and the user can retry once approved.

Caveat: access is proven per installation, not per repository. For an organization
installation, any member who can see the installation could pick any repository it covers.
For personal accounts this is exact.

## Publishing commit statuses

Commit statuses are published with a **repository access token** stored per project
(encrypted with AES-256-GCM; the UI shows only the last four characters). A fine-grained
personal access token with "Commit statuses: Read and write" on the target repository is
sufficient. Alternatively, when the server has `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` configured and the repository connection records an
installation id, DevSentinel mints a short-lived **GitHub App installation token**
(RS256 app JWT → `POST /app/installations/:id/access_tokens`, cached until shortly
before expiry) — no PAT is needed. Credential resolution order: per-project PAT
first, then the installation token; with neither, the publication is recorded as
`not_configured` and never claimed as published.

Publication rules enforced in code:

- statuses are always created against **the run's own commit SHA** (never the branch
  head);
- before publishing, the PR's current head SHA is re-read; a stale run records a
  `skipped_stale` publication instead;
- a publication is marked `published` **only** when GitHub's API responds 2xx (response
  id stored); otherwise `failed` with the real (redacted) reason, or `not_configured`
  when no token is set.

## Verification

- `tests/unit/webhook.test.ts` covers valid, invalid, missing, tampered signatures and
  payload shapes.
- The Integrations page shows webhook-secret configuration status and the exact webhook
  URL per connected repository.

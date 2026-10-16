# TestSprite Integration Research

**Researched against official sources before implementation.** Every adapter behavior in
`src/modules/testsprite/provider.ts` maps to a documented CLI behavior below. Anything
not verifiable from official documentation is marked **unverified** and is not relied on.

## Sources

- TestSprite website: https://www.testsprite.com/
- Documentation hub: https://www.testsprite.com/docs (docs.testsprite.com, "CLI →
  Getting started overview")
- API key dashboard: https://www.testsprite.com/dashboard/settings/apikey
- Official CLI repository and full command reference:
  https://github.com/TestSprite/testsprite-cli (`DOCUMENTATION.md`), npm package
  `@testsprite/testsprite-cli` (v0.14.0 used by this build)

## What the official interface is

TestSprite's documented programmatic surface is the **official CLI** plus the
TestSprite MCP server and portal. The CLI:

- authenticates with an API key from the dashboard; non-interactive use reads the
  `TESTSPRITE_API_KEY` environment variable (documented in `DOCUMENTATION.md →
  Configuration`: "TESTSPRITE_API_KEY / TESTSPRITE_API_URL env vars override the file,
  so CI can run without ever touching ~/.testsprite/credentials");
- is stateless and scriptable: "Every command supports `--output json` for
  machine-readable output. … the TestSprite backend is the source of truth"
  (`DOCUMENTATION.md → Design principles`);
- defines documented **exit codes** (0 success; 1 non-passed run; 3 auth/scope; 4 not
  found; 5 validation; 6 conflict; 7 timeout/unsupported; 10 service unavailable; 11
  rate limited; 12 insufficient credits; 13 feature gated; 14 client too old).

No public REST API for third-party direct HTTP calls is documented. **We therefore call
the CLI, not undocumented endpoints.**

## Commands used by DevSentinel

| Adapter operation | CLI invocation | Documentation basis |
| --- | --- | --- |
| Configuration check | local only (reads stored config, resolves CLI binary) | — |
| Credential verification | `testsprite project list --output json` | documented read command |
| Start a run (first time) | `testsprite test create --project <id> --plan-from <plan.json> --run --wait --timeout <s> --output json` | `test create` documented with plan-file format; `--run --wait` documented: exit 0 passed, 1 failed/blocked/cancelled, 7 timeout |
| Start a run (subsequent) | `testsprite test run <test-id> --wait --timeout <s> --output json` | documented; without a stored test id we create one from an authored plan and store its id for reuse |
| Fetch results | `testsprite test result <test-id> --output json` | documented: status, started/finished, video + failure-analysis URLs, summary counts, `runIdIfAvailable` |
| Retry | new run row + `test run`/`test create` (retry lineage stored in our DB) | documented `test rerun` exists but reruns the *latest* run of a test; we bind retries to our run rows instead — design choice, documented here |
| Cancel | `test cancel` exists in the CLI docs; **not wired** — our worker cannot assume credential context; UI reports cancellation honestly as not performed | partially verified |

## Plan file format (verified)

Authored plans follow the CLI's documented schema (also shipped at
`schemas/plan.schema.json` in the CLI repo): `{ projectId, type: "frontend", name,
planSteps: [{ type: "action"|"assertion", description }] }`, 1–200 steps. DevSentinel
builds this file from the project's settings (one step per line, `assert:` prefix for
assertions) and defaults to a smoke plan when the user has not authored steps.

## Result mapping (verified against the CLI v0.14.0 source, dry-run samples, and live CLI runs)

Mapping rules are continuously verified in `tests/integration/testsprite-cli.test.ts`:
it drives the REAL pinned CLI (`@testsprite/testsprite-cli` from node_modules —
argument handling, HTTP client, response schemas, long-poll loop, exit codes)
against a local stub of the documented `/api/cli/v1` endpoints, through the
provider's production invocation path. The real api.testsprite.com error paths
(invalid-key `AUTH_INVALID` envelope, exit 3) were verified live and match.

Three distinct JSON shapes reach the adapter; each is handled explicitly:

- **`test run <id> --wait --output json`** prints a flat **RunResponse**:
  `runId`, `testId`, `projectId`, `status` (`queued|running|passed|failed|blocked|
  cancelled`), `startedAt`, `finishedAt`, `failedStepIndex`, `failureKind`, `error`
  (raw failure text for failed/blocked runs — a plain string, NOT a provider error),
  and per-run counts in **`stepSummary: { total, completed, passedCount, failedCount }`**.
- **`test create --plan-from <file> --run --wait --output json`** prints the merged
  envelope **`{ ...createResponse, run: <RunResponse> }`**: the created test's fields
  (`testId`, `projectId`, `type`, `codeVersion`, `createdAt`) at the top level and the
  final RunResponse nested under `run` — the run's status/counts live under `run`,
  never at the top level.
- **`test result <id> --output json`** prints a flat **CliLatestResult**: `testId`,
  `status`, `verdict`, `executionStatus`, `startedAt`, `finishedAt`,
  `runIdIfAvailable`, and `summary` as a one-line STRING (the CLI replaced the former
  `{passed,failed,skipped}` count object with it — no numeric counts are available here).
- Operational failures print an ApiError envelope on **stderr**:
  `{ error: { code, message, nextAction, … } }` — an `error` OBJECT is a provider
  error; an `error` string is the run's own failure text.
- **`project list --output json`** returns the documented Page shape
  `{ items: [...], nextToken }` (OpenAPI `ProjectList`), not `{ projects }`.

Mapping rules implemented (`src/modules/runs/status.ts`):
  - `passed`/`success` → Passed; `failed` → Failed; `cancelled` → Cancelled;
    `blocked`/`skipped` → Unknown (never presented as pass or fail);
  - a run's string `error` becomes the run's failure reason (status stays
    `failed`) — it is never converted into a provider error;
  - exit 7 / our wait-timeout → **Error** with reason "timeout" (timeout is never passed);
    on a poll deadline the CLI prints the LAST non-terminal poll row to stdout — the
    adapter trusts the exit code there and reports Error, never `running` (verified live);
  - exit 3/10/11/12/13 → **Error** with the real reason;
  - exit 0 with unparseable JSON → **Unknown** with "result unavailable";
  - provider error envelopes → **Error** with the redacted message.

## GitHub workflow supported by TestSprite — and the two-GitHub-integrations rule

Two separate GitHub integrations exist in this build, and they are never conflated:

1. **The TestSprite GitHub App** (verified:
   https://docs.testsprite.com/web-portal/integrations/github-integration) — installed
   by the repository owner from the TestSprite 3.0 portal. Per the official docs it:
   listens for a **deployment event** in your repo (a PR preview deployment or a
   branch deployment your CI/CD produces), resolves the target URL from that
   deployment or a URL pattern you define (`{pr}`, `{branch}`, `{sha}`, …), runs the
   suite, and posts results back as **a PR comment** (Pull Request trigger — the
   `testsprite-dev` comment) or **a commit check** (Push to Branch trigger). The
   optional **"Block PR until tests pass"** toggle is the hackathon's "Blocking PRs"
   (scored, not required). It is owner-managed portal configuration; DevSentinel
   cannot trigger it and never impersonates it.
2. **DevSentinel's own integration** — the verified webhook plus DevSentinel's own
   status publishing (see `docs/github-app-setup.md`). DevSentinel records PR/commit
   data, drives TestSprite through the CLI, and publishes **its own** commit statuses
   against the run's SHA; a DevSentinel status is never presented as a TestSprite
   check, and DevSentinel does not claim a TestSprite check exists unless it observed
   one through a documented mechanism.

The CLI also documents a GitHub Actions path (`ci init` scaffolds a workflow that runs
TestSprite on pushes to the default branch, with `TESTSPRITE_API_KEY` as a repo
secret). That is a push-based flow; DevSentinel's PR-triggered flow drives the same
CLI from our worker instead.

## Hackathon order of operations (Season 4 rules)

The TestSprite PR check runs the suite that already exists — it must be generated
BEFORE the first PR, against a live app. Order matters:

1. **Deploy DevSentinel AI to a public URL first** (it must stay reachable for the
   whole build window — TestSprite runs against the live app, not localhost). The
   TestSprite GitHub App's PR trigger additionally needs the PR to produce a **preview
   deployment** (Vercel/Amplify-style) whose URL it can test.
2. **Generate the test suite in the TestSprite 3.0 web portal** against the live URL.
3. **Connect the GitHub integration and install the TestSprite GitHub App** on the
   repository, then add a Pull Request trigger with the preview-URL pattern
   (Workspace Settings → Connections → Integrations → GitHub; project → GitHub Action
   tab → Add Trigger).
4. Optionally enable **"Block PR until tests pass"** (scored, not required).
5. **Open pull requests** — every PR during the build window then carries the
   TestSprite check; the submission PR(s) must be opened inside the window
   (Oct 16–22).

Using the same TestSprite account for suite generation, the GitHub App install, and
any regeneration is a submission requirement (account-match rule).

## What is deliberately NOT implemented

- No fabricated test summaries, counts, or failure messages. If the provider returns
  nothing, the UI shows "Result unavailable".
- No claim that queued ≠ passed: `queued` and `running` are display statuses of their own.
- No undocumented endpoint calls; no scraping of the TestSprite portal.

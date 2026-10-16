# Hackathon Demonstration Guide (~3 minutes)

**Principle: everything shown is real.** If a prerequisite is missing, use the fallback
scripted below — the honest boundary is itself part of the story.

## Required setup

1. DevSentinel deployed (or `npm run dev` + `npm run worker` locally) with
   `GITHUB_WEBHOOK_SECRET` and `ENCRYPTION_KEY` set, and the webhook configured on a
   sample repository **you control** (never a public production app).
2. TestSprite API key + project ID configured on the project, plus a deployed target URL
   (e.g. the staging URL of the sample app). Full steps: README "Quick start".
3. Optional: GitHub token (commit-status write) on the project for status publishing.

## Script

| Time | Action | What to say |
| --- | --- | --- |
| 0:00–0:20 | Open the landing page; click **Get Started**, register. | "DevSentinel connects PRs to real TestSprite runs bound to exact commits." |
| 0:20–0:50 | Create a project; connect the sample repository; paste the TestSprite API key; hit **Verify**. | "Credentials are encrypted at rest and write-only." |
| 0:50–1:20 | Open a pull request on the sample repo. Show DevSentinel: Pull Requests page now lists it with the head SHA; Test Runs shows a queued → running run. | "The webhook was HMAC-verified and deduplicated; the run is bound to this exact SHA." |
| 1:20–2:00 | Open the run detail: real status from TestSprite, summary counts, provider output. If it fails — show the failure evidence and open the auto-created incident. | "Queued never means passed. This is the provider's actual result." |
| 2:00–2:40 | Push a fix commit to the PR. Refresh: the new commit gets its own run; the old run is now **Stale** with the tooltip naming both SHAs; the PR page's "Current result for head …" refers only to the new head. | "A pass on commit A can never validate commit B." |
| 2:40–3:00 | Show Monitoring (a target with real checks) or the Integrations page (worker heartbeat, honest per-integration status). | "Everything on screen is either real or explicitly labeled unconfigured." |

## Fallbacks

- **No TestSprite credentials**: run the flow anyway — the run ends in `error` with the
  real "TestSprite not configured" reason; demo the webhook delivery log, SHA binding,
  and staleness (all real), and show `docs/testsprite-integration.md` for the verified
  integration design. **Do not** present simulated data as provider results — the only
  simulated records are the seed's, always labeled `Simulated demonstration` (see Labeling).
- **GitHub webhook cannot reach the host**: use a tunnel (e.g. `ngrok http 3000`) and
  reconfigure the webhook URL, or demonstrate the delivery log by re-delivering an event
  from a previously configured repo.
- **Worker not running**: the Integrations page will honestly show "not running" — start
  it and refresh to show the heartbeat flip to "running".
- **Nothing to show (fresh environment)**: run `npm run db:seed` (after migrations). It
  creates the representative "Sample App" project (octocat/sample-app #42) with three
  runs — a failure on the PR's current head plus its auto-opened incident — and a demo
  login (`demo@devsentinel.example` / `DemoPassw0rd`). Seeded runs carry source `demo`
  and are labeled `Simulated demonstration` (see Labeling); never present their numbers
  as provider results.

## Labeling

Flows driven by real webhooks, the worker, and the TestSprite CLI produce real labels.
The one exception is the seed (`npm run db:seed`): its runs use source `demo`, and every
surface renders that as `Simulated demonstration`, so seeded data can never be mistaken
for provider results.

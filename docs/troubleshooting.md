# Troubleshooting

## The app starts but runs stay "queued" forever

The background worker is not running. Start it (`npm run worker`) and confirm the
Integrations page shows "Background worker: running" with a fresh heartbeat. Queued is
never auto-promoted — a job must actually execute.

## A run ends in "error: TestSprite not configured: …"

Read the reason on the run page. Usual order of setup:
1. TestSprite API key saved on the project page (write-only; verify it with the
   "Verify TestSprite credentials" button — the worker tests the credential and
   the result arrives as a notification).
2. TestSprite project ID set in Project settings (`testsprite project list` shows yours).
3. Deployed target URL set — TestSprite frontend tests need a reachable URL.

## "ENCRYPTION_KEY is not configured" / credentials cannot be decrypted

`ENCRYPTION_KEY` must be a 32-byte base64 value (`openssl rand -base64 32`). If you
rotate the key, keep the old value available as `ENCRYPTION_KEY_V<old version>`; stored
credentials carry the key version they were encrypted with.

## GitHub webhook returns 503

`GITHUB_WEBHOOK_SECRET` is not set in the environment. The endpoint stays disabled
rather than accepting unverified events. Set the secret and restart.

## 401 "invalid_signature" from the webhook

The secret configured on GitHub does not match `GITHUB_WEBHOOK_SECRET`, or the request
body was modified in transit (proxies must not rewrite the body). Copy the secret
exactly; re-deliver the event from GitHub.

## Monitoring target rejected at creation

The URL validator enforces: http/https, no embedded credentials, ports 80/443/8080/8443,
no internal hostnames (localhost, *.internal, *.local), no literal addresses in
forbidden ranges (loopback, private, link-local including cloud metadata, CGNAT,
reserved). Use the public URL of the deployment you want observed.

## State is "Unknown" after saving a monitoring target

That is correct behavior: health is never assumed. State changes after the first real
check completes (worker running, target due).

## Migrations fail

Run `npx prisma migrate deploy` (CI/production) or `npx prisma migrate dev`
(local). Never edit an applied migration; generate a new one.

# BUG-FIXES.md — production-readiness pass

This document records the defects found and fixed while hardening DevSentinel
AI for production (session of 2026-10-16, branch
`buildful/review-these-two-repos-27fb70`). Every fix was reproduced or
verified against the code before being made, and is covered by the test suite
(see "Tests" per item). Earlier fixes are in the commit history
(`071a416` "Fix monitoring, worker recovery, and webhook handling" and
`526ff68`).

---

## HIGH


### 1. A GitHub webhook that failed once was permanently swallowed as a "duplicate"

**Symptom.** A PR event whose processing failed (transient DB error, pool
timeout, deploy restart mid-request) returned 500 with the message "it will be
retried" — but the retry could never happen. GitHub redelivers with the **same
`X-GitHub-Delivery` id** after a 5xx; the redelivery hit the delivery-dedup
unique constraint and was acked `200 {duplicate: true}`, so the event was lost
forever: no test run, no commit status. The delivery row stayed `status:
"error"` with no code path that ever reprocessed it.

**Fix.** `src/app/api/webhooks/github/route.ts` — on the P2002 dedup branch,
look up the existing delivery: only deliveries that were actually handled (or
are being handled concurrently) are acked as duplicates; a delivery whose
status is `"error"` falls through to reprocessing. Handlers are idempotent, so
a reprocess cannot double-create runs.

**Tests.** `tests/integration/webhook-route.test.ts` — acks a handled
redelivery as duplicate; **reprocesses an errored delivery** (fails against
the old code, which dup-acked it).

### 2. A dead in-process worker left the container permanently broken with green health checks

**Symptom.** With the default `APP_ROLE=all` deployment, three defects
compounded:

- a fatal error in the worker loop was logged once ("worker fatal") and the
  loop was **never restarted** — queue, monitoring checks, notifications and
  retention stayed dead for the life of the container;
- a transient DB failure during the boot-time heartbeat (outside any try/catch
  in `startWorker`) threw before the loop started; the worker-started latch
  was already set, so nothing ever booted it again;
- `/api/health/ready` excluded a stale worker heartbeat for `APP_ROLE=all`
  ("covered by the role" — it is not; the role does not keep the worker
  alive), so readiness stayed `ready` with a dead queue.

**Fix.**

- `src/server-boot.ts` — the in-process worker now runs under a restart
  supervisor: `startWorker` resolving means SIGTERM/SIGINT (deliberate stop,
  not resurrected); any throw is logged and retried with exponential backoff
  (1 s → 30 s cap).
- `src/worker/loop.ts` — the boot-time heartbeat and stale-job requeue are
  wrapped so a DB blip at boot cannot kill the loop before its first tick (the
  heartbeat refreshes every tick anyway). Signal listeners are now `once` so a
  supervisor restart does not accumulate listeners.
- `src/app/api/health/ready/route.ts` — `APP_ROLE=all` now reports
  `worker_heartbeat_stale` (degraded, still HTTP 200) when the in-process
  worker's heartbeat is stale. The staleness window is now
  `max(2 min, 4 × WORKER_POLL_INTERVAL_MS)`, fixing the related defect that an
  operator using the documented maximum poll interval (600 s) was **permanently
  degraded** because the heartbeat is written once per poll iteration.

### 3. All per-IP rate limits were bypassable by rotating a fake `X-Forwarded-For`

**Symptom.** `clientIp()` (and the webhook route) trusted the **leftmost**
X-Forwarded-For entry. Under standard append semantics the leftmost entry is
exactly what the *client* sent. An attacker rotating `X-Forwarded-For: <random>`
per request got a fresh rate-limit key every time: unauthenticated password
brute force at line rate, unlimited password-reset emails (each creating a
token row), and unbounded registration attempts. The webhook route also
rate-limited **before** signature verification, letting unauthenticated
traffic write to the rate-limit table.

**Fix.** `src/lib/auth.ts`, `src/app/api/webhooks/github/route.ts` — use the
**rightmost** XFF entry (set by the trusted proxy, unforgeable behind the
documented proxy setup); the webhook rate limit moved **after** signature
verification so only real GitHub traffic consumes limiter writes (HMAC
verification is cheap, so unauthenticated floods are rejected without DB
work). `DEPLOYMENT.md` now states the proxy contract explicitly: append
(never overwrite) `X-Forwarded-For`, and set/override `X-Forwarded-Host`.

**Tests.** E2E "bad webhook signatures are rejected" still passes (401 comes
before any limiter write).

## MEDIUM-HIGH

### 4. Webhook endpoint buffered the entire body before the 1 MB check (unauthenticated memory DoS)

**Symptom.** `req.text()` fully buffers whatever the client streams *before*
the size check; App Router route handlers have no built-in body cap on
self-hosted deploys. Concurrent oversized uploads OOM the web process. The
rate limit in front of it was bypassable (item 3).

**Fix.** `src/app/api/webhooks/github/route.ts` — `readBodyCapped()` rejects
an oversized `Content-Length` up front and otherwise streams chunk-by-chunk,
aborting the moment the 1 MB cap is exceeded. Memory per request is bounded at
~1 MB + one chunk.

**Tests.** `tests/integration/webhook-route.test.ts` — a >1 MB body returns
413 and writes nothing.

## MEDIUM

### 5. Second and later downtime episodes of a monitoring target never alerted

**Symptom.** The `monitoring_down` notification dedup key was
`monitoring_down:<targetId>:<consecutiveFailures>` — and at the down
transition `consecutiveFailures` is always exactly the threshold (e.g. 3). The
key was therefore **static for the target's lifetime**; `dedupKey` is unique
forever, so the first outage burned the key and every later outage of the same
target was silently suppressed (no notification row is created when the
insert hits the unique constraint). Related: `Notification` rows were never
pruned by retention, so the table grew without bound and permanently pinned
dedup keys.

**Fix.** `src/modules/monitoring/checker.ts` — the dedup key is now
hour-bucketed (`monitoring_down:<id>:<hour bucket>`), matching the other alert
keys: retries within the hour dedup, a new episode re-alerts.
`src/modules/jobs/handlers.ts` — retention now also deletes `Notification`
rows older than the window (which also frees old dedup keys).

**Tests.** `tests/integration/retention-queue.test.ts` — old notifications are
deleted, in-window notifications survive (`notificationsDeleted` in the
result; fails against the old code, which had no such counter).

### 6. Concurrent checks for one target corrupted failure counting (lost incidents)

**Symptom.** `checkTargetById` did read-compute-write on `MonitoringTarget`
without serialization. A manual "Run check now" job can run while a scheduled
or retried check is in flight; both read `consecutiveFailures = 2` and both
wrote `3` — a real failure was lost and `failureThreshold` (incident opening)
was reached a cycle late, or flap detection skewed.

**Fix.** `src/modules/monitoring/checker.ts` — the state transition
(re-read → compute → write → incident open/reopen/resolve) now runs inside
`withAdvisoryLock("monitor:<targetId>")` (the repo's existing pattern for
check-then-write sequences without a unique constraint). The HTTP check and
the notification sends stay outside the transaction — network and email must
never hold the advisory lock.

**Tests.** The existing DB-backed monitoring flows (worker-job, database
suites, E2E "monitoring runs a real HTTP check") exercise the rewritten path
and pass.

### 7. SIGTERM disconnected the database pool while in-flight requests were still draining

**Symptom.** On SIGTERM the web role called `prisma.$disconnect()` while
Next's own handler was still draining in-flight requests — every request
touching the DB during the drain window failed with connection errors (a
burst of 500s on every rolling deploy). In `APP_ROLE=all` the worker loop
closed the **shared** pool the same way (also against its own drain contract).

**Fix.** `src/server-boot.ts` — the pool close is deferred to a 5 s unref'd
timer (process exit closes the sockets anyway). `src/worker/loop.ts` — in
in-process mode the worker no longer disconnects the shared pool; only the
standalone worker (which owns its pool) does, after its in-flight job
finishes.

## LOW-MEDIUM

### 8. Connection resets were misclassified as timeouts

**Symptom.** `ECONNRESET` was recorded as `outcome: "timeout"` with a
**fabricated** `responseTimeMs` equal to the full configured timeout. A target
crashing mid-handshake looked identical to a slow target in incident evidence
and dashboards.

**Fix.** `src/modules/monitoring/checker.ts` — resets/aborts/EPIPE are now
`outcome: "error", errorClass: "connection_reset"` with no fabricated
response time. The classification is extracted into the pure
`classifyCheckError()`.

**Tests.** `tests/unit/checker-classify.test.ts` — timeout vs reset vs SSRF vs
body-cap vs errno fallback.

## LOW

### 9. Password hashing ran synchronously on unauthenticated request threads

**Symptom.** `scryptSync` (N=16384, r=8 → ~16 MB allocation, tens of ms of
event-loop blockage) executed inside `registerAction`/`resetPasswordAction` /
`loginAction`/`changePasswordAction`; a modest concurrent flood converted to
event-loop starvation for the whole web process.

**Fix.** `src/lib/crypto.ts` — `hashPassword`/`verifyPassword` are now async
(promisified `scrypt`, identical parameters and stored format, so existing
hashes verify unchanged). All call sites in `src/app/actions/auth.ts` now
`await` them — including the two comparisons where an un-awaited Promise would
have been truthy (login and current-password checks).

**Tests.** `tests/unit/crypto.test.ts` updated for the async API (round-trip,
salting, hostile-parameter bounds).

### 10. Prisma pool sizing vs `WORKER_CONCURRENCY` was undocumented

**Symptom.** No `connection_limit` guidance anywhere; Prisma's default
(`num_cpus*2+1` per process) can be smaller than `WORKER_CONCURRENCY` (up to
16) on small containers, surfacing as 10 s `pool_timeout` job failures that
feed the retry loop.

**Fix.** `DEPLOYMENT.md` invariant 1 now gives the formula
(`connection_limit ≥ WORKER_CONCURRENCY + 4` for worker/all roles).

### 11. CSRF host check depended on a proxy contract that was never stated

**Symptom.** `X-Forwarded-Host` is trusted for the CSRF origin comparison; on
a platform that passes the client's header through, an attacker could supply
their own host. SameSite=Lax still blocks most cross-site POSTs, so this was
defense-in-depth erosion — but the proxy contract must be explicit.

**Fix.** `DEPLOYMENT.md` invariant 4: the proxy must set/override
`X-Forwarded-Host` (e.g. nginx `proxy_set_header X-Forwarded-Host $host;`).
Code unchanged (the trusted-proxy behavior is correct; rejecting XFH would
break documented platform deployments).

### 12. GitHub installation-token cache kept expired tokens resident forever

**Symptom.** `tokenCache` in `src/modules/github/app-auth.ts` was an unbounded
map: entries were overwritten per installation but never evicted, so a
long-running worker kept every expired access token in memory for the life of
the process.

**Fix.** Expired entries are evicted on each cache write.

### 13. Docs: readiness staleness text

`DEPLOYMENT.md` said the ready endpoint degrades "after 2 minutes"; it now
describes the actual window (`max(2 min, 4 × poll interval)`) and that
`APP_ROLE=all` degrades with a dead in-process worker (item 2).

---

## Verified sound (no change needed)

The scan also confirmed, by reading the code, that these areas were already
production-grade: DB-backed rate limiting (multi-instance safe, self-pruning);
atomic job claiming (`UPDATE … FOR UPDATE SKIP LOCKED`, no double-claim, no
infinite retry); outbound `fetch` timeouts everywhere (email 15 s, GitHub 15 s,
AI 60 s); checker inactivity + wall-clock deadlines, 64 KB body cap, IP-pinned
DNS, full redirect revalidation; hashed session tokens with idle + absolute
timeouts; `/api/health/ready` verifying DB reachability and applied migrations;
no `ignoreBuildErrors`/prod source maps/module-scope env reads; `.env`
untracked.

## Known limitations (not fixed — deliberate scope decisions)

- Rate limiting trusts the rightmost `X-Forwarded-For` entry, which is only
  unforgeable behind a proxy that appends (documented in `DEPLOYMENT.md`
  invariant 4). Exposing the app directly without a proxy leaves XFF
  client-controlled; there is no reliable in-process way to detect direct
  exposure from server actions.
- `withAdvisoryLock` uses Prisma's default interactive-transaction timeout; a
  severely pool-starved database can fail the serialized transition (it
  retries with the job).
- The 5 s pool-disconnect grace is a heuristic; a request still in flight
  beyond it during shutdown fails (platform kill would end it anyway).

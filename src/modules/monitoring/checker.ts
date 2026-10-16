/**
 * The monitoring checker: performs ONE safe HTTP check against a target.
 * Connects to the DNS-resolved, validated IP (pinned) to defeat rebinding,
 * revalidates every redirect, caps redirects/body size, sets timeouts.
 */

import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { Agent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { lookup } from "node:dns";
import { Prisma } from "@prisma/client";
import { prisma, withAdvisoryLock } from "@/lib/db";
import { isForbiddenIp, validateMonitorUrl, resolveRedirect, MAX_REDIRECTS } from "@/modules/monitoring/ssrf";
import { notify } from "@/modules/notifications/send";

const BODY_CAP_BYTES = 64 * 1024;

export type CheckOutcome = "success" | "failure" | "timeout" | "error";

export type CheckResult = {
  outcome: CheckOutcome;
  statusCode?: number;
  responseTimeMs?: number;
  errorClass?: string;
  redirectedTo?: string;
  bodySample?: string;
};

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;

/**
 * DNS lookup that validates every resolved address against the SSRF blocklist
 * before Node connects — this pins the connection to a validated IP and defeats
 * DNS rebinding. Supports both the classic (address, family) and the
 * autoSelectFamily (address array) callback shapes.
 */
function lookupGuarded(
  hostname: string,
  options: { family?: number; all?: boolean },
  cb: LookupCallback
) {
  lookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`No addresses resolved for ${hostname}`);
      e.code = "EHOSTFORBIDDEN";
      return cb(e);
    }
    const forbidden = list.find((a) => isForbiddenIp(a.address));
    if (forbidden) {
      const e: NodeJS.ErrnoException = new Error(
        `DNS resolved ${hostname} to forbidden address ${forbidden.address}`
      );
      e.code = "EHOSTFORBIDDEN";
      return cb(e);
    }
    if (options.all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

function fetchOnce(
  url: URL,
  method: "GET" | "HEAD",
  timeoutSeconds: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; redirectedTo?: string; timeMs: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const isHttps = url.protocol === "https:";
    const options = {
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + url.search,
      method,
      headers: { Host: url.host, "User-Agent": "devsentinel-monitor/1.0", Accept: "*/*" },
      agent: isHttps
        ? new HttpsAgent({ lookup: lookupGuarded as never, rejectUnauthorized: true })
        : new Agent({ lookup: lookupGuarded as never }),
    };
    const req = (isHttps ? httpsRequest : request)(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (d: Buffer) => {
        size += d.length;
        if (size <= BODY_CAP_BYTES) chunks.push(d);
        if (size > BODY_CAP_BYTES) req.destroy(new Error("body-too-large"));
      });
      res.on("end", () => {
        const headers: Record<string, string | string[] | undefined> = res.headers;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Buffer.concat(chunks).toString("utf8"),
          redirectedTo: typeof res.headers.location === "string" ? res.headers.location : undefined,
          timeMs: Date.now() - started,
        });
      });
      res.on("error", reject);
    });
    req.setTimeout(timeoutSeconds * 1000, () => {
      req.destroy(new Error("timeout"));
    });
    // Wall-clock deadline: req.setTimeout is an inactivity timeout, so a server
    // that never stops sending bytes would keep this request alive forever.
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutSeconds * 1000 + 1000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}

/** Map a failed HTTP attempt to an honest check result (pure; unit-tested). */
export function classifyCheckError(e: NodeJS.ErrnoException, timeoutSeconds: number): CheckResult {
  if (e.message === "timeout" || e.code === "ETIMEDOUT") {
    return { outcome: "timeout", errorClass: "timeout", responseTimeMs: timeoutSeconds * 1000 };
  }
  if (e.code === "ECONNRESET" || e.code === "ECONNABORTED" || e.code === "EPIPE") {
    // A hard connection failure (refused, killed mid-handshake) is not a
    // timeout: recording it as one fabricates a response time equal to the
    // full configured timeout and hides the real failure class.
    return { outcome: "error", errorClass: "connection_reset", bodySample: String(e.message).slice(0, 300) };
  }
  if (e.code === "EHOSTFORBIDDEN") {
    return { outcome: "error", errorClass: "ssrf_blocked", bodySample: e.message };
  }
  if (e.message === "body-too-large") {
    return { outcome: "error", errorClass: "body_too_large" };
  }
  return { outcome: "error", errorClass: e.code ?? "network_error", bodySample: String(e.message).slice(0, 300) };
}

export async function runCheck(
  target: { url: string; method: string; timeoutSeconds: number; expectedStatus: number; expectedBody: string | null }
): Promise<CheckResult> {
  const validation = validateMonitorUrl(target.url);
  if (!validation.ok) {
    return { outcome: "error", errorClass: "invalid_url", bodySample: validation.error };
  }

  let current = validation.url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    let res: Awaited<ReturnType<typeof fetchOnce>>;
    try {
      res = await fetchOnce(current, target.method === "HEAD" ? "HEAD" : "GET", target.timeoutSeconds);
    } catch (err) {
      return classifyCheckError(err as NodeJS.ErrnoException, target.timeoutSeconds);
    }

    // Redirects: 3xx with a Location header must be revalidated fully.
    if (res.status >= 300 && res.status < 400 && res.redirectedTo) {
      const next = resolveRedirect(current, res.redirectedTo);
      if (!next.ok) {
        return { outcome: "error", errorClass: "redirect_blocked", redirectedTo: res.redirectedTo.slice(0, 200), bodySample: next.error };
      }
      current = next.url;
      continue;
    }

    const expected = target.expectedStatus;
    const bodyOk = target.expectedBody ? res.body.includes(target.expectedBody) : true;
    return {
      outcome: res.status === expected && bodyOk ? "success" : "failure",
      statusCode: res.status,
      responseTimeMs: res.timeMs,
      redirectedTo: current.toString() !== validation.url.toString() ? current.toString() : undefined,
      bodySample: target.method === "GET" ? res.body.slice(0, 500) : undefined,
    };
  }
  return { outcome: "error", errorClass: "too_many_redirects" };
}

/** Run a check for a stored target, record it, and evaluate state/incidents. */
export async function checkTargetById(targetId: string): Promise<CheckResult> {
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) throw new Error("Monitoring target not found.");

  const result = await runCheck({
    url: target.url,
    method: target.method === "HEAD" ? "HEAD" : "GET",
    timeoutSeconds: target.timeoutSeconds,
    expectedStatus: target.expectedStatus,
    expectedBody: target.expectedBody,
  });

  await prisma.monitoringCheck.create({
    data: {
      targetId: target.id,
      statusCode: result.statusCode ?? null,
      responseTimeMs: result.responseTimeMs ?? null,
      outcome: result.outcome,
      errorClass: result.errorClass ?? null,
      redirectedTo: result.redirectedTo ?? null,
    },
  });

  // Serialize the state transition per target. Two checks for one target can
  // run concurrently (a scheduled check while a manual or retried one is in
  // flight); without the lock both would read the same consecutiveFailures
  // and write the same value, losing a real failure. The HTTP check and the
  // notifications stay outside the transaction (network and email must never
  // hold the advisory lock); the read-compute-write plus incident transition
  // happen atomically against fresh state.
  const transition = await withAdvisoryLock(`monitor:${target.id}`, async (tx) => {
    const fresh = await tx.monitoringTarget.findUnique({ where: { id: target.id } });
    if (!fresh) return null; // deleted while the check was running

    const failed = result.outcome !== "success";
    const consecutiveFailures = failed ? fresh.consecutiveFailures + 1 : 0;
    const wasDownOrDegraded = fresh.currentState === "down" || fresh.currentState === "degraded";

    let currentState = fresh.currentState;
    if (failed && consecutiveFailures >= fresh.failureThreshold) currentState = "down";
    else if (failed) currentState = "degraded";
    else if (!failed) currentState = "healthy";

    await tx.monitoringTarget.update({
      where: { id: fresh.id },
      data: {
        consecutiveFailures,
        currentState,
        lastCheckedAt: new Date(),
        lastSuccessAt: failed ? fresh.lastSuccessAt : new Date(),
        lastFailureAt: failed ? new Date() : fresh.lastFailureAt,
      },
    });

    // Incidents: open on threshold breach, resolve after configured consecutive successes.
    const fingerprint = `monitor:${fresh.projectId}:${fresh.id}`;
    const openIncident = await tx.incident.findFirst({
      where: { projectId: fresh.projectId, fingerprint, status: { in: ["open", "investigating", "identified"] } },
    });

    let openedIncidentId: string | null = null;
    let resolvedIncidentId: string | null = null;

    if (currentState === "down" && !openIncident) {
      // The (projectId, fingerprint) pair is unique: a previously resolved/closed
      // incident for this target must be reopened — creating a new row would hit
      // the unique constraint and break this target's alerting forever.
      const prior = await tx.incident.findUnique({
        where: { projectId_fingerprint: { projectId: fresh.projectId, fingerprint } },
      });
      let incident;
      if (prior && prior.status !== "open" && prior.status !== "investigating" && prior.status !== "identified") {
        incident = await tx.incident.update({
          where: { id: prior.id },
          data: {
            status: "open",
            resolvedAt: null,
            resolutionNotes: null,
            evidence: JSON.stringify([{ kind: "monitoring_check", target: fresh.name, url: fresh.url, outcome: result.outcome, errorClass: result.errorClass }]),
            events: { create: { actor: "system", type: "reopened", note: `${fresh.failureThreshold} consecutive failed checks (${result.errorClass ?? result.outcome}).` } },
          },
        });
      } else if (prior) {
        // Open under another status label (race with the lookup above): nothing to do.
        incident = prior;
      } else {
        try {
          incident = await tx.incident.create({
            data: {
              projectId: fresh.projectId,
              title: `Monitoring target down: ${fresh.name}`,
              severity: "high",
              status: "open",
              sourceType: "monitoring",
              fingerprint,
              evidence: JSON.stringify([{ kind: "monitoring_check", target: fresh.name, url: fresh.url, outcome: result.outcome, errorClass: result.errorClass }]),
              events: { create: { actor: "system", type: "opened", note: `${fresh.failureThreshold} consecutive failed checks (${result.errorClass ?? result.outcome}).` } },
            },
          });
        } catch (err) {
          // A concurrent check opened it first; treat that as the open incident.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
          incident = await tx.incident.findUniqueOrThrow({
            where: { projectId_fingerprint: { projectId: fresh.projectId, fingerprint } },
          });
        }
      }
      openedIncidentId = incident.id;
    }

    if (!failed && openIncident && wasDownOrDegraded) {
      // Resolve only with evidence: this success plus the recorded prior failures.
      await tx.incident.update({
        where: { id: openIncident.id },
        data: {
          status: "resolved",
          resolvedAt: new Date(),
          resolutionNotes: "Auto-resolved: a successful check completed after the recorded failures (rule: resolve after N consecutive successful checks, N=1).",
        },
      });
      await tx.incidentEvent.create({
        data: { incidentId: openIncident.id, actor: "system", type: "resolved", note: "Resolved by successful check evidence." },
      });
      resolvedIncidentId = openIncident.id;
    }

    return { openedIncidentId, resolvedIncidentId };
  });

  if (transition?.openedIncidentId) {
    await notify({
      projectId: target.projectId,
      type: "incident_opened",
      title: `Monitoring target down: ${target.name}`,
      body: `${target.url} failed ${target.failureThreshold} consecutive checks.`,
      entityRef: `incident:${transition.openedIncidentId}`,
      dedupKey: `incident_opened:${target.id}:${Date.now() - (Date.now() % 3600_000)}`,
    });
    await notify({
      projectId: target.projectId,
      type: "monitoring_down",
      title: `Target down: ${target.name}`,
      body: `${target.url} is down (${result.errorClass ?? result.outcome}).`,
      entityRef: `monitoring_target:${target.id}`,
      // The key must change per downtime episode: a static key is burned by the
      // first outage (dedupKey is unique forever) and every later outage of the
      // same target would be silently suppressed. Hour-bucketed like the other
      // alert keys: retries within the hour dedup, a new episode re-alerts.
      dedupKey: `monitoring_down:${target.id}:${Date.now() - (Date.now() % 3600_000)}`,
    });
  }

  if (transition?.resolvedIncidentId) {
    await notify({
      projectId: target.projectId,
      type: "monitoring_recovered",
      title: `Target recovered: ${target.name}`,
      body: `${target.url} responded successfully; the open incident was resolved.`,
      entityRef: `monitoring_target:${target.id}`,
      dedupKey: `monitoring_recovered:${target.id}:${Date.now() - (Date.now() % 3600_000)}`,
    });
  }

  return result;
}

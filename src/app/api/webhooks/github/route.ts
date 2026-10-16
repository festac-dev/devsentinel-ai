import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { verifyGithubSignature, parsePrEvent, splitFullName } from "@/modules/github/webhook";
import { handlePrEvent } from "@/modules/github/pipeline";
import { rateLimit } from "@/lib/ratelimit";

const MAX_BODY_BYTES = 1024 * 1024;

export const dynamic = "force-dynamic";

/**
 * Read the body without ever buffering more than maxBytes in memory. App
 * Router handlers have no built-in body cap on self-hosted deploys, so
 * `req.text()` alone would let an oversized stream allocate until the heap
 * dies. Returns null when the body exceeds the cap (or content-length does).
 */
async function readBodyCapped(req: NextRequest, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(req: NextRequest) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Honest boundary: without the secret we cannot verify anything.
    return NextResponse.json({ code: "not_configured", message: "GITHUB_WEBHOOK_SECRET is not set; webhook processing is disabled.", requestId: crypto.randomUUID() }, { status: 503 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return NextResponse.json({ code: "bad_content_type", message: "Expected application/json.", requestId: crypto.randomUUID() }, { status: 415 });
  }

  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === null) {
    return NextResponse.json({ code: "payload_too_large", message: "Webhook body exceeds 1 MB.", requestId: crypto.randomUUID() }, { status: 413 });
  }

  // Verify BEFORE parsing (spec 9.2 step 4) and BEFORE the rate limit: the
  // limiter writes to the database, so only signature-verified traffic (real
  // GitHub deliveries) may reach it — unauthenticated floods must not get
  // rate-limited, they must be rejected as cheaply as possible.
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyGithubSignature(raw, signature, secret)) {
    return NextResponse.json({ code: "invalid_signature", message: "Signature verification failed.", requestId: crypto.randomUUID() }, { status: 401 });
  }

  // The rightmost entry: proxies APPEND to X-Forwarded-For, so the leftmost
  // value is client-controlled and the rightmost was set by the trusted proxy.
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",").pop()!.trim() : "unknown";
  const rl = await rateLimit(`webhook:${ip}`, 60, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ code: "rate_limited", message: "Too many webhook deliveries.", requestId: crypto.randomUUID() }, { status: 429 });
  }

  const deliveryId = req.headers.get("x-github-delivery");
  const event = req.headers.get("x-github-event") ?? "unknown";
  if (!deliveryId) {
    return NextResponse.json({ code: "missing_delivery_id", message: "X-GitHub-Delivery header is required.", requestId: crypto.randomUUID() }, { status: 400 });
  }

  // Delivery-ID deduplication (spec 9.2 step 6 / 9.3).
  try {
    await prisma.webhookDelivery.create({ data: { deliveryId, event, status: "received" } });
  } catch (err) {
    // Only a delivery that was actually handled (or is being handled right now)
    // is acked as a duplicate. A delivery whose earlier processing FAILED
    // (status "error") must be reprocessed: GitHub redelivers the same
    // delivery id after a 5xx, and acking that redelivery as "duplicate" would
    // swallow the event forever while the 500 promised a retry.
    // Handlers are idempotent, so a reprocess cannot double-create runs.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;
    const existing = await prisma.webhookDelivery.findUnique({ where: { deliveryId }, select: { status: true } });
    if (!existing || existing.status !== "error") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  if (event !== "pull_request" && event !== "ping" && event !== "installation" && event !== "installation_repositories") {
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status: "ignored", processedAt: new Date(), error: `unhandled event: ${event}` } });
    return NextResponse.json({ ok: true, ignored: event });
  }

  if (event === "ping") {
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status: "processed", processedAt: new Date() } });
    return NextResponse.json({ ok: true });
  }

  // App lifecycle events: acknowledged by design (connections are managed in
  // the dashboard); answering 400 would mark the webhook as failing.
  if (event === "installation" || event === "installation_repositories") {
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status: "ignored", processedAt: new Date(), error: `acknowledged event: ${event}` } });
    return NextResponse.json({ ok: true, ignored: event });
  }

  const payload = parsePrEvent(raw);
  if (!payload) {
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status: "error", processedAt: new Date(), error: "unparseable pull_request payload" } });
    return NextResponse.json({ code: "bad_payload", message: "Payload did not match the expected event shape.", requestId: crypto.randomUUID() }, { status: 400 });
  }

  const split = splitFullName(payload.repository.full_name);
  const connection = split
    ? await prisma.repositoryConnection.findFirst({
        where: { owner: { equals: split.owner, mode: "insensitive" }, repo: { equals: split.repo, mode: "insensitive" } },
        select: { projectId: true },
      })
    : null;

  try {
    const result = await handlePrEvent(payload, deliveryId);
    await prisma.webhookDelivery.update({
      where: { deliveryId },
      data: { status: "processed", processedAt: new Date(), projectId: connection?.projectId ?? null, error: result.processed.startsWith("ignored") ? result.processed : null },
    });
    return NextResponse.json({ ok: true, result: result.processed });
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 300);
    await prisma.webhookDelivery.update({ where: { deliveryId }, data: { status: "error", processedAt: new Date(), error: message } });
    // GitHub redelivers the same delivery id after a 5xx; the dedup branch
    // above reprocesses deliveries whose status is "error", so the retry
    // actually reaches the handler (idempotent) instead of being dup-acked.
    return NextResponse.json({ code: "processing_failed", message: "Event could not be processed; it will be retried.", requestId: crypto.randomUUID() }, { status: 500 });
  }
}

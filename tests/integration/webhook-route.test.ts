/**
 * Webhook route contract against the real schema: delivery-id deduplication
 * must ack a genuinely handled redelivery as a duplicate, but a delivery
 * whose earlier processing FAILED must be reprocessed — GitHub redelivers
 * with the same X-GitHub-Delivery id after a 5xx, and acking that redelivery
 * as a duplicate would swallow the event forever.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { prepareTestDatabase } from "./helpers/testdb";

type Db = typeof import("@/lib/db");
type Route = typeof import("@/app/api/webhooks/github/route");

let db: Db;
let route: Route;

const SECRET = "whsec_integration_test";

const pingBody = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });

function signedRequest(deliveryId: string, body: string) {
  const signature = "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  return new NextRequest("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-delivery": deliveryId,
      "x-github-event": "ping",
    },
    body,
  });
}

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  prepareTestDatabase();
  db = await import("@/lib/db");
  route = await import("@/app/api/webhooks/github/route");
});

afterAll(async () => {
  await db?.prisma?.$disconnect();
});

describe("webhook delivery deduplication", () => {
  it("processes a fresh delivery and records it", async () => {
    const res = await route.POST(signedRequest(`wd-fresh-${Date.now()}`, pingBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined();
  });

  it("acks a redelivery of a handled delivery as a duplicate", async () => {
    const id = `wd-dup-${Date.now()}`;
    const first = await route.POST(signedRequest(id, pingBody));
    expect(first.status).toBe(200);
    const second = await route.POST(signedRequest(id, pingBody));
    const body = await second.json();
    expect(body.duplicate).toBe(true);
    const row = await db.prisma.webhookDelivery.findUnique({ where: { deliveryId: id } });
    expect(row?.status).toBe("processed");
  });

  it("REPROCESSES a redelivery whose earlier processing failed instead of dup-acking it", async () => {
    // Simulate the record left by a first attempt that returned 500.
    const id = `wd-err-${Date.now()}`;
    await db.prisma.webhookDelivery.create({ data: { deliveryId: id, event: "ping", status: "error" } });
    const res = await route.POST(signedRequest(id, pingBody));
    const body = await res.json();
    expect(body.duplicate).toBeUndefined();
    expect(body.ok).toBe(true);
    const row = await db.prisma.webhookDelivery.findUnique({ where: { deliveryId: id } });
    expect(row?.status).toBe("processed");
  });

  it("rejects a body over the 1 MB cap", async () => {
    const id = `wd-big-${Date.now()}`;
    const huge = "x".repeat(1024 * 1024 + 1);
    const signature = "sha256=" + createHmac("sha256", SECRET).update(huge, "utf8").digest("hex");
    const res = await route.POST(
      new NextRequest("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-delivery": id,
          "x-github-event": "ping",
        },
        body: huge,
      })
    );
    expect(res.status).toBe(413);
    const row = await db.prisma.webhookDelivery.findUnique({ where: { deliveryId: id } });
    expect(row).toBeNull(); // rejected before any dedup write
  });
});

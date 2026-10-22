import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { log } from "@/lib/logger";
import { getDeliverySnapshot } from "@/modules/delivery/service";
import { buildDeliveryReport, sourceRevisionFromEnv } from "@/modules/delivery/model";

export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ code, message, requestId: randomUUID() }, { status });
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return errorResponse(401, "unauthenticated", "Sign in to generate the delivery report.");

  const rl = await rateLimit(`delivery-report-download:${user.id}`, 20, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { code: "rate_limited", message: `Rate limited. Try again in ${rl.retryAfterSec}s.`, requestId: randomUUID() },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  try {
    const snapshot = await getDeliverySnapshot(user.id);
    const generatedAt = new Date();
    const report = buildDeliveryReport(snapshot, {
      generatedAt,
      sourceRevision: sourceRevisionFromEnv(),
    });
    const day = generatedAt.toISOString().slice(0, 10);
    return new NextResponse(report, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="devsentinel-delivery-report-${day}.md"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    log.error("delivery_report_download_failed", {
      userId: user.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return errorResponse(500, "report_generation_failed", "The report could not be generated from the current records.");
  }
}

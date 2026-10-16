import { prisma } from "@/lib/db";
import { redact } from "@/lib/redact";

export async function audit(input: {
  userId?: string | null;
  projectId?: string | null;
  action: string;
  detail?: Record<string, unknown> | string;
  ip?: string | null;
}) {
  const detail =
    typeof input.detail === "string"
      ? input.detail
      : input.detail
        ? redact(JSON.stringify(input.detail))
        : null;
  await prisma.auditEvent.create({
    data: {
      userId: input.userId ?? null,
      projectId: input.projectId ?? null,
      action: input.action,
      detail,
      ip: input.ip ?? null,
    },
  });
}

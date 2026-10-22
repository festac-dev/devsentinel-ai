"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser, clientIp } from "@/lib/auth";
import { csrfFromForm, CSRF_BLOCKED_MESSAGE } from "@/lib/csrf";
import { rateLimit } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import {
  addDeliveryEvidence,
  reviewDeliveryEvidence,
  updateDeliveryTaskNotes,
  updateDeliveryTaskStatus,
} from "@/modules/delivery/service";
import { EVIDENCE_TYPES, TASK_STATUSES } from "@/modules/delivery/model";
import type { ActionState } from "@/app/actions/auth";

const TaskId = z.string().trim().min(1).max(100);

const StatusSchema = z.object({
  taskId: TaskId,
  status: z.enum(TASK_STATUSES),
  reason: z.string().max(1000).optional(),
});

const NotesSchema = z.object({
  taskId: TaskId,
  notes: z.string().max(2000),
});

const EvidenceSchema = z.object({
  taskId: TaskId,
  evidenceType: z.enum(EVIDENCE_TYPES),
  title: z.string().trim().min(1).max(200),
  referenceUrl: z.string().max(2000).optional(),
  artifactReference: z.string().max(300).optional(),
  sourceCommitSha: z.string().max(64).optional(),
  notes: z.string().max(2000).optional(),
  sourceRecordRef: z.string().max(200).optional(),
});

const ReviewSchema = z.object({
  evidenceId: z.string().trim().min(1).max(100),
  decision: z.enum(["verify", "reject"]),
  note: z.string().max(1000).optional(),
});

function formString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function revalidateDelivery(): void {
  revalidatePath("/app/delivery", "layout");
}

export async function updateDeliveryTaskStatusAction(
  _prev: ActionState,
  form: FormData
): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };

  const parsed = StatusSchema.safeParse({
    taskId: formString(form, "taskId"),
    status: formString(form, "status"),
    reason: formString(form, "reason"),
  });
  if (!parsed.success) return { error: "Invalid status update." };

  const rl = await rateLimit(`delivery-status:${user.id}`, 30, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };

  const result = await updateDeliveryTaskStatus({
    userId: user.id,
    taskId: parsed.data.taskId,
    status: parsed.data.status,
    reason: parsed.data.reason,
  });
  if (!result.ok) return { error: result.error };

  await audit({
    userId: user.id,
    action: "delivery_task_status_changed",
    detail: { taskId: parsed.data.taskId, status: parsed.data.status },
    ip: await clientIp(),
  });
  revalidateDelivery();
  return { success: result.message };
}

export async function updateDeliveryTaskNotesAction(
  _prev: ActionState,
  form: FormData
): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };

  const parsed = NotesSchema.safeParse({
    taskId: formString(form, "taskId"),
    notes: formString(form, "notes") ?? "",
  });
  if (!parsed.success) return { error: "Completion notes must be 2,000 characters or fewer." };

  const rl = await rateLimit(`delivery-notes:${user.id}`, 30, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };

  const result = await updateDeliveryTaskNotes({
    userId: user.id,
    taskId: parsed.data.taskId,
    notes: parsed.data.notes,
  });
  if (!result.ok) return { error: result.error };

  await audit({
    userId: user.id,
    action: "delivery_task_notes_updated",
    detail: { taskId: parsed.data.taskId },
    ip: await clientIp(),
  });
  revalidateDelivery();
  return { success: result.message };
}

export async function addDeliveryEvidenceAction(
  _prev: ActionState,
  form: FormData
): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };

  const parsed = EvidenceSchema.safeParse({
    taskId: formString(form, "taskId"),
    evidenceType: formString(form, "evidenceType"),
    title: formString(form, "title"),
    referenceUrl: formString(form, "referenceUrl"),
    artifactReference: formString(form, "artifactReference"),
    sourceCommitSha: formString(form, "sourceCommitSha"),
    notes: formString(form, "notes"),
    sourceRecordRef: formString(form, "sourceRecordRef"),
  });
  if (!parsed.success) return { error: "Invalid evidence fields." };

  const rl = await rateLimit(`delivery-evidence:${user.id}`, 20, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };

  const result = await addDeliveryEvidence({
    userId: user.id,
    taskId: parsed.data.taskId,
    evidenceType: parsed.data.evidenceType,
    title: parsed.data.title,
    referenceUrl: parsed.data.referenceUrl,
    artifactReference: parsed.data.artifactReference,
    sourceCommitSha: parsed.data.sourceCommitSha,
    notes: parsed.data.notes,
    sourceRecordRef: parsed.data.sourceRecordRef,
  });
  if (!result.ok) return { error: result.error };

  await audit({
    userId: user.id,
    action: "delivery_evidence_added",
    detail: { taskId: parsed.data.taskId, evidenceType: parsed.data.evidenceType },
    ip: await clientIp(),
  });
  revalidateDelivery();
  return { success: result.message };
}

export async function reviewDeliveryEvidenceAction(
  _prev: ActionState,
  form: FormData
): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const user = await getSessionUser();
  if (!user) return { error: "Not signed in." };

  const parsed = ReviewSchema.safeParse({
    evidenceId: formString(form, "evidenceId"),
    decision: formString(form, "decision"),
    note: formString(form, "note"),
  });
  if (!parsed.success) return { error: "Invalid evidence review." };

  const rl = await rateLimit(`delivery-review:${user.id}`, 20, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };

  const result = await reviewDeliveryEvidence({
    userId: user.id,
    evidenceId: parsed.data.evidenceId,
    decision: parsed.data.decision,
    note: parsed.data.note,
  });
  if (!result.ok) return { error: result.error };

  await audit({
    userId: user.id,
    action: "delivery_evidence_reviewed",
    detail: { evidenceId: parsed.data.evidenceId, decision: parsed.data.decision },
    ip: await clientIp(),
  });
  revalidateDelivery();
  return { success: result.message };
}

import { Badge } from "@/components/ui";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Reported complete",
  blocked: "Blocked",
};

const STATUS_TOOLTIPS: Record<string, string> = {
  pending: "This task has not been started.",
  in_progress: "Work is in progress.",
  completed: "Reported complete. This is not evidence verification; check the verification badge.",
  blocked: "Work is blocked; see the task notes.",
};

const VERIFICATION_LABELS: Record<string, string> = {
  unverified: "Unverified",
  pending_review: "Verification pending",
  verified: "Evidence verified",
  rejected: "Evidence rejected",
};

const VERIFICATION_TOOLTIPS: Record<string, string> = {
  unverified: "No evidence has been accepted for this task. Reported completion alone is not verification.",
  pending_review: "Evidence is attached but no authorized review has accepted it yet.",
  verified: "Evidence was accepted by an explicit authorized review recorded in the audit history.",
  rejected: "Evidence was reviewed and rejected. The task is not verified by the rejected record.",
};

export function TaskStatusBadge({ status }: { status: string }) {
  return (
    <Badge status={status} tooltip={STATUS_TOOLTIPS[status]}>
      {STATUS_LABELS[status] ?? status.replace(/_/g, " ")}
    </Badge>
  );
}

export function VerificationBadge({ status }: { status: string }) {
  return (
    <Badge status={status} tooltip={VERIFICATION_TOOLTIPS[status]}>
      {VERIFICATION_LABELS[status] ?? status.replace(/_/g, " ")}
    </Badge>
  );
}

export function ReadinessBadge({ ready }: { ready: boolean }) {
  return (
    <Badge status={ready ? "ready" : "not_ready"}>
      {ready ? "Submission-ready" : "Not submission-ready"}
    </Badge>
  );
}

export function humanizeAction(action: string): string {
  return action.replace(/_/g, " ");
}

export function humanizeEvidenceType(type: string): string {
  return type.replace(/_/g, " ");
}

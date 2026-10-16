"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions/auth";
import type { ReactNode } from "react";

export function FormShell({
  action,
  submitLabel,
  children,
  className = "",
  danger = false,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  submitLabel: string;
  children?: ReactNode;
  className?: string;
  danger?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={`space-y-3 ${className}`}>
      {children}
      {state?.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{state.error}</p>}
      {state?.success && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{state.success}</p>}
      <SubmitButton label={submitLabel} danger={danger} />
    </form>
  );
}

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const cls = danger
    ? "bg-rose-700 text-white hover:bg-rose-600"
    : "bg-slate-900 text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200";
  return (
    <button type="submit" disabled={pending}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${cls}`}>
      {pending ? "Working…" : label}
    </button>
  );
}

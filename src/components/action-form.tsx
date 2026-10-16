"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/app/actions/auth";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function ActionForm({
  action,
  submitLabel,
  fields,
  hidden,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  submitLabel: string;
  fields: Array<{ name: string; label: string; type?: string; required?: boolean; placeholder?: string; autoComplete?: string }>;
  hidden?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  return (
    <form action={formAction} className="space-y-4">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {fields.map((f) => {
        const isPassword = f.type === "password";
        const show = revealed[f.name] ?? false;
        return (
          <div key={f.name}>
            <label htmlFor={f.name} className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              {f.label}
            </label>
            <div className="relative">
              <input
                id={f.name}
                name={f.name}
                type={isPassword ? (show ? "text" : "password") : (f.type ?? "text")}
                required={f.required}
                placeholder={f.placeholder}
                autoComplete={f.autoComplete}
                className={`w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${isPassword ? "pr-16" : ""}`}
              />
              {isPassword && (
                <button
                  type="button"
                  onClick={() => setRevealed((r) => ({ ...r, [f.name]: !show }))}
                  aria-pressed={show}
                  aria-label={show ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center rounded-r-md px-3 text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                >
                  {show ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {state?.error && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.success}
        </p>
      )}
      <SubmitButton label={submitLabel} />
    </form>
  );
}

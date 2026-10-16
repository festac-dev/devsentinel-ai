"use client";

import { useFormStatus } from "react-dom";

/** Submit button that shows progress while its parent form's server action runs. */
export function PendingButton({ label, pendingLabel, className = "" }: { label: string; pendingLabel: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`disabled:opacity-60 ${className}`}>
      {pending ? pendingLabel : label}
    </button>
  );
}

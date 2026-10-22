"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { addDeliveryEvidenceAction } from "@/app/actions/delivery";
import type { ActionState } from "@/app/actions/auth";

export type EvidenceTypeOption = {
  value: string;
  label: string;
  hint: string;
  sourceType: "test_run" | "monitoring_check" | "incident" | "pull_request" | null;
  sourceRequired: boolean;
};

export type EvidenceSourceOption = {
  value: string;
  label: string;
  type: "test_run" | "monitoring_check" | "incident" | "pull_request";
};

const inputCls =
  "w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {pending ? "Attaching…" : "Attach evidence for review"}
    </button>
  );
}

export function EvidenceForm({
  taskId,
  types,
  sources,
}: {
  taskId: string;
  types: EvidenceTypeOption[];
  sources: EvidenceSourceOption[];
}) {
  const [state, action] = useActionState(addDeliveryEvidenceAction, null as ActionState);
  const [type, setType] = useState(types[0]?.value ?? "");
  const selected = types.find((item) => item.value === type) ?? types[0];
  const applicableSources = selected?.sourceType
    ? sources.filter((source) => source.type === selected.sourceType)
    : [];

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="taskId" value={taskId} />

      <div>
        <label htmlFor="evidenceType" className="mb-1 block text-sm font-medium">
          Evidence type
        </label>
        <select
          id="evidenceType"
          name="evidenceType"
          value={type}
          onChange={(event) => setType(event.target.value)}
          className={`${inputCls} max-w-lg`}
        >
          {types.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {selected && (
          <p className="mt-1 max-w-2xl text-xs text-slate-500 dark:text-slate-400">{selected.hint}</p>
        )}
      </div>

      <div>
        <label htmlFor="evidence-title" className="mb-1 block text-sm font-medium">
          Title
        </label>
        <input
          id="evidence-title"
          name="title"
          required
          maxLength={200}
          placeholder="Short, specific description of what this proves"
          className={inputCls}
        />
      </div>

      {selected?.sourceType && (
        <div>
          <label htmlFor="sourceRecordRef" className="mb-1 block text-sm font-medium">
            Linked record{" "}
            <span className="font-normal text-slate-500 dark:text-slate-400">
              ({selected.sourceRequired ? "required" : "optional"})
            </span>
          </label>
          <select
            id="sourceRecordRef"
            name="sourceRecordRef"
            required={selected.sourceRequired}
            className={`${inputCls} max-w-2xl`}
            defaultValue=""
          >
            <option value="">
              {selected.sourceRequired ? "Select an existing record…" : "No linked record"}
            </option>
            {applicableSources.map((source) => (
              <option key={source.value} value={source.value}>
                {source.label}
              </option>
            ))}
          </select>
          {applicableSources.length === 0 && selected.sourceRequired && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              No matching {selected.sourceType.replace(/_/g, " ")} record exists in this account yet. Create a real
              record first; the tracker will not invent one.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="referenceUrl" className="mb-1 block text-sm font-medium">
            External reference URL <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </label>
          <input
            id="referenceUrl"
            name="referenceUrl"
            type="url"
            placeholder="https://github.com/owner/repo/pull/12"
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor="sourceCommitSha" className="mb-1 block text-sm font-medium">
            Tested commit SHA <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
          </label>
          <input
            id="sourceCommitSha"
            name="sourceCommitSha"
            maxLength={40}
            pattern="[0-9a-fA-F]{40}"
            placeholder="40-character commit SHA"
            className={`${inputCls} font-mono`}
          />
        </div>
      </div>

      <div>
        <label htmlFor="artifactReference" className="mb-1 block text-sm font-medium">
          Repository-relative artifact <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
        </label>
        <input
          id="artifactReference"
          name="artifactReference"
          maxLength={300}
          placeholder="docs/evidence/build-report.txt"
          className={`${inputCls} font-mono`}
        />
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Absolute paths, traversal, and URLs are rejected. Do not include secrets.
        </p>
      </div>

      <div>
        <label htmlFor="evidence-notes" className="mb-1 block text-sm font-medium">
          Review note / observed result
        </label>
        <textarea
          id="evidence-notes"
          name="notes"
          rows={3}
          maxLength={2000}
          placeholder="For external checks: the observed conclusion, scope, method, date, and reviewer. Never paste secrets."
          className={inputCls}
        />
      </div>

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
      <SubmitButton />
    </form>
  );
}

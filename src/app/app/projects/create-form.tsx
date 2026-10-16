"use client";

import { useActionState } from "react";
import { createProjectAction } from "@/app/actions/projects";

export function ProjectCreateForm() {
  const [state, action] = useActionState(createProjectAction, null);
  return (
    <form action={action} className="rounded-lg border border-slate-200 dark:border-slate-800 p-5 space-y-3">
      <h2 className="font-semibold">Create a project</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="name" required maxLength={100} placeholder="Project name" aria-label="Project name"
          className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
        <input name="description" maxLength={500} placeholder="Description (optional)" aria-label="Project description"
          className="rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500" />
      </div>
      {state?.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{state.error}</p>}
      <button type="submit" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
        Create project
      </button>
    </form>
  );
}

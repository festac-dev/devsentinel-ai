"use client";

import { FormShell } from "@/components/form-shell";
import { connectRepoFromListAction } from "@/app/actions/projects";
import type { AvailableRepo } from "@/modules/github/install";

export function RepoPicker({ projectId, repos }: { projectId: string; repos: AvailableRepo[] }) {
  return (
    <FormShell action={connectRepoFromListAction} submitLabel="Connect repository">
      <input type="hidden" name="projectId" value={projectId} />
      <label htmlFor="selected" className="block text-sm font-medium mb-1">
        Repository <span className="font-normal text-slate-500 dark:text-slate-400">(from your installed GitHub App)</span>
      </label>
      <select
        id="selected"
        name="selected"
        required
        defaultValue=""
        className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        <option value="" disabled>
          Select a repository…
        </option>
        {repos.map((r) => (
          <option key={`${r.owner}/${r.repo}`} value={JSON.stringify({ owner: r.owner, repo: r.repo, defaultBranch: r.defaultBranch })}>
            {r.owner}/{r.repo}
            {r.private ? " (private)" : ""}
          </option>
        ))}
      </select>
    </FormShell>
  );
}

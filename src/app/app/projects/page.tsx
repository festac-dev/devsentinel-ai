import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { EmptyState } from "@/components/ui";
import { ProjectCreateForm } from "./create-form";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await requireUser();
  const projects = await prisma.project.findMany({
    where: { ownerId: user.id },
    include: { repository: true, _count: { select: { pullRequests: true, testRuns: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-slate-500 dark:text-slate-400">A project groups a repository connection, TestSprite configuration, runs, and monitoring.</p>
      </div>

      <ProjectCreateForm />

      <section>
        {projects.length === 0 ? (
          <EmptyState title="No projects yet">Create your first project above, then connect a GitHub repository.</EmptyState>
        ) : (
          <div className="space-y-2">
            {projects.map((p) => (
              <Link key={p.id} href={`/app/projects/${p.id}`} className="block rounded-lg border border-slate-200 dark:border-slate-800 p-4 hover:bg-slate-50 dark:hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
                <p className="font-medium">{p.name}</p>
                {p.description && <p className="text-sm text-slate-500 dark:text-slate-400">{p.description}</p>}
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {p.repository ? `Repo: ${p.repository.owner}/${p.repository.repo}` : "No repository connected"} · {p._count.pullRequests} PRs · {p._count.testRuns} runs
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

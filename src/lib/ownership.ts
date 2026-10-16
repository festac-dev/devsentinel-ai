import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Centralized server-side authorization (spec 16): 404, never 403. */
export async function requireProjectAccess(projectId: string) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
  if (!project) notFound();
  return { user, project };
}

export async function requireOwnedRun(runId: string) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const run = await prisma.testRun.findFirst({
    where: { id: runId, project: { ownerId: user.id } },
    include: { pr: true, project: true },
  });
  if (!run) notFound();
  return run;
}

export async function requireOwnedIncident(incidentId: string) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const incident = await prisma.incident.findFirst({
    where: { id: incidentId, project: { ownerId: user.id } },
    include: { project: true },
  });
  if (!incident) notFound();
  return incident;
}

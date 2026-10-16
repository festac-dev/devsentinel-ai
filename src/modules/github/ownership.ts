import { prisma } from "@/lib/db";

/** GitHub App installations this DevSentinel user has proven access to (via GitHub sign-in). */
export async function ownedInstallationIds(userId: string): Promise<string[]> {
  const rows = await prisma.githubInstallation.findMany({ where: { userId }, select: { installationId: true } });
  return rows.map((r) => r.installationId);
}

/** True when a different account already has owner/repo connected (case-insensitive). */
export async function repoClaimedByOtherUser(owner: string, repo: string, userId: string): Promise<boolean> {
  const hit = await prisma.repositoryConnection.findFirst({
    where: {
      owner: { equals: owner, mode: "insensitive" },
      repo: { equals: repo, mode: "insensitive" },
      project: { ownerId: { not: userId } },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

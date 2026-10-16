import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildAuthorizeUrl, buildInstallUrl, githubConnectEnabled } from "@/modules/github/install";

export const dynamic = "force-dynamic";

function appUrl(req: NextRequest, path: string): URL {
  return new URL(path, process.env.APP_BASE_URL || req.nextUrl.origin);
}

/**
 * Starts the GitHub connection for a project the signed-in user owns.
 * Default: GitHub sign-in (proves which installations this user can access).
 * `?mode=install`: go straight to the App's install page (e.g. to add another account).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(appUrl(req, "/login"));

  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: user.id } });
  if (!project) return NextResponse.redirect(appUrl(req, "/app"));

  const back = `/app/projects/${project.id}`;
  if (!githubConnectEnabled()) return NextResponse.redirect(appUrl(req, `${back}?github=not_available`));

  if (req.nextUrl.searchParams.get("mode") === "install") {
    return NextResponse.redirect(buildInstallUrl({ projectId: project.id, userId: user.id }));
  }
  const redirectUri = appUrl(req, "/api/github/callback").toString();
  return NextResponse.redirect(buildAuthorizeUrl({ projectId: project.id, userId: user.id }, redirectUri));
}

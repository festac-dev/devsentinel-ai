import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  buildAuthorizeUrl, buildInstallUrl, exchangeUserCode, findRepoInstallation,
  githubConnectEnabled, listUserInstallations, verifyInstallState,
} from "@/modules/github/install";

export const dynamic = "force-dynamic";

function appUrl(req: NextRequest, path: string): URL {
  return new URL(path, process.env.APP_BASE_URL || req.nextUrl.origin);
}

/**
 * GitHub App callback (set it as the App's "Callback URL"; also fine as the Setup URL).
 *  - With `code`: GitHub sign-in finished. Record the installations this user can access.
 *  - Without `code` (plain post-install redirect): bounce through GitHub sign-in first,
 *    because an `installation_id` in a URL proves nothing about who is asking.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(appUrl(req, "/login"));

  const params = req.nextUrl.searchParams;
  const state = verifyInstallState(params.get("state") ?? "");
  if (!state || state.userId !== user.id) return NextResponse.redirect(appUrl(req, "/app?github=invalid_state"));

  const project = await prisma.project.findFirst({ where: { id: state.projectId, ownerId: user.id }, include: { repository: true } });
  if (!project) return NextResponse.redirect(appUrl(req, "/app?github=invalid_state"));
  const back = (status: string) => NextResponse.redirect(appUrl(req, `/app/projects/${project.id}?github=${status}`));

  if (!githubConnectEnabled()) return back("not_available");

  // Organization installs that need an owner's approval come back without an installation id.
  if (params.get("setup_action") === "request") return back("pending");
  // The user declined GitHub sign-in (or GitHub reported an error): stop, do not loop.
  if (params.get("error")) return back("error");

  const redirectUri = appUrl(req, "/api/github/callback").toString();
  const code = params.get("code");
  if (!code) {
    return NextResponse.redirect(buildAuthorizeUrl({ projectId: project.id, userId: user.id, installed: state.installed }, redirectUri));
  }

  const exchanged = await exchangeUserCode(code, redirectUri);
  if (!exchanged.ok) {
    await audit({ userId: user.id, projectId: project.id, action: "github_app_link_failed", detail: { step: "exchange", detail: exchanged.detail } });
    return back("error");
  }
  const listed = await listUserInstallations(exchanged.token);
  if (!listed.ok) {
    await audit({ userId: user.id, projectId: project.id, action: "github_app_link_failed", detail: { step: "list_installations", detail: listed.detail } });
    return back("error");
  }

  if (listed.installations.length === 0) {
    // Nothing installed yet for this GitHub user: send them to install the App once, then come back here.
    if (state.installed) return back("no_installation");
    return NextResponse.redirect(buildInstallUrl({ projectId: project.id, userId: user.id }));
  }

  for (const inst of listed.installations) {
    await prisma.githubInstallation.upsert({
      where: { userId_installationId: { userId: user.id, installationId: inst.id } },
      create: { userId: user.id, installationId: inst.id, accountLogin: inst.account },
      update: { accountLogin: inst.account },
    });
  }
  await audit({ userId: user.id, projectId: project.id, action: "github_account_linked", detail: { installations: listed.installations.map((i) => i.id) } });

  // A repository already connected by name can now be linked to the user's own installation.
  if (project.repository && !project.repository.installationId) {
    const { owner, repo } = project.repository;
    const found = await findRepoInstallation(owner, repo);
    if (found.ok && listed.installations.some((i) => i.id === found.installationId)) {
      await prisma.repositoryConnection.update({ where: { projectId: project.id }, data: { installationId: found.installationId } });
      await audit({ userId: user.id, projectId: project.id, action: "github_app_linked", detail: { owner, repo, installationId: found.installationId } });
      return back("connected");
    }
  }
  return back("linked");
}

"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireProjectAccess } from "@/lib/ownership";
import { csrfFromForm, CSRF_BLOCKED_MESSAGE } from "@/lib/csrf";
import { rateLimit } from "@/lib/ratelimit";
import { encryptSecret, last4 } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/auth";
import { enqueue } from "@/lib/queue";
import { validateMonitorUrl } from "@/modules/monitoring/ssrf";
import { findRepoInstallation, githubInstallEnabled, repoProofBypassedForTests, verifyTokenCanPush } from "@/modules/github/install";
import { ownedInstallationIds, repoClaimedByOtherUser } from "@/modules/github/ownership";
import type { ActionState } from "@/app/actions/auth";

const CreateProject = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

export async function createProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const parsed = CreateProject.safeParse({ name: form.get("name"), description: form.get("description") || undefined });
  if (!parsed.success) return { error: "Project name is required (max 100 characters)." };
  const owner = await (await import("@/lib/auth")).getSessionUser();
  if (!owner) redirect("/login");
  const project = await prisma.project.create({
    data: { name: parsed.data.name, description: parsed.data.description ?? null, ownerId: owner.id },
  });
  await audit({ userId: owner.id, projectId: project.id, action: "project_created" });
  redirect(`/app/projects/${project.id}`);
}

export async function updateProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  const planStepsRaw = String(form.get("testPlanSteps") ?? "").trim();
  let planSteps: string | null = null;
  if (planStepsRaw) {
    try {
      const lines = planStepsRaw.split("\n").map((l) => l.trim()).filter(Boolean);
      const steps = lines.map((line) => {
        const isAssertion = /^assert:/i.test(line);
        return { type: isAssertion ? "assertion" : "action", description: line.replace(/^(assert|action):/i, "").trim() };
      });
      if (steps.length === 0 || steps.length > 200) throw new Error("1-200 steps required");
      z.array(z.object({ type: z.enum(["action", "assertion"]), description: z.string().min(1) })).parse(steps);
      planSteps = JSON.stringify(steps);
    } catch {
      return { error: "Plan steps: one step per line, optionally prefixed with 'assert:'. 1–200 steps." };
    }
  }
  await prisma.project.update({
    where: { id: project.id },
    data: {
      name: String(form.get("name") ?? project.name).trim().slice(0, 100) || project.name,
      description: String(form.get("description") ?? "").trim().slice(0, 500) || null,
      testspriteProjectId: String(form.get("testspriteProjectId") ?? "").trim() || null,
      testTargetUrl: String(form.get("testTargetUrl") ?? "").trim() || null,
      testPlanSteps: planSteps,
      runOnPrOpened: form.get("runOnPrOpened") === "on",
      runOnPrSynchronize: form.get("runOnPrSynchronize") === "on",
      runOnPrReopened: form.get("runOnPrReopened") === "on",
      incidentOnRunFail: form.get("incidentOnRunFail") === "on",
    },
  });
  await audit({ userId: project.ownerId, projectId: project.id, action: "project_updated" });
  revalidatePath(`/app/projects/${project.id}`);
  return { success: "Project settings saved." };
}

export async function deleteProjectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  if (String(form.get("confirm") ?? "") !== project.name) {
    return { error: `Type the project name exactly ("${project.name}") to confirm deletion.` };
  }
  await prisma.project.delete({ where: { id: project.id } }); // cascades
  await audit({ userId: project.ownerId, projectId: project.id, action: "project_deleted" });
  redirect("/app/projects");
}

const NOT_YOURS = "That repository isn't available to your GitHub account. Use “Connect GitHub” and pick a repository from your own installation.";
const ALREADY_CLAIMED = "That repository is already connected to another DevSentinel account.";

export async function connectRepoAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { user, project } = await requireProjectAccess(projectId);
  const owner = String(form.get("owner") ?? "").trim();
  const repo = String(form.get("repo") ?? "").trim();
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { error: "Owner and repository names must be simple GitHub names (letters, digits, dots, dashes)." };
  }
  const githubToken = String(form.get("githubToken") ?? "").trim();
  if (await repoClaimedByOtherUser(owner, repo, user.id)) return { error: ALREADY_CLAIMED };

  // Prove this account can access the repository: either one of ITS OWN GitHub App installations
  // covers it, or the token it pasted has push access. Typing a name alone never links anything.
  let installationId: string | null = null;
  if (githubInstallEnabled()) {
    const found = await findRepoInstallation(owner, repo);
    if (found.ok && (await ownedInstallationIds(user.id)).includes(found.installationId)) installationId = found.installationId;
  }
  if (!installationId && !repoProofBypassedForTests()) {
    if (!githubToken) {
      return { error: "Connect your GitHub account first (“Connect GitHub” above), or paste a token that has push access to this repository." };
    }
    const proof = await verifyTokenCanPush(githubToken, owner, repo);
    if (!proof.ok) {
      return { error: proof.reason === "denied" ? `That token can't push to ${owner}/${repo}. Check the token and the repository name.` : "GitHub couldn't be reached to verify access. Please try again." };
    }
  }

  await prisma.repositoryConnection.upsert({
    where: { projectId: project.id },
    create: {
      projectId: project.id,
      owner,
      repo,
      defaultBranch: String(form.get("defaultBranch") ?? "main").trim() || "main",
      installationId,
    },
    update: { owner, repo, installationId, disabled: false, disabledReason: null },
  });
  if (githubToken) {
    const { cipher, keyVersion } = encryptSecret(githubToken);
    await prisma.projectIntegration.upsert({
      where: { projectId_kind: { projectId: project.id, kind: "github_token" } },
      create: { projectId: project.id, kind: "github_token", cipher, keyVersion, last4: last4(githubToken) },
      update: { cipher, keyVersion, last4: last4(githubToken), updatedAt: new Date() },
    });
  }
  await audit({ userId: project.ownerId, projectId: project.id, action: "repository_connected", detail: { owner, repo } });
  if (installationId) {
    await audit({ userId: project.ownerId, projectId: project.id, action: "github_app_linked", detail: { owner, repo, installationId, auto: true } });
  }
  revalidatePath(`/app/projects/${project.id}`);
  return { success: `Repository ${owner}/${repo} connected. Point your GitHub webhook at /api/webhooks/github.` };
}

export async function connectRepoFromListAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { user, project } = await requireProjectAccess(projectId);
  let picked: { owner?: unknown; repo?: unknown; defaultBranch?: unknown };
  try {
    picked = JSON.parse(String(form.get("selected") ?? "{}"));
  } catch {
    return { error: "Pick a repository from the list." };
  }
  const owner = String(picked.owner ?? "").trim();
  const repo = String(picked.repo ?? "").trim();
  const defaultBranch = String(picked.defaultBranch ?? "main").trim() || "main";
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { error: "Pick a repository from the list." };
  }
  // Never trust the client: ask GitHub which installation covers this repo, and require that it is
  // one this account proved access to. The client's own values are ignored.
  const found = await findRepoInstallation(owner, repo);
  if (!found.ok || !(await ownedInstallationIds(user.id)).includes(found.installationId)) return { error: NOT_YOURS };
  if (await repoClaimedByOtherUser(owner, repo, user.id)) return { error: ALREADY_CLAIMED };

  await prisma.repositoryConnection.upsert({
    where: { projectId: project.id },
    create: { projectId: project.id, owner, repo, defaultBranch, installationId: found.installationId },
    update: { owner, repo, defaultBranch, installationId: found.installationId, disabled: false, disabledReason: null },
  });
  await audit({ userId: project.ownerId, projectId: project.id, action: "repository_connected", detail: { owner, repo } });
  await audit({ userId: project.ownerId, projectId: project.id, action: "github_app_linked", detail: { owner, repo, installationId: found.installationId, auto: true } });
  revalidatePath(`/app/projects/${project.id}`);
  return { success: `Connected ${owner}/${repo} and linked your GitHub App installation.` };
}

export async function disconnectRepoAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  // The optional per-repository GitHub token goes with the connection, so a different repository
  // connected next never inherits (and fails with) the previous repository's token.
  await prisma.$transaction([
    prisma.repositoryConnection.deleteMany({ where: { projectId: project.id } }),
    prisma.projectIntegration.deleteMany({ where: { projectId: project.id, kind: "github_token" } }),
  ]);
  await audit({ userId: project.ownerId, projectId: project.id, action: "repository_disconnected" });
  // Without this the page keeps showing the old connection until a manual refresh.
  revalidatePath(`/app/projects/${project.id}`);
  revalidatePath("/app/integrations");
}

export async function saveTestspriteKeyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  const apiKey = String(form.get("apiKey") ?? "").trim();
  if (!apiKey) return { error: "Paste a TestSprite API key (from testsprite.com dashboard → Settings → API key)." };
  if (!process.env.ENCRYPTION_KEY) {
    return { error: "Server-side ENCRYPTION_KEY is not configured; credentials cannot be stored. See .env.example." };
  }
  const { cipher, keyVersion } = encryptSecret(apiKey);
  await prisma.projectIntegration.upsert({
    where: { projectId_kind: { projectId: project.id, kind: "testsprite" } },
    create: { projectId: project.id, kind: "testsprite", cipher, keyVersion, last4: last4(apiKey) },
    update: { cipher, keyVersion, last4: last4(apiKey), updatedAt: new Date() },
  });
  await audit({ userId: project.ownerId, projectId: project.id, action: "testsprite_credential_set" });
  revalidatePath(`/app/projects/${project.id}`);
  return { success: `TestSprite API key stored (encrypted, ends ${last4(apiKey)}). It is write-only: it cannot be viewed again.` };
}

export async function verifyTestspriteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  const rl = await rateLimit(`verify-tsprite:${project.id}`, 3, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };
  // The web role never spawns CLI processes (ADR-010): verification is
  // enqueued and the worker performs it, then notifies the owner with the
  // real result (testsprite_verify_result).
  await enqueue({ type: "verify_testsprite", payload: { projectId: project.id }, idempotencyKey: `verify:${project.id}:${Date.now()}` });
  return { success: "Checking with TestSprite… the result appears under the bell icon (top right) in a few seconds. If you have one TestSprite project, its ID is filled in for you." };
}

export async function runTestsForPrAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const prId = String(form.get("prId") ?? "");
  const pr = await prisma.pullRequest.findUnique({ where: { id: prId } });
  if (!pr) return;
  await requireProjectAccess(pr.projectId);
  const ip = await clientIp();
  const rl = await rateLimit(`manual-run:${pr.projectId}:${ip}`, 10, 60_000);
  if (!rl.ok) return;
  const run = await prisma.testRun.create({
    data: {
      projectId: pr.projectId,
      prId: pr.id,
      repoOwner: pr.repoOwner,
      repoName: pr.repoName,
      commitSha: pr.currentHeadSha,
      trigger: "manual",
      source: "testsprite",
      status: "queued",
    },
  });
  await enqueue({ type: "start_test_run", payload: { runId: run.id }, idempotencyKey: `manual:${run.id}` });
  redirect(`/app/runs/${run.id}`);
}

export async function retryRunAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const runId = String(form.get("runId") ?? "");
  const parent = await prisma.testRun.findUnique({ where: { id: runId } });
  if (!parent) return;
  await requireProjectAccess(parent.projectId);
  const ip = await clientIp();
  const rl = await rateLimit(`retry-run:${parent.projectId}:${ip}`, 10, 60_000);
  if (!rl.ok) return;
  const attempt = (await prisma.testRun.count({ where: { OR: [{ id: parent.id }, { parentRunId: parent.id }] } })) + 1;
  const run = await prisma.testRun.create({
    data: {
      projectId: parent.projectId,
      prId: parent.prId,
      repoOwner: parent.repoOwner,
      repoName: parent.repoName,
      commitSha: parent.commitSha,
      trigger: "retry",
      source: "testsprite",
      status: "queued",
      parentRunId: parent.id,
      attempt,
    },
  });
  await enqueue({ type: "start_test_run", payload: { runId: run.id }, idempotencyKey: `retry:${run.id}` });
  redirect(`/app/runs/${run.id}`);
}

export async function createMonitoringTargetAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await csrfFromForm(form))) return { error: CSRF_BLOCKED_MESSAGE };
  const projectId = String(form.get("projectId") ?? "");
  const { project } = await requireProjectAccess(projectId);
  const url = String(form.get("url") ?? "").trim();
  const validation = validateMonitorUrl(url);
  if (!validation.ok) return { error: `URL rejected: ${validation.error}` };
  const intervalMinutes = Number(form.get("intervalMinutes") ?? 5);
  const timeoutSeconds = Number(form.get("timeoutSeconds") ?? 10);
  const failureThreshold = Number(form.get("failureThreshold") ?? 3);
  if (![intervalMinutes, timeoutSeconds, failureThreshold].every(Number.isFinite)) {
    return { error: "Interval, timeout, and failure threshold must be numbers." };
  }
  const expectedStatus = Number(form.get("expectedStatus") ?? 200);
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    return { error: "Expected status must be an HTTP status code (100–599)." };
  }
  const rl = await rateLimit(`monitor-create:${project.id}`, 10, 60_000);
  if (!rl.ok) return { error: `Rate limited. Try again in ${rl.retryAfterSec}s.` };
  await prisma.monitoringTarget.create({
    data: {
      projectId: project.id,
      name: String(form.get("name") ?? "").trim().slice(0, 100) || validation.url.hostname,
      url,
      method: form.get("method") === "HEAD" ? "HEAD" : "GET",
      intervalMinutes: Math.min(Math.max(Math.floor(intervalMinutes), 1), 60),
      timeoutSeconds: Math.min(Math.max(Math.floor(timeoutSeconds), 1), 30),
      expectedStatus,
      expectedBody: String(form.get("expectedBody") ?? "").trim() || null,
      failureThreshold: Math.min(Math.max(Math.floor(failureThreshold), 1), 10),
    },
  });
  await audit({ userId: project.ownerId, projectId: project.id, action: "monitoring_target_created", detail: { url } });
  revalidatePath("/app/monitoring");
  return { success: "Target created. Status is Unknown until the first check completes." };
}

export async function deleteMonitoringTargetAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const targetId = String(form.get("targetId") ?? "");
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) return;
  await requireProjectAccess(target.projectId);
  await prisma.monitoringTarget.delete({ where: { id: targetId } });
  revalidatePath("/app/monitoring");
}

export async function runCheckNowAction(form: FormData) {
  if (!(await csrfFromForm(form))) return;
  const targetId = String(form.get("targetId") ?? "");
  const target = await prisma.monitoringTarget.findUnique({ where: { id: targetId } });
  if (!target) return;
  await requireProjectAccess(target.projectId);
  await enqueue({ type: "monitoring_check", payload: { targetId }, idempotencyKey: `manual-check:${targetId}:${Date.now()}`, maxAttempts: 1 });
  revalidatePath("/app/monitoring");
}
